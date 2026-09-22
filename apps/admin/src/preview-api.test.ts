import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPreviewGatewayAdminApi } from './preview-api'

function previewApi() {
  const api = createPreviewGatewayAdminApi()
  if (!api) throw new Error('Expected the synthetic preview API')
  return api
}

describe('Team preview', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
    window.history.replaceState(null, '', '/')
    window.sessionStorage.removeItem('ankka-gateway-ui-preview-scenario')
  })

  it('offers an explicit Cloudflare-managed read-only scenario with synthetic people', async () => {
    vi.stubEnv('VITE_GATEWAY_UI_PREVIEW', '1')
    window.history.replaceState(null, '', '/team?preview=team-readonly')
    expect(await createPreviewGatewayAdminApi()?.getTeam()).toEqual(expect.objectContaining({
      editingEnabled: false,
      editingDisabledReason: 'managed_in_cloudflare',
      managementCredentialConfigured: false,
      adminEmails: ['admin@example.com'],
    }))
  })

  it('does not enable the preview API without its development flag', () => {
    vi.stubEnv('VITE_GATEWAY_UI_PREVIEW', '')
    expect(createPreviewGatewayAdminApi()).toBeUndefined()
  })

  it('records pending connector consent without manufacturing completion or changing Team grants', async () => {
    vi.stubEnv('VITE_GATEWAY_UI_PREVIEW', '1')
    window.history.replaceState(null, '', '/sources?preview=ready')
    const api = previewApi()
    const saved = await api.getSources()
    const team = await api.getTeam()
    expect(saved.installationEnabled).toBe(true)
    const drafted = await api.saveSourceDraft(saved.revision, { label: 'New draft', url: 'https://new.example.com/mcp', authMode: 'none', enabledTools: ['search'] })
    const source = drafted.sources.find((candidate) => candidate.url === 'https://new.example.com/mcp')
    if (!source) throw new Error('Expected saved preview connector')
    const prepared = await api.prepareSourceAction(drafted.revision, source.id)
    expect(prepared.status).toBe('authorization_required')
    expect((await api.getSources()).sources.find((candidate) => candidate.id === source.id)?.status).toBe('draft')
    expect((await api.getSourceAction(prepared.actionId)).status).toBe('authorization_required')
    expect((await api.getSourceActions()).blockingAction).toEqual({ kind: 'source', actionId: prepared.actionId, sourceId: source.id })
    expect((await api.getTeam()).members).toEqual(team.members)
    expect((await api.getTeam()).editingEnabled).toBe(false)
  })

  it('rediscovers slow consent from the preview scenario after a fresh API instance', async () => {
    vi.stubEnv('VITE_GATEWAY_UI_PREVIEW', '1')
    window.history.replaceState(null, '', '/sources?preview=source-pending')
    const first = await previewApi().getSourceActions()
    window.history.replaceState(null, '', '/sources')
    const api = previewApi()
    expect((await api.getSourceActions()).blockingAction).toEqual(first.blockingAction)
    const sources = await api.getSources()
    await expect(api.prepareSourceAction(sources.revision, 'source-2222222222222222')).rejects.toMatchObject({
      code: 'source_action_conflict', reason: 'source_pending', action: first.blockingAction,
    })
    expect((await api.getSourceActions()).actions).toHaveLength(1)
  })

  it.each(['source-expired', 'source-recovery', 'source-applying'] as const)('keeps %s protected until the permitted recovery action', async (scenario) => {
    vi.stubEnv('VITE_GATEWAY_UI_PREVIEW', '1')
    window.history.replaceState(null, '', `/sources?preview=${scenario}`)
    const api = previewApi()
    const before = await api.getSources()
    const snapshot = await api.getSourceActions()
    const action = snapshot.actions[0]
    if (!action) throw new Error('Expected a recorded synthetic connector action')
    await expect(api.prepareSourceAction(before.revision, action.sourceId)).rejects.toMatchObject({ code: 'source_action_conflict' })
    expect(action.canCancel).toBe(scenario === 'source-expired')
    if (scenario === 'source-expired') {
      expect(action.state).toBe('authorization_expired')
      expect(await api.cancelSourceAction(action.actionId)).toMatchObject({ status: 'failed', failureCode: 'source_action_denied' })
      expect((await api.getSourceActions()).blockingAction).toBeNull()
      const next = await api.prepareSourceAction(before.revision, action.sourceId)
      expect(next.actionId).not.toBe(action.actionId)
    } else {
      await expect(api.cancelSourceAction(action.actionId)).rejects.toMatchObject({ code: 'source_action_conflict' })
      expect((await api.getSourceActions()).blockingAction).toEqual(snapshot.blockingAction)
    }
    expect(await api.getSources()).toEqual(before)
  })

  it('reconciles a synthetic late success into Installed while keeping Team grants unchanged', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z'))
    vi.stubEnv('VITE_GATEWAY_UI_PREVIEW', '1')
    window.history.replaceState(null, '', '/sources?preview=source-late-success')
    const api = previewApi()
    const team = await api.getTeam()
    const action = (await api.getSourceActions()).actions[0]
    if (!action) throw new Error('Expected a recorded synthetic connector action')
    expect(action.state).toBe('authorization_required')
    vi.advanceTimersByTime(15_000)
    expect((await api.getSourceActions()).actions[0]).toMatchObject({ state: 'succeeded', canCancel: false })
    expect((await api.getSources()).sources.find((source) => source.id === action.sourceId)?.status).toBe('installed')
    expect((await api.getSourceActions()).blockingAction).toBeNull()
    expect((await api.getTeam()).members).toEqual(team.members)
  })

  it('distinguishes a changed draft from an unrelated lifecycle conflict', async () => {
    vi.stubEnv('VITE_GATEWAY_UI_PREVIEW', '1')
    window.history.replaceState(null, '', '/sources?preview=source-lifecycle')
    const api = previewApi()
    const sources = await api.getSources()
    await expect(api.prepareSourceAction(sources.revision - 1, 'source-2222222222222222')).rejects.toMatchObject({ reason: 'draft_changed' })
    await expect(api.prepareSourceAction(sources.revision, 'source-2222222222222222')).rejects.toMatchObject({ reason: 'lifecycle_pending', action: { kind: 'runtime' } })
    expect((await api.getSourceActions()).actions).toEqual([])
  })

  it('retains an exact legacy recovery proposal while refusing gateway policy writes', async () => {
    vi.stubEnv('VITE_GATEWAY_UI_PREVIEW', '1')
    window.history.replaceState(null, '', '/team?preview=team-recovery')
    const api = previewApi()
    const saved = await api.getTeam()
    const pending = saved.pendingAction
    if (!pending) throw new Error('Expected a retained synthetic action')
    expect(pending.canCancel).toBe(false)
    if (!saved.proposedMembers) throw new Error('Expected a recorded synthetic proposal')
    await expect(api.prepareTeamAction(saved.revision, saved.proposedMembers)).rejects.toEqual(
      expect.objectContaining({ code: 'team_editing_managed_in_cloudflare' }),
    )
    expect(await api.getTeamAction(pending.actionId)).toEqual(expect.objectContaining({ status: 'recovery_required', canCancel: false }))
    await expect(api.cancelTeamAction(pending.actionId)).rejects.toThrow()
    expect(await api.getTeam()).toEqual(saved)
  })

  it('simulates canceling an unstarted recorded change without changing saved permissions', async () => {
    vi.stubEnv('VITE_GATEWAY_UI_PREVIEW', '1')
    window.history.replaceState(null, '', '/team?preview=team-legacy')
    const api = previewApi()
    const saved = await api.getTeam()
    if (!saved.pendingAction) throw new Error('Expected a retained legacy proposal')
    expect(await api.getTeamAction(saved.pendingAction.actionId)).toEqual(expect.objectContaining({ canCancel: true }))
    expect(await api.cancelTeamAction(saved.pendingAction.actionId)).toEqual(expect.objectContaining({ status: 'failed', failureCode: 'team_action_cancelled', canCancel: false }))
    expect(await api.getTeam()).toEqual(expect.objectContaining({ members: saved.members, proposedMembers: null, revision: saved.revision }))
  })

  it('does not expose a permanent management-credential escape hatch', async () => {
    vi.stubEnv('VITE_GATEWAY_UI_PREVIEW', '1')
    window.history.replaceState(null, '', '/team?preview=team-no-credential')
    const api = previewApi()
    const saved = await api.getTeam()
    expect(saved.managementCredentialConfigured).toBe(false)
    expect(saved.editingDisabledReason).toBe('managed_in_cloudflare')
    await expect(api.prepareTeamAction(saved.revision, saved.members)).rejects.toEqual(expect.objectContaining({ code: 'team_editing_managed_in_cloudflare' }))
    expect(await api.getTeam()).toEqual(saved)
  })

  it('previews an interrupted removal as the gateway records it: a settled action, a lost Team read, and a preparable next authorization', async () => {
    vi.stubEnv('VITE_GATEWAY_UI_PREVIEW', '1')
    window.history.replaceState(null, '', '/settings?preview=removal-interrupted')
    const api = previewApi()
    const pointer = (await api.getSourceActions()).blockingAction
    expect(pointer).toEqual(expect.objectContaining({ kind: 'teardown' }))
    if (!pointer) throw new Error('Expected a recorded synthetic removal')
    expect(await api.getTeardownAction(pointer.actionId)).toEqual(expect.objectContaining({
      status: 'recovery_required', failureCode: 'fresh_authorization_required',
    }))
    await expect(api.getTeam()).rejects.toEqual(expect.objectContaining({ status: 503 }))
    expect((await api.getStatus()).status).toBe('ready')
    expect((await api.prepareTeardownAction()).status).toBe('authorization_required')
  })

  it('rejects attempts to write through release-gated and lifecycle-paused preview contracts', async () => {
    vi.stubEnv('VITE_GATEWAY_UI_PREVIEW', '1')
    for (const scenario of ['team-readonly', 'team-lifecycle']) {
      window.history.replaceState(null, '', `/team?preview=${scenario}`)
      const api = previewApi()
      const saved = await api.getTeam()
      expect(saved.editingEnabled).toBe(false)
      await expect(api.prepareTeamAction(saved.revision, saved.members)).rejects.toThrow()
      expect((await api.getTeam()).pendingAction).toBeNull()
    }
  })
})

describe('sign-in connector preview', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
    window.history.replaceState(null, '', '/')
    window.sessionStorage.removeItem('ankka-gateway-ui-preview-scenario')
  })

  it('walks the same order as the gateway: nothing enabled, connected, chosen, attached', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z'))
    vi.stubEnv('VITE_GATEWAY_UI_PREVIEW', '1')
    window.history.replaceState(null, '', '/sources?preview=source-sign-in')
    const api = previewApi()
    const draft = (await api.getSources()).sources.find((source) => source.authMode === 'oauth' && source.status === 'draft')
    const paused = (await api.getSourceActions()).actions[0]
    if (!draft || !paused) throw new Error('Expected a paused synthetic sign-in installation')
    expect([draft.enabledTools, paused.failureCode, paused.canRenew]).toEqual([[], 'source_connection_required', true])
    expect(paused.connectionUrl).toMatch(/^https:\/\/dash\.cloudflare\.com\//u)

    // Not connected at first, however often it is read; the operator connects it two seconds on.
    for (let read = 0; read < 2; read += 1) {
      expect(await api.getSourceActionTools(paused.actionId)).toEqual(expect.objectContaining({ state: 'connection_required', tools: [] }))
    }
    vi.setSystemTime(new Date('2030-01-01T00:00:02.000Z'))
    const offered = await api.getSourceActionTools(paused.actionId)
    expect(offered.state).toBe('ready')
    expect(offered.tools.some((tool) => tool.readOnlyHint === null && tool.description === null)).toBe(true)

    // Nothing chosen: the resume keeps waiting. A name outside the list, or a stale revision, is refused.
    const revision = (await api.getSources()).revision
    await expect(api.prepareSourceAction(revision, draft.id, paused.actionId)).rejects.toEqual(expect.objectContaining({ code: 'source_tools_required' }))
    await expect(api.chooseSourceActionTools(paused.actionId, revision, draft.id, ['contacts_purge'])).rejects.toEqual(expect.objectContaining({ code: 'source_tools_mismatch' }))
    await expect(api.chooseSourceActionTools(paused.actionId, revision + 1, draft.id, ['contacts_get'])).rejects.toEqual(expect.objectContaining({ code: 'source_action_conflict' }))

    const chosen = await api.chooseSourceActionTools(paused.actionId, revision, draft.id, ['contacts_search', 'contacts_get'])
    expect(chosen).toEqual({ schemaVersion: 1, actionId: paused.actionId, sourceId: draft.id, revision: revision + 1, enabledTools: ['contacts_get', 'contacts_search'] })
    expect((await api.getSourceActions()).actions[0]?.failureCode).toBe('source_tools_chosen')
    expect((await api.prepareSourceAction(chosen.revision, draft.id, paused.actionId)).status).toBe('succeeded')
    const installed = (await api.getSources()).sources.find((source) => source.id === draft.id)
    expect([installed?.status, installed?.enabledTools]).toEqual(['installed', ['contacts_get', 'contacts_search']])
    await expect(api.getSourceActionTools(paused.actionId)).rejects.toEqual(expect.objectContaining({ code: 'source_tools_unavailable' }))
  })
})
