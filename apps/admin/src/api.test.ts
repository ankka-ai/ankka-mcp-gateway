import { afterEach, describe, expect, it, vi } from 'vitest'
import { GatewayApiError, HttpGatewayAdminApi, validHandoffUrl } from './api'

describe('HttpGatewayAdminApi', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  const readyStatus = {
    schemaVersion: 1,
    status: 'ready',
    controlPlaneOrigin: 'https://deploy.ankka.ai',
    release: 'gateway-v1.0.0',
    gateway: {
      name: 'Example Gateway',
      hostname: 'mcp.example.com',
      mcpUrl: 'https://mcp.example.com/mcp',
      capabilityMode: 'read_only',
      codeMode: 'default_on',
    },
    source: null,
    access: { administratorCount: 1, memberCount: 2 },
    updatedAt: '2026-08-29T00:00:00.000Z',
  } as const

  it('removes the exact draft at its displayed revision through the same-origin API', async () => {
    const fetch = vi.fn(async () => Response.json({ schemaVersion: 1, revision: 5, applyMode: 'account_token', sources: [] }))
    vi.stubGlobal('fetch', fetch)
    await new HttpGatewayAdminApi().removeSourceDraft(4, 'source-example')
    expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/sources', expect.objectContaining({
      method: 'DELETE', credentials: 'same-origin', redirect: 'error',
      body: JSON.stringify({ schemaVersion: 1, revision: 4, sourceId: 'source-example' }),
    }))
  })

  it.each(['bigquery_google_key_invalid', 'bigquery_google_auth_http_400', 'bigquery_google_query_http_403',
    'bigquery_google_response_invalid', 'bigquery_setup_failed', 'bigquery_google_auth_http_private-detail'])
  ('keeps only bounded BigQuery failure codes from the connector status: %s', async (code) => {
    const actionId = `action_${'a'.repeat(32)}`
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ schemaVersion: 1, actionId, sourceId: 'source-test',
      status: 'failed', expiresAt: '2030-01-01T00:00:00.000Z', failureCode: code })))
    const action = await new HttpGatewayAdminApi().getSourceAction(actionId)
    expect(action.failureCode).toBe(code.endsWith('private-detail') ? 'source_action_failed' : code)
  })

  it('accepts direct connector completion without a consent URL', async () => {
    const completed = { schemaVersion: 1, actionId: `action_${'a'.repeat(32)}`, status: 'succeeded', expiresAt: '2030-01-01T00:00:00.000Z' }
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(completed)))
    await expect(new HttpGatewayAdminApi().prepareSourceAction(4, 'source-test')).resolves.toEqual(completed)
  })

  it('renews an exact connector action through its same-origin endpoint', async () => {
    const actionId = `action_${'a'.repeat(32)}`
    const prepared = { schemaVersion: 1, actionId, status: 'authorization_required',
      expiresAt: '2030-01-01T00:00:00.000Z', handoffUrl: 'https://manage.example.com/__ankka/operation#synthetic' }
    const fetch = vi.fn(async () => Response.json(prepared))
    vi.stubGlobal('fetch', fetch)
    await expect(new HttpGatewayAdminApi().prepareSourceAction(4, 'source-test', actionId)).resolves.toEqual(prepared)
    expect(fetch).toHaveBeenCalledExactlyOnceWith(`/api/source-actions/${actionId}/renew`, expect.objectContaining({
      method: 'POST', body: JSON.stringify({ schemaVersion: 1, revision: 4, sourceId: 'source-test' }),
    }))
  })

  it('accepts the protected public BigQuery catalogue with nullable summaries and a fixed setup block', async () => {
    const discovery = {
      schemaVersion: 1, status: 'authorization_required', endpoint: 'https://bigquery.googleapis.com/mcp',
      protocolVersion: '2026-07-28', authentication: 'oauth',
      connectionBlock: 'source_google_shared_oauth_unsupported',
      tools: [{ name: 'execute_sql_readonly', title: null, description: null,
        readOnlyHint: true, destructiveHint: false, openWorldHint: null, defaultSelected: true }],
    }
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(discovery)))
    await expect(new HttpGatewayAdminApi().discoverSource(discovery.endpoint)).resolves.toEqual(discovery)
  })

  it('renders only the fixed Google compatibility error, never provider details', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      error: 'source_google_shared_oauth_unsupported', detail: 'synthetic-sensitive-provider-response',
    }, { status: 409 })))
    await expect(new HttpGatewayAdminApi().saveSourceDraft(0, {
      label: 'GA4 example', url: 'https://bigquery.googleapis.com/mcp', authMode: 'oauth', enabledTools: ['execute_sql_readonly'],
    })).rejects.toEqual(expect.objectContaining({
      code: 'source_google_shared_oauth_unsupported',
      message: expect.stringContaining('without an admin credential flow'),
    }))
  })

  it('saves an exact sorted connector draft through the production API', async () => {
    let capturedInit: RequestInit | undefined
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedInit = init
      return new Response(JSON.stringify({ schemaVersion: 1, revision: 8, applyMode: 'oauth_per_action', sources: [] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetch)

    await new HttpGatewayAdminApi().saveSourceDraft(7, {
      label: 'Knowledge', url: 'https://knowledge.example.com/mcp', authMode: 'none',
      enabledTools: ['search', 'fetch', 'search'],
    })

    expect(fetch).toHaveBeenCalledWith('/api/sources', expect.objectContaining({
      method: 'PUT', credentials: 'same-origin', redirect: 'error',
    }))
    expect(JSON.parse(String(capturedInit?.body))).toEqual({
      schemaVersion: 1,
      revision: 7,
      source: {
        label: 'Knowledge', url: 'https://knowledge.example.com/mcp', authMode: 'none',
        enabledTools: ['fetch', 'search'],
      },
    })
  })

  it('turns fixed Worker error codes into safe local messages', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'source_conflict' }), {
      status: 409, headers: { 'content-type': 'application/json' },
    })))
    await expect(new HttpGatewayAdminApi().getSources()).rejects.toEqual(
      expect.objectContaining<Partial<GatewayApiError>>({ status: 409, code: 'source_conflict' }),
    )
  })

  it('discovers connector actions without requiring a saved action identifier or authorization fragment', async () => {
    const actionId = `action_${'a'.repeat(32)}`
    const action = {
      schemaVersion: 1, actionId, sourceId: 'source-1111111111111111', status: 'authorization_required',
      issuedAt: '2030-01-01T00:00:00.000Z', expiresAt: '2030-01-01T00:10:00.000Z',
      state: 'authorization_expired', failureCode: null, canCancel: true,
    }
    const snapshot = { schemaVersion: 1, actions: [action], blockingAction: { kind: 'source', actionId, sourceId: action.sourceId } }
    const fetch = vi.fn(async () => Response.json(snapshot))
    vi.stubGlobal('fetch', fetch)
    expect(await new HttpGatewayAdminApi().getSourceActions()).toEqual(snapshot)
    expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/source-actions', expect.objectContaining({ credentials: 'same-origin', redirect: 'error' }))
  })

  it('accepts only a credential-free Cloudflare server configuration link for connection pauses', async () => {
    const connectionUrl = `https://dash.cloudflare.com/${'1'.repeat(32)}/one/access-controls/ai-controls/mcp-server/edit/synthetic-source`
    const action = {
      schemaVersion: 1, actionId: `action_${'a'.repeat(32)}`, sourceId: 'source-1111111111111111',
      status: 'recovery_required', state: 'recovery_required', failureCode: 'source_connection_required',
      issuedAt: '2030-01-01T00:00:00.000Z', expiresAt: '2030-01-01T00:10:00.000Z',
      canCancel: false, canRenew: true, connectionUrl,
    }
    const snapshot = { schemaVersion: 1, actions: [action], blockingAction: null }
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(snapshot)))
    expect(await new HttpGatewayAdminApi().getSourceActions()).toEqual(snapshot)
    for (const invalid of ['javascript:alert(1)', connectionUrl.replace('dash.cloudflare.com', 'other.example.com'),
      `${connectionUrl}?code=synthetic-private-code`, `${connectionUrl}#synthetic-private-fragment`]) {
      vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...snapshot, actions: [{ ...action, connectionUrl: invalid }] })))
      await expect(new HttpGatewayAdminApi().getSourceActions()).rejects.toThrow()
    }
  })

  it.each([
    ['draft_changed', 'saved connector draft changed'],
    ['source_pending', 'connector installation is already pending'],
    ['lifecycle_pending', 'Another gateway action is pending'],
    ['recovery_required', 'Connector provisioning may have started'],
  ])('preserves the safe %s conflict reason and action pointer', async (reason, message) => {
    const action = { kind: reason === 'lifecycle_pending' ? 'runtime' : 'source', actionId: `action_${'a'.repeat(32)}` }
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      schemaVersion: 1, error: 'source_action_conflict', reason, action, detail: 'synthetic-provider-detail',
    }, { status: 409 })))
    const error = await new HttpGatewayAdminApi().prepareSourceAction(4, 'source-1111111111111111').catch((cause: unknown) => cause)
    expect(error).toMatchObject({ code: 'source_action_conflict', reason, action, message: expect.stringContaining(message) })
    expect(JSON.stringify(error)).not.toContain('synthetic-provider-detail')
  })

  it('drops unreviewed conflict reasons and credential-bearing action fields', async () => {
    for (const details of [
      { reason: 'synthetic-provider-detail' },
      { reason: 'source_pending', action: { kind: 'source', actionId: `action_${'a'.repeat(32)}`, handoffUrl: 'synthetic-private-fragment' } },
      { reason: 'source_pending', action: { kind: 'source', actionId: 'synthetic-private-fragment' } },
    ]) {
      vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'source_action_conflict', ...details }, { status: 409 })))
      const error = await new HttpGatewayAdminApi().prepareSourceAction(4, 'source-1111111111111111').catch((cause: unknown) => cause)
      expect(error).toMatchObject({ code: 'source_action_conflict', reason: undefined, action: undefined })
      expect(JSON.stringify(error)).not.toMatch(/synthetic-provider|synthetic-private/u)
    }
  })

  it('does not retain an arbitrary server error code in an exception', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'synthetic-sensitive-provider-error' }, { status: 503 })))
    const error = await new HttpGatewayAdminApi().getSourceActions().catch((cause: unknown) => cause)
    expect(error).toMatchObject({ code: 'request_failed', status: 503 })
    expect(JSON.stringify(error)).not.toContain('synthetic-sensitive')
  })

  it('fails closed when source-action discovery contains unknown fields or cancellation is not explicit', async () => {
    const action = {
      schemaVersion: 1, actionId: `action_${'a'.repeat(32)}`, sourceId: 'source-1111111111111111',
      status: 'authorization_required', issuedAt: '2030-01-01T00:00:00.000Z', expiresAt: '2030-01-01T00:10:00.000Z',
      state: 'authorization_required', canCancel: true, failureCode: null,
    }
    for (const invalid of [
      { ...action, handoffUrl: 'synthetic-sensitive-fragment' },
      { ...action, canCancel: undefined },
      { ...action, state: 'unreviewed' },
    ]) {
      vi.stubGlobal('fetch', vi.fn(async () => Response.json({ schemaVersion: 1, actions: [invalid], blockingAction: null })))
      const error = await new HttpGatewayAdminApi().getSourceActions().catch((cause: unknown) => cause)
      expect(error).toMatchObject({ code: 'response_invalid', status: 502 })
      expect(error).not.toHaveProperty('issues')
      expect(JSON.stringify(error)).not.toContain('synthetic-sensitive')
    }
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ schemaVersion: 1, actions: [{ ...action, failureCode: 'synthetic-sensitive-provider-response' }], blockingAction: null })))
    const snapshot = await new HttpGatewayAdminApi().getSourceActions()
    expect(snapshot.actions[0]?.failureCode).toBe('source_action_failed')
    expect(JSON.stringify(snapshot)).not.toContain('synthetic-sensitive')
  })

  it('preserves the legacy connector status and cancellation response shape', async () => {
    const actionId = `action_${'a'.repeat(32)}`
    const action = { schemaVersion: 1, actionId, sourceId: 'source-1111111111111111', status: 'failed', expiresAt: '2030-01-01T00:10:00.000Z', failureCode: 'source_action_denied' }
    const fetch = vi.fn(async () => Response.json(action))
    vi.stubGlobal('fetch', fetch)
    const api = new HttpGatewayAdminApi()
    expect(await api.getSourceAction(actionId)).toEqual(action)
    expect(await api.cancelSourceAction(actionId)).toEqual(action)
    expect(fetch).toHaveBeenLastCalledWith(`/api/source-actions/${actionId}`, expect.objectContaining({ method: 'DELETE', body: '{}', credentials: 'same-origin', redirect: 'error' }))
  })

  it('sends the exact reviewed runtime target without changing legacy request shape', async () => {
    const action = {
      schemaVersion: 1, actionId: `action_${'a'.repeat(32)}`, status: 'authorization_required',
      expiresAt: '2030-01-01T00:00:00.000Z', handoffUrl: `${window.location.origin}/__ankka/operation#${'a'.repeat(40)}`, operation: 'update',
    }
    const fetch = vi.fn(async () => Response.json(action))
    vi.stubGlobal('fetch', fetch)
    const api = new HttpGatewayAdminApi()
    const expectedTarget = { release: 'gateway-v1.2.3', artifactSha256: `sha256:${'b'.repeat(64)}` }
    await api.prepareRuntimeAction('update', expectedTarget)
    expect(fetch).toHaveBeenLastCalledWith('/api/update-actions', expect.objectContaining({
      body: JSON.stringify({ schemaVersion: 1, operation: 'update', expectedTarget }),
      credentials: 'same-origin', redirect: 'error',
    }))
    await api.prepareRuntimeAction('update')
    expect(fetch).toHaveBeenLastCalledWith('/api/update-actions', expect.objectContaining({
      body: JSON.stringify({ schemaVersion: 1, operation: 'update' }),
    }))
  })

  it('requires explicit source-install availability and defaults an older response to disabled', async () => {
    const base = { schemaVersion: 1, revision: 4, applyMode: 'oauth_per_action', sources: [] }
    for (const installationEnabled of [undefined, false, true]) {
      vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...base, installationEnabled })))
      expect((await new HttpGatewayAdminApi().getSources()).installationEnabled).toBe(installationEnabled === true)
    }
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...base, installationEnabled: 'yes' })))
    await expect(new HttpGatewayAdminApi().getSources()).rejects.toThrow()
  })

  it('shows the fixed source-addition pause without exposing provider details or a handoff', async () => {
    const fetch = vi.fn(async () => Response.json({ error: 'source_addition_paused', retryable: false, detail: 'private provider response' }, { status: 409 }))
    vi.stubGlobal('fetch', fetch)
    const api = new HttpGatewayAdminApi()
    for (const request of [
      api.prepareSourceAction(4, 'source-1111111111111111'),
      api.saveSourceDraft(4, { label: 'Knowledge', url: 'https://knowledge.example.com/mcp', authMode: 'none', enabledTools: ['search'] }),
    ]) await expect(request).rejects.toEqual(expect.objectContaining({ code: 'source_addition_paused', message: 'New-connector installation is temporarily unavailable in this release. Existing connectors and team permissions remain available.' }))
  })

  it('saves the exact revision-bound Team batch through one same-origin POST without a handoff', async () => {
    const members = [{ email: 'teammate@example.com', sourceIds: ['source-1111111111111111'] }]
    const actionId = `action_${'a'.repeat(32)}`
    const expiresAt = '2030-01-01T00:00:00.000Z'
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({
        schemaVersion: 1, revision: 4, editingEnabled: true, editingDisabledReason: null, managementCredentialConfigured: true, members, adminEmails: ['admin@example.com'],
        sources: [{ id: 'source-1111111111111111', label: 'Knowledge', enabledTools: ['search'], status: 'installed' }],
        pendingAction: null, proposedMembers: null,
      }))
      .mockResolvedValueOnce(Response.json({ schemaVersion: 1, action: { schemaVersion: 1, action: 'access', actionId, status: 'succeeded', expiresAt, failureCode: null, canCancel: false } }))
      .mockResolvedValueOnce(Response.json({ schemaVersion: 1, actionId, status: 'recovery_required', expiresAt, failureCode: 'team_recovery_required' }))
    vi.stubGlobal('fetch', fetch)
    const api = new HttpGatewayAdminApi()

    expect(await api.getTeam()).toEqual(expect.objectContaining({ revision: 4, proposedMembers: null, managementCredentialConfigured: true }))
    expect(await api.prepareTeamAction(4, members)).toEqual({ schemaVersion: 1, action: { schemaVersion: 1, action: 'access', actionId, status: 'succeeded', expiresAt, failureCode: null, canCancel: false } })
    expect(await api.getTeamAction(actionId)).toEqual(expect.objectContaining({ status: 'recovery_required' }))
    expect(fetch).toHaveBeenNthCalledWith(1, '/api/team', expect.objectContaining({ credentials: 'same-origin', redirect: 'error' }))
    expect(fetch).toHaveBeenNthCalledWith(2, '/api/team-actions', expect.objectContaining({
      method: 'POST', credentials: 'same-origin', redirect: 'error',
      body: JSON.stringify({ schemaVersion: 1, expectedRevision: 4, members }),
    }))
    expect(fetch).toHaveBeenNthCalledWith(3, `/api/team-actions/${actionId}`, expect.objectContaining({ credentials: 'same-origin' }))
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(fetch.mock.calls.every(([path]) => String(path).startsWith('/api/'))).toBe(true)
  })

  it('rejects legacy Team OAuth handoffs and unexpected fields from the local Save response', async () => {
    const actionId = `action_${'a'.repeat(32)}`
    const expiresAt = '2030-01-01T00:00:00.000Z'
    const action = { schemaVersion: 1, action: 'access', actionId, status: 'succeeded', expiresAt, failureCode: null, canCancel: false }
    const handoffUrl = `${window.location.origin}/__ankka/operation#${'a'.repeat(40)}`
    for (const payload of [
      { schemaVersion: 1, actionId, status: 'authorization_required', expiresAt, handoffUrl },
      { schemaVersion: 1, action: { ...action, status: 'authorization_required' } },
      { schemaVersion: 1, action, handoffUrl },
      { schemaVersion: 1, action: { ...action, token: 'synthetic-disallowed-field' } },
    ]) {
      const fetch = vi.fn(async () => Response.json(payload))
      vi.stubGlobal('fetch', fetch)
      await expect(new HttpGatewayAdminApi().prepareTeamAction(4, [])).rejects.toThrow()
      expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/team-actions', expect.objectContaining({ redirect: 'error' }))
    }
  })

  it('does not expose raw team failure details', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'team_action_conflict', detail: 'provider private response' }, { status: 409 })))
    await expect(new HttpGatewayAdminApi().prepareTeamAction(1, [])).rejects.toEqual(expect.objectContaining({
      code: 'team_action_conflict', message: 'A team access change is already in progress. Refresh to review or resume it.',
    }))
  })

  it('defaults cancellation to denied when an older Team action omits explicit capability', async () => {
    const actionId = `action_${'a'.repeat(32)}`
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ schemaVersion: 1, actionId, status: 'authorization_required', expiresAt: '2030-01-01T00:00:00.000Z', failureCode: null })))
    expect(await new HttpGatewayAdminApi().getTeamAction(actionId)).toEqual(expect.objectContaining({ canCancel: false }))
  })

  it('accepts the exact runtime Team action projection in saved snapshots and action responses', async () => {
    const actionId = `action_${'a'.repeat(32)}`
    const expiresAt = '2030-01-01T00:00:00.000Z'
    const members = [{ email: 'admin@example.com', sourceIds: [] }]
    for (const [status, failureCode, canCancel] of [
      ['authorization_required', null, true],
      ['applying', null, false],
      ['recovery_required', 'team_policy_drift', false],
      ['succeeded', null, false],
      ['failed', 'team_action_cancelled', false],
    ] as const) {
      const pendingAction = { schemaVersion: 1, action: 'access', actionId, status, expiresAt, failureCode, canCancel }
      const proposedMembers = status === 'succeeded' || status === 'failed' ? null : members
      vi.stubGlobal('fetch', vi.fn()
        .mockResolvedValueOnce(Response.json({
          schemaVersion: 1, revision: 4, editingEnabled: true, editingDisabledReason: null, managementCredentialConfigured: true,
          members, adminEmails: ['admin@example.com'], sources: [], pendingAction, proposedMembers,
        }))
        .mockResolvedValueOnce(Response.json(pendingAction)))
      const api = new HttpGatewayAdminApi()
      expect((await api.getTeam()).pendingAction).toEqual(pendingAction)
      expect(await api.getTeamAction(actionId)).toEqual(pendingAction)
    }
  })

  it('rejects other action kinds and unreviewed fields in the strict Team action contract', async () => {
    const actionId = `action_${'a'.repeat(32)}`
    const action = { schemaVersion: 1, action: 'access', actionId, status: 'authorization_required', expiresAt: '2030-01-01T00:00:00.000Z', failureCode: null, canCancel: true }
    for (const extra of [{ action: 'install' }, { action: 'teardown' }, { unreviewedField: true }]) {
      vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...action, ...extra })))
      await expect(new HttpGatewayAdminApi().getTeamAction(actionId)).rejects.toThrow()
    }
  })

  it('cancels only the exact recorded Team action through a same-origin request', async () => {
    const actionId = `action_${'a'.repeat(32)}`
    const fetch = vi.fn(async () => Response.json({ schemaVersion: 1, action: 'access', actionId, status: 'failed', expiresAt: '2030-01-01T00:00:00.000Z', failureCode: 'team_action_cancelled', canCancel: false }))
    vi.stubGlobal('fetch', fetch)
    expect(await new HttpGatewayAdminApi().cancelTeamAction(actionId)).toEqual(expect.objectContaining({ status: 'failed', canCancel: false }))
    expect(fetch).toHaveBeenCalledWith(`/api/team-actions/${actionId}`, expect.objectContaining({ method: 'DELETE', credentials: 'same-origin', redirect: 'error', body: '{}' }))
  })

  it('accepts larger Team rosters while retaining field, connector, and tool validation', async () => {
    const person = { email: 'teammate@example.com', sourceIds: [] }
    const source = { id: 'source-1111111111111111', label: 'Knowledge', enabledTools: ['search'], status: 'installed' }
    const validTeam = {
      schemaVersion: 1, revision: 4, editingEnabled: true, editingDisabledReason: null, managementCredentialConfigured: true,
      members: [person], adminEmails: ['admin@example.com'], sources: [source], teams: [], pendingAction: null, proposedMembers: null, proposedTeams: null,
    }
    const members = Array.from({ length: 100 }, (_, index) => ({ email: `user${index}@example.com`, sourceIds: [] }))
    const largeTeam = { ...validTeam, members, proposedMembers: members, adminEmails: members.map(({ email }) => email) }
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(largeTeam)))
    expect(await new HttpGatewayAdminApi().getTeam()).toEqual(largeTeam)
    for (const invalid of [
      { members: [{ ...person, sourceIds: Array(33).fill(source.id) }] },
      { sources: Array(33).fill(source) },
      { sources: [{ ...source, enabledTools: Array(501).fill('search') }] },
      { members: [{ ...person, email: `${'a'.repeat(255)}@example.com` }] },
      { revision: 1.5 },
      { revision: -1 },
      { managementCredentialConfigured: undefined },
      { managementCredentialConfigured: 'yes' },
    ]) {
      vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...validTeam, ...invalid })))
      await expect(new HttpGatewayAdminApi().getTeam()).rejects.toThrow()
    }
  })

  it('maps native Team policy and lifecycle errors to fixed safe local explanations', async () => {
    for (const [code, explanation] of [
      ['team_access_revision_conflict', 'Team access changed in another tab'],
      ['team_action_recovery_required', 'Some access policies may already have changed'],
      ['team_policy_drift', 'Cloudflare access policies no longer match'],
      ['team_editing_managed_in_cloudflare', 'managed directly in Cloudflare'],
      ['team_management_credential_missing', 'Add your management token in Settings'],
      ['team_management_credential_invalid', 'Verify management access in Settings'],
      ['team_access_group_permission_missing', 'Access group write'],
      ['team_teardown_requires_compatible_release', 'Automatic removal is unavailable'],
    ] as const) {
      vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: code, detail: 'private provider detail' }, { status: 409 })))
      await expect(new HttpGatewayAdminApi().prepareTeamAction(1, [])).rejects.toEqual(expect.objectContaining({ code, message: expect.stringContaining(explanation) }))
    }
  })

  it('keeps teardown failures local and free of provider response text', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: 'teardown_action_conflict',
      detail: 'provider token and response text must not be rendered',
    }), {
      status: 409, headers: { 'content-type': 'application/json' },
    })))
    await expect(new HttpGatewayAdminApi().prepareTeardownAction()).rejects.toEqual(
      expect.objectContaining<Partial<GatewayApiError>>({
        status: 409,
        code: 'teardown_action_conflict',
        message: expect.not.stringContaining('provider token'),
      }),
    )
  })

  it('reads every status the removal journal records, and keeps `gateway_removed` out of Team actions', async () => {
    const actionId = `action_${'a'.repeat(32)}`
    const action = { schemaVersion: 1, actionId, expiresAt: '2030-01-01T00:00:00.000Z', failureCode: null }
    for (const status of ['authorization_required', 'applying', 'gateway_removed', 'failed', 'recovery_required'] as const) {
      vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...action, status })))
      expect((await new HttpGatewayAdminApi().getTeardownAction(actionId)).status).toBe(status)
    }
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...action, status: 'succeeded' })))
    await expect(new HttpGatewayAdminApi().getTeardownAction(actionId)).rejects.toMatchObject({ code: 'response_invalid' })
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...action, status: 'gateway_removed', action: 'access' })))
    await expect(new HttpGatewayAdminApi().getTeamAction(actionId)).rejects.toMatchObject({ code: 'response_invalid' })
  })

  it('reads whether removal has begun from the source-actions answer, absent or boolean and nothing else', async () => {
    const answer = { schemaVersion: 1, actions: [], blockingAction: null }
    for (const [reported, expected] of [[{}, undefined], [{ removalStarted: false }, false], [{ removalStarted: true }, true]] as const) {
      vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...answer, ...reported })))
      expect((await new HttpGatewayAdminApi().getSourceActions()).removalStarted).toBe(expected)
    }
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...answer, removalStarted: 'yes' })))
    await expect(new HttpGatewayAdminApi().getSourceActions()).rejects.toMatchObject({ code: 'response_invalid' })
  })

  it('accepts only this gateway’s own operation handoff shape', () => {
    const expected = 'https://manage.example.com'
    expect(validHandoffUrl(`${expected}/__ankka/operation#${'a'.repeat(40)}`, expected)).toContain('/__ankka/operation#')
    expect(validHandoffUrl(`${expected}/__ankka/operation/teardown#${'a'.repeat(40)}`, expected)).toContain('/operation/teardown#')
    expect(validHandoffUrl(`${expected}/__ankka/operation/teardown/start#${'a'.repeat(40)}`, expected)).toBeNull()
    expect(validHandoffUrl(`https://evil.example/__ankka/operation#${'a'.repeat(40)}`, expected)).toBeNull()
    expect(validHandoffUrl(`https://user:password@manage.example.com/__ankka/operation#${'a'.repeat(40)}`, expected)).toBeNull()
    expect(validHandoffUrl(`${expected}/__ankka/operation?token=secret`, expected)).toBeNull()
    // The retired hosted handoff is never navigated to, even from a trusted control plane.
    expect(validHandoffUrl(`${expected}/manage#${'a'.repeat(40)}`, expected)).toBeNull()
    expect(validHandoffUrl(`https://deploy.ankka.ai/__ankka/operation#${'a'.repeat(40)}`, expected)).toBeNull()
    expect(validHandoffUrl(`${expected}/__ankka/operation#${'a'.repeat(40)}`, `${expected}/path`)).toBeNull()
  })

  it('rejects a non-canonical control-plane origin in management status', async () => {
    for (const controlPlaneOrigin of [
      'http://deploy.ankka.ai',
      'https://deploy.ankka.ai/',
      'https://deploy.ankka.ai/path',
      'https://deploy.ankka.ai?view=status',
      'https://deploy.ankka.ai#status',
      'https://deploy.ankka.ai:443',
      'https://owner@deploy.ankka.ai',
    ]) {
      vi.stubGlobal('fetch', vi.fn(async () => Response.json({
        ...readyStatus,
        controlPlaneOrigin,
      })))
      await expect(new HttpGatewayAdminApi().getStatus()).rejects.toThrow()
      vi.unstubAllGlobals()
    }
  })

  it('accepts the service identity a gateway reports, absent, null or configured, and nothing looser', async () => {
    const clientId = `${'c'.repeat(32)}.access`
    for (const [reported, expected] of [
      [{}, undefined], [{ serviceIdentity: null }, null], [{ serviceIdentity: { clientId } }, { clientId }],
    ] as const) {
      vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...readyStatus, ...reported })))
      expect((await new HttpGatewayAdminApi().getStatus()).serviceIdentity).toEqual(expected)
      vi.unstubAllGlobals()
    }
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...readyStatus, serviceIdentity: { clientId, secret: 'synthetic' } })))
    await expect(new HttpGatewayAdminApi().getStatus()).rejects.toMatchObject({ code: 'response_invalid' })
  })

  it('accepts who prepared a connector or Team action and rejects an unknown kind', async () => {
    const actionId = `action_${'a'.repeat(32)}`
    const action = { schemaVersion: 1, actionId, status: 'succeeded', expiresAt: '2030-01-01T00:00:00.000Z', failureCode: null }
    for (const actorKind of ['human', 'service'] as const) {
      vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...action, sourceId: 'source-test', actorKind })))
      expect((await new HttpGatewayAdminApi().getSourceAction(actionId)).actorKind).toBe(actorKind)
      vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...action, action: 'access', actorKind, canCancel: false })))
      expect((await new HttpGatewayAdminApi().getTeamAction(actionId)).actorKind).toBe(actorKind)
    }
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...action, sourceId: 'source-test', actorKind: 'robot' })))
    await expect(new HttpGatewayAdminApi().getSourceAction(actionId)).rejects.toMatchObject({ code: 'response_invalid' })
  })

  it('accepts the release a connector installation would stop being restorable, absent, null or named, and nothing looser', async () => {
    const base = { schemaVersion: 1, revision: 4, applyMode: 'account_token', installationEnabled: true, sources: [] }
    for (const [reported, expected] of [
      [{}, undefined], [{ installEndsRollbackTo: null }, null], [{ installEndsRollbackTo: 'gateway-v0.9.9' }, 'gateway-v0.9.9'],
    ] as const) {
      vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...base, ...reported })))
      expect((await new HttpGatewayAdminApi().getSources()).installEndsRollbackTo).toBe(expected)
      expect((await new HttpGatewayAdminApi().saveSourceDraft(4, { label: 'Knowledge', url: 'https://knowledge.example.com/mcp', authMode: 'none', enabledTools: ['search'] })).installEndsRollbackTo).toBe(expected)
    }
    for (const unreviewed of [{ installEndsRollbackTo: true }, { installEndsRollbackTo: { release: 'gateway-v0.9.9' } }, { minimumRuntimeRelease: 'gateway-v1.0.0' }]) {
      vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...base, ...unreviewed })))
      await expect(new HttpGatewayAdminApi().getSources()).rejects.toMatchObject({ code: 'response_invalid' })
    }
  })

  it('accepts a rollback that is offered, absent, or recorded but no longer restorable, and nothing looser', async () => {
    const base = { schemaVersion: 1, channel: 'stable', status: 'up_to_date', current: { release: 'gateway-v1.0.0', artifactSha256: `sha256:${'a'.repeat(64)}` }, available: null }
    const recorded = { release: 'gateway-v0.9.9', artifactSha256: `sha256:${'b'.repeat(64)}` }
    for (const rollback of [
      { available: false },
      { available: false, reason: 'minimum_runtime_release', release: recorded.release },
      { available: true, ...recorded, dataRollback: false },
    ]) {
      vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...base, rollback })))
      expect((await new HttpGatewayAdminApi().getUpdate()).rollback).toEqual(rollback)
    }
    for (const rollback of [
      { available: false, reason: 'unreviewed_reason', release: recorded.release },
      { available: false, reason: 'minimum_runtime_release' },
      { available: false, reason: 'minimum_runtime_release', release: recorded.release, minimumRuntimeRelease: 'gateway-v1.0.0' },
      { available: true, ...recorded, dataRollback: false, reason: 'minimum_runtime_release' },
    ]) {
      vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...base, rollback })))
      await expect(new HttpGatewayAdminApi().getUpdate()).rejects.toMatchObject({ code: 'response_invalid' })
    }
  })

  it('names unfinished work when removal is refused, in place of the receipt wording', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ schemaVersion: 1, error: 'teardown_action_conflict' }, { status: 409 })))
    await expect(new HttpGatewayAdminApi().prepareTeardownAction()).rejects.toMatchObject({
      code: 'teardown_action_conflict',
      message: 'Finish or cancel any unfinished connector installation, update or Team change, or wait for an open removal authorization to expire, then try again; if nothing is unfinished, the installation record could not be verified.',
    })
  })
})

// A sign-in source is installed with nothing enabled; its tools are chosen afterwards from Cloudflare's synced list.
describe('the tool choice of a sign-in connector', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  const actionId = `action_${'a'.repeat(32)}`
  const sourceId = 'source-1111111111111111'
  const bare = { title: null, description: null, readOnlyHint: null, destructiveHint: null, openWorldHint: null }
  const offered = { schemaVersion: 1, actionId, sourceId, state: 'ready', tools: [
    { name: 'records_export', ...bare },
    { name: 'records_search', ...bare, title: 'Search records', description: 'Search records.', readOnlyHint: true, destructiveHint: false },
  ] }

  it('reads the real tools of a paused installation through its own endpoint, in every fixed state', async () => {
    for (const answer of [offered, ...['connection_required', 'sync_required', 'unsupported'].map((state) => ({ ...offered, state, tools: [] }))]) {
      const fetch = vi.fn(async () => Response.json(answer))
      vi.stubGlobal('fetch', fetch)
      await expect(new HttpGatewayAdminApi().getSourceActionTools(actionId)).resolves.toEqual(answer)
      expect(fetch).toHaveBeenCalledExactlyOnceWith(`/api/source-actions/${actionId}/tools`, expect.not.objectContaining({ method: 'POST' }))
    }
  })

  it('fails closed on anything a tool list should not carry', async () => {
    for (const invalid of [
      { ...offered, connectionUrl: 'synthetic-sensitive-link' },
      { ...offered, state: 'partially_ready' },
      { ...offered, tools: [{ name: 'records_search', ...bare, inputSchema: { type: 'object' } }] },
      { ...offered, tools: [{ ...bare }] },
      { ...offered, tools: [{ name: 'records_search', ...bare, readOnlyHint: 'yes' }] },
      { ...offered, tools: Array.from({ length: 501 }, (_, index) => ({ name: `tool_${index}`, ...bare })) },
      { ...offered, tools: 'records_search' },
      { ...offered, actionId: 'action_short' },
      { ...offered, schemaVersion: 2 },
    ]) {
      vi.stubGlobal('fetch', vi.fn(async () => Response.json(invalid)))
      const error = await new HttpGatewayAdminApi().getSourceActionTools(actionId).catch((cause: unknown) => cause)
      expect(error).toMatchObject({ code: 'response_invalid', status: 502 })
      expect(JSON.stringify(error)).not.toContain('synthetic-sensitive')
    }
  })

  it('saves a choice as a sorted list without repeats, bound to the draft revision', async () => {
    const chosen = { schemaVersion: 1, actionId, sourceId, revision: 8, enabledTools: ['records_export', 'records_search'] }
    const fetch = vi.fn(async () => Response.json(chosen))
    vi.stubGlobal('fetch', fetch)
    await expect(new HttpGatewayAdminApi().chooseSourceActionTools(actionId, 7, sourceId, ['records_search', 'records_export', 'records_search']))
      .resolves.toEqual(chosen)
    expect(fetch).toHaveBeenCalledExactlyOnceWith(`/api/source-actions/${actionId}/tools`, expect.objectContaining({
      method: 'POST', body: JSON.stringify({ schemaVersion: 1, revision: 7, sourceId, enabledTools: ['records_export', 'records_search'] }),
    }))
    for (const invalid of [{ ...chosen, enabledTools: [] }, { ...chosen, revision: 0 }, { ...chosen, handoffUrl: 'synthetic' },
      { ...chosen, enabledTools: ['n'.repeat(129)] }, { schemaVersion: 1, actionId, sourceId, revision: 8 }]) {
      vi.stubGlobal('fetch', vi.fn(async () => Response.json(invalid)))
      await expect(new HttpGatewayAdminApi().chooseSourceActionTools(actionId, 7, sourceId, ['records_search']))
        .rejects.toMatchObject({ code: 'response_invalid' })
    }
  })

  it('keeps the two reasons such an installation waits for, and a connector saved without tools', async () => {
    const action = { schemaVersion: 1, actionId, sourceId, status: 'recovery_required', state: 'recovery_required',
      issuedAt: '2030-01-01T00:00:00.000Z', expiresAt: '2030-01-01T00:10:00.000Z', canCancel: false, canRenew: true }
    for (const failureCode of ['source_tools_required', 'source_tools_chosen']) {
      vi.stubGlobal('fetch', vi.fn(async () => Response.json({ schemaVersion: 1, actions: [{ ...action, failureCode }], blockingAction: null })))
      expect((await new HttpGatewayAdminApi().getSourceActions()).actions[0]?.failureCode).toBe(failureCode)
    }
    const sources = { schemaVersion: 1, revision: 3, applyMode: 'account_token', installationEnabled: true, sources: [
      { id: sourceId, label: 'Customer records', url: 'https://records.example.com/mcp', authMode: 'oauth', onBehalfOfUser: false, enabledTools: [], status: 'draft' }] }
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(sources)))
    expect((await new HttpGatewayAdminApi().getSources()).sources[0]?.enabledTools).toEqual([])
  })

  it.each([
    ['source_connection_required', /installed with nothing enabled and nobody assigned/u],
    ['source_sync_required', /has not finished syncing the tools/u],
    ['source_tools_required', /Choose its tools below to finish installation/u],
    ['source_tools_mismatch', /not in the list Cloudflare synced from this connector/u],
    ['source_tools_unavailable', /not waiting for a tool choice/u],
    ['source_tools_invalid', /between 1 and 500 tools/u],
    ['source_tools_unsupported', /cannot be offered here\. Nothing was enabled/u],
    ['source_catalogue_unavailable', /did not return this connector’s server record/u],
  ])('names %s instead of a failed request', async (code, wording) => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ schemaVersion: 1, error: code, detail: 'synthetic-sensitive-provider-text' }, { status: 409 })))
    const error = await new HttpGatewayAdminApi().getSourceActionTools(actionId).catch((cause: unknown) => cause)
    if (!(error instanceof GatewayApiError)) throw new Error('Expected a gateway refusal')
    expect(error).toMatchObject({ code, status: 409 })
    expect(error.message).toMatch(wording)
    expect(error.message).not.toContain('synthetic-sensitive')
  })

  it('reads an installed connector’s synced tools and saves the explicit selection', async () => {
    const listed = {
      schemaVersion: 1, sourceId, revision: 4, state: 'ready', pendingTools: null,
      enabledTools: ['records_search'],
      tools: [
        { name: 'records_export', ...bare },
        { name: 'records_search', ...bare, description: 'Search records.', readOnlyHint: true, destructiveHint: false },
      ],
    }
    const saved = { schemaVersion: 1, revision: 5, applyMode: 'account_token' as const, installationEnabled: false, sources: [] }
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json(listed))
      .mockResolvedValueOnce(Response.json(saved))
    vi.stubGlobal('fetch', fetch)
    const api = new HttpGatewayAdminApi()
    await expect(api.getInstalledSourceTools(sourceId)).resolves.toEqual(listed)
    await expect(api.updateInstalledSourceTools(4, sourceId, ['records_search', 'records_export', 'records_export'])).resolves.toEqual(saved)
    expect(fetch).toHaveBeenNthCalledWith(1, `/api/sources/${sourceId}/tools`, expect.not.objectContaining({ method: 'PUT' }))
    expect(fetch).toHaveBeenNthCalledWith(2, `/api/sources/${sourceId}/tools`, expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({ schemaVersion: 1, revision: 4, enabledTools: ['records_export', 'records_search'] }),
    }))
  })
})

// The gateway's own management token: added, replaced and verified from Settings. The token itself never reaches this client.
describe('the management token', () => {
  afterEach(() => { vi.unstubAllGlobals() })
  const actionId = `action_${'a'.repeat(32)}`
  const team = {
    schemaVersion: 1, revision: 4, editingEnabled: false, editingDisabledReason: 'management_credential_missing', managementCredentialConfigured: false,
    members: [{ email: 'admin@example.com', sourceIds: [] }], adminEmails: ['admin@example.com'], sources: [], teams: [], pendingAction: null, proposedMembers: null, proposedTeams: null,
  }

  it('accepts what setup recorded at its token step, absent, null or one of the two fixed words, and nothing looser', async () => {
    for (const choice of [{}, { managementCredentialChoice: null }, { managementCredentialChoice: 'skipped' }, { managementCredentialChoice: 'provided' }]) {
      vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...team, ...choice })))
      expect(await new HttpGatewayAdminApi().getTeam()).toEqual({ ...team, ...choice })
    }
    for (const managementCredentialChoice of ['held', 'dropped', 'installed', '', 1, true, { choice: 'skipped' }]) {
      vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...team, managementCredentialChoice })))
      await expect(new HttpGatewayAdminApi().getTeam()).rejects.toMatchObject({ code: 'response_invalid' })
    }
  })

  it('prepares the one approval with an empty request and accepts only the prepared-action shape', async () => {
    const prepared = { schemaVersion: 1, actionId, status: 'authorization_required', expiresAt: '2030-01-01T00:00:00.000Z', handoffUrl: `https://manage.example.com/__ankka/operation#${'a'.repeat(40)}` }
    const fetch = vi.fn(async () => Response.json(prepared))
    vi.stubGlobal('fetch', fetch)
    expect(await new HttpGatewayAdminApi().prepareManagementCredentialAction()).toEqual(prepared)
    expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/management-credential/actions', expect.objectContaining({
      method: 'POST', credentials: 'same-origin', redirect: 'error', body: '{"schemaVersion":1}',
    }))
    for (const invalid of [{ status: 'succeeded' }, { managementToken: 'never-returned' }, { handoffUrl: undefined }]) {
      vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...prepared, ...invalid })))
      await expect(new HttpGatewayAdminApi().prepareManagementCredentialAction()).rejects.toMatchObject({ code: 'response_invalid' })
    }
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ schemaVersion: 1, error: 'management_credential_action_conflict' }, { status: 409 })))
    await expect(new HttpGatewayAdminApi().prepareManagementCredentialAction()).rejects.toMatchObject({
      status: 409, code: 'management_credential_action_conflict',
      message: 'Your gateway has an unfinished connector installation, update, removal, Team change or management token change. Finish it, or wait for its approval to expire (ten minutes at most), then try again.',
    })
  })

  it('reads local token presence without accepting credential values or permission claims', async () => {
    const status = { schemaVersion: 1, managementCredentialConfigured: true, managementCredentialChoice: 'provided' }
    const fetch = vi.fn(async () => Response.json(status))
    vi.stubGlobal('fetch', fetch)
    expect(await new HttpGatewayAdminApi().getManagementCredentialStatus()).toEqual(status)
    expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/management-credential/status', expect.objectContaining({
      credentials: 'same-origin', redirect: 'error',
    }))
    for (const invalid of [{ token: 'synthetic-not-a-credential' }, { verified: true },
      { managementCredentialConfigured: 'true' }, { managementCredentialChoice: 'unknown' }]) {
      vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...status, ...invalid })))
      await expect(new HttpGatewayAdminApi().getManagementCredentialStatus()).rejects.toMatchObject({ code: 'response_invalid' })
    }
  })

  it('reads every fixed word of a verification and nothing else', async () => {
    const verified = { schemaVersion: 1, status: 'verified', token: 'active', portals: 'verified', accessPolicies: 'verified' }
    const answers = [
      verified,
      { ...verified, status: 'missing', token: 'missing', portals: 'not_checked', accessPolicies: 'not_checked' },
      { ...verified, status: 'rejected', token: 'rejected', portals: 'not_checked', accessPolicies: 'not_checked' },
      { ...verified, status: 'busy', token: 'not_checked', portals: 'not_checked', accessPolicies: 'not_checked' },
      { ...verified, status: 'unconfirmed', token: 'unconfirmed', portals: 'not_checked', accessPolicies: 'not_checked' },
      { ...verified, status: 'permission_missing', portals: 'permission_missing' },
      { ...verified, status: 'permission_missing', accessPolicies: 'permission_missing' },
      { ...verified, status: 'drift', portals: 'drift', accessPolicies: 'unconfirmed' },
    ]
    for (const answer of answers) {
      const fetch = vi.fn(async () => Response.json(answer))
      vi.stubGlobal('fetch', fetch)
      expect(await new HttpGatewayAdminApi().verifyManagementAccess()).toEqual(answer)
      expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/management-credential/verify', expect.objectContaining({
        method: 'POST', credentials: 'same-origin', redirect: 'error', body: '{"schemaVersion":1}',
      }))
    }
    for (const invalid of [{ status: 'ok' }, { token: 'valid' }, { portals: 'write_verified' }, { accessPolicies: null }, { providerDetail: 'private' }, { portals: undefined }]) {
      vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...verified, ...invalid })))
      await expect(new HttpGatewayAdminApi().verifyManagementAccess()).rejects.toMatchObject({ code: 'response_invalid' })
    }
  })

  it('reads an open token change as the action that blocks the others', async () => {
    const pointer = { kind: 'management_credential', actionId }
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ schemaVersion: 1, actions: [], blockingAction: pointer })))
    expect((await new HttpGatewayAdminApi().getSourceActions()).blockingAction).toEqual(pointer)
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ schemaVersion: 1, error: 'source_action_conflict', reason: 'lifecycle_pending', action: pointer }, { status: 409 })))
    await expect(new HttpGatewayAdminApi().prepareSourceAction(1, 'source-1111111111111111')).rejects.toMatchObject({ reason: 'lifecycle_pending', action: pointer })
  })

  it('points every refusal about the token at Settings, the one place that adds or replaces it', async () => {
    for (const [code, wording] of [
      ['management_credential_required', 'Add a valid management token in Settings before installing connectors.'],
      ['team_management_credential_missing', 'Add your management token in Settings, then retry.'],
      ['team_management_credential_invalid', 'Cloudflare rejected the management token. Verify management access in Settings to see what is missing, or replace the token there.'],
    ] as const) {
      expect(new GatewayApiError(409, code).message).toBe(wording)
      expect(new GatewayApiError(409, code).message).not.toMatch(/Variables and Secrets|in Cloudflare Settings|wrangler/u)
    }
  })
})

describe('connector provider authorization', () => {
  afterEach(() => vi.unstubAllGlobals())
  it('binds authorization to the current action and draft revision', async () => {
    const result = { schemaVersion: 1, authorizationUrl: 'https://identity.example.net/authorize?state=synthetic', expiresAt: '2026-09-19T12:05:00Z' }
    const fetcher = vi.fn(async () => Response.json(result))
    vi.stubGlobal('fetch', fetcher)
    await expect(new HttpGatewayAdminApi().authorizeSource('action_' + 'a'.repeat(32), 4, 'source-synthetic')).resolves.toEqual(result)
    expect(fetcher).toHaveBeenCalledWith('/api/source-actions/action_' + 'a'.repeat(32) + '/authorize', expect.objectContaining({
      method: 'POST', credentials: 'same-origin', redirect: 'error', body: JSON.stringify({ schemaVersion: 1, revision: 4, sourceId: 'source-synthetic' }),
    }))
  })
  it('refuses navigation to unsafe authorization URLs or a response containing credentials', async () => {
    for (const authorizationUrl of ['not a URL', 'javascript:alert(1)', 'http://identity.example.net/authorize', 'https://private@identity.example.net/authorize', 'https://identity.example.net/authorize#private']) {
      vi.stubGlobal('fetch', vi.fn(async () => Response.json({ schemaVersion: 1, authorizationUrl, expiresAt: '2026-09-19T12:05:00Z' })))
      await expect(new HttpGatewayAdminApi().authorizeSource('action_' + 'a'.repeat(32), 4, 'source-synthetic')).rejects.toMatchObject({ code: 'response_invalid' })
    }
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ schemaVersion: 1, authorizationUrl: 'https://identity.example.net/authorize', expiresAt: '2026-09-19T12:05:00Z', access_token: 'synthetic-unexpected-token' })))
    await expect(new HttpGatewayAdminApi().authorizeSource('action_' + 'a'.repeat(32), 4, 'source-synthetic')).rejects.toMatchObject({ code: 'response_invalid' })
  })
})

describe('individual connector removal', () => {
  it('sends only the reviewed revision to the exact same-origin connector endpoint', async () => {
    const result = { schemaVersion: 1, revision: 8, applyMode: 'account_token', installationEnabled: true,
      removalEnabled: true, removalCredentialConfigured: true, pendingRemoval: null, sources: [] }
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(result)))
    await expect(new HttpGatewayAdminApi().removeSource(7, 'source-1111111111111111')).resolves.toEqual(result)
    expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/sources/source-1111111111111111', expect.objectContaining({
      method: 'DELETE', body: JSON.stringify({ schemaVersion: 1, revision: 7 }), credentials: 'same-origin', redirect: 'error',
    }))
  })
})
