import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GatewayApiError, SOURCE_ADDITION_PAUSED_MESSAGE, type GatewayAdminApi, type GatewayStatus, type ManagedSources, type RuntimeUpdate, type SourceActions, type SourceActionSummary, type SourceDiscovery } from '../api'
import { SYNTHETIC_SOURCE_CATALOG } from '../catalog/fixtures'
import { GatewayProvider } from '../GatewayContext'
import { SourcesPage } from './SourcesPage'

const status: GatewayStatus = {
  schemaVersion: 1, status: 'ready', controlPlaneOrigin: 'https://deploy.ankka.ai', release: 'gateway-v1.0.0',
  gateway: { name: 'Gateway', hostname: 'mcp.example.com', mcpUrl: 'https://mcp.example.com/mcp', capabilityMode: 'read_only', codeMode: 'default_on' },
  source: null, access: { administratorCount: 1, memberCount: 0 }, updatedAt: '2026-08-27T12:00:00.000Z',
}
const sources: ManagedSources = { schemaVersion: 1, revision: 4, applyMode: 'oauth_per_action', installationEnabled: true, sources: [] }
const update: RuntimeUpdate = { schemaVersion: 1, channel: 'stable', status: 'up_to_date', current: { release: 'gateway-v1.0.0', artifactSha256: 'a'.repeat(64) }, available: null, rollback: { available: false } }

const draft = { id: 'source-2222222222222222', label: 'Read-only warehouse', url: 'https://warehouse.example.com/mcp', authMode: 'none' as const, onBehalfOfUser: false, enabledTools: ['datasets.list', 'tables.list', 'tables.get', 'queries.estimate', 'queries.read'], status: 'draft' as const }

function pendingAction(overrides: Partial<SourceActionSummary> = {}): SourceActionSummary {
  return {
    schemaVersion: 1, actionId: `action_${'a'.repeat(32)}`, sourceId: draft.id,
    status: 'authorization_required', state: 'authorization_required', failureCode: null,
    issuedAt: new Date(Date.now() - 120_000).toISOString(), expiresAt: new Date(Date.now() + 480_000).toISOString(),
    canCancel: true, ...overrides,
  }
}

function actionSnapshot(action: SourceActionSummary): SourceActions {
  return { schemaVersion: 1, actions: [action], blockingAction: action.state === 'succeeded' || action.state === 'failed' ? null : { kind: 'source', actionId: action.actionId, sourceId: action.sourceId } }
}

function actionApi(snapshot: SourceActions): GatewayAdminApi {
  return {
    removeSource: vi.fn(), getBigQuerySetups: vi.fn(async () => ({ schemaVersion: 1 as const, available: false, setups: [] })), prepareBigQuery: vi.fn(), resumeBigQuery: vi.fn(),
    getStatus: vi.fn(async () => status), getSources: vi.fn(async () => ({ ...sources, sources: [draft] })), getUpdate: vi.fn(async () => update),
    getTeam: vi.fn(), prepareTeamAction: vi.fn(), getTeamAction: vi.fn(), cancelTeamAction: vi.fn(),
    discoverSource: vi.fn(), prepareBigQueryRemoval: vi.fn(), removeSourceDraft: vi.fn(), saveSourceDraft: vi.fn(), prepareSourceAction: vi.fn(), getSourceActions: vi.fn(async () => snapshot), getSourceAction: vi.fn(), cancelSourceAction: vi.fn(), getSourceActionTools: vi.fn(), authorizeSource: vi.fn<GatewayAdminApi['authorizeSource']>(), chooseSourceActionTools: vi.fn(),
    prepareRuntimeAction: vi.fn(), getRuntimeAction: vi.fn(), prepareTeardownAction: vi.fn(), getTeardownAction: vi.fn(),
    getManagementCredentialStatus: vi.fn(), prepareManagementCredentialAction: vi.fn(), verifyManagementAccess: vi.fn(),
  }
}

describe('source installation recovery', () => {
  afterEach(cleanup)

  it('removes a failed BigQuery setup and its status card without starting another authorization', async () => {
    const user = userEvent.setup()
    const action = pendingAction({ state: 'failed', status: 'failed', canCancel: false,
      failureCode: 'bigquery_google_auth_http_400' })
    let removed = false
    const api = actionApi(actionSnapshot(action))
    api.getSources = vi.fn(async () => ({ ...sources, revision: removed ? 5 : 4,
      installationEnabled: false, sources: removed ? [] : [draft] }))
    api.getSourceActions = vi.fn(async () => removed
      ? { schemaVersion: 1 as const, actions: [], blockingAction: null } : actionSnapshot(action))
    api.getBigQuerySetups = vi.fn(async () => ({ schemaVersion: 1 as const, available: true,
      setups: removed ? [] : [{ sourceId: draft.id, actionId: action.actionId, ready: false,
        credentialRequired: true, recoveryRequired: false }] }))
    api.removeSourceDraft = vi.fn(async () => {
      removed = true
      return api.getSources()
    })
    const page = render(<GatewayProvider api={api}><SourcesPage /></GatewayProvider>)
    const card = await screen.findByRole('article', { name: `Installation of ${draft.label}` })
    await user.click(within(card).getByRole('button', { name: 'Remove source' }))
    await waitFor(() => expect(screen.queryByRole('article')).not.toBeInTheDocument())
    expect(api.removeSourceDraft).toHaveBeenCalledExactlyOnceWith(4, draft.id)
    expect(screen.getByText('Source removed.')).toBeVisible()
    expect(screen.queryByRole('button', { name: draft.label })).not.toBeInTheDocument()
    expect(api.prepareSourceAction).not.toHaveBeenCalled()
    expect(api.resumeBigQuery).not.toHaveBeenCalled()
    expect(api.cancelSourceAction).not.toHaveBeenCalled()
    page.unmount()
    render(<GatewayProvider api={api}><SourcesPage /></GatewayProvider>)
    await screen.findByText('No sources yet')
    expect(screen.queryByText('BigQuery setup failed')).not.toBeInTheDocument()
  })

  it('offers removal for both an empty failed draft and a bridge waiting for recovery', async () => {
    const user = userEvent.setup()
    const failed = pendingAction({ state: 'failed', status: 'failed', canCancel: false,
      failureCode: 'bigquery_google_query_rejected' })
    const other = { ...draft, id: 'source-3333333333333333', label: 'BigQuery bridge' }
    const recovery = pendingAction({ actionId: `action_${'b'.repeat(32)}`, sourceId: other.id,
      state: 'recovery_required', status: 'recovery_required', canCancel: false, canRenew: true,
      failureCode: 'source_discovery_failed' })
    const api = actionApi({ ...actionSnapshot(recovery), actions: [failed, recovery] })
    api.getSources = vi.fn(async () => ({ ...sources, sources: [draft, other] }))
    api.getBigQuerySetups = vi.fn(async () => ({ schemaVersion: 1 as const, available: true,
      setups: [failed, recovery].map(action => ({ sourceId: action.sourceId, actionId: action.actionId,
        ready: action === recovery, credentialRequired: action === failed, recoveryRequired: false })) }))
    api.removeSourceDraft = vi.fn().mockResolvedValue({ ...sources, revision: 5, sources: [other] })
    api.prepareBigQueryRemoval = vi.fn().mockRejectedValue(new GatewayApiError(409, 'source_removal_unverified'))
    render(<GatewayProvider api={api}><SourcesPage /></GatewayProvider>)
    const first = await screen.findByRole('article', { name: `Installation of ${draft.label}` })
    const second = await screen.findByRole('article', { name: `Installation of ${other.label}` })
    await waitFor(() => expect(within(second).getByRole('button', { name: 'Remove source' })).toBeEnabled())
    expect(within(second).getByText(/no Google key upload is needed/)).toBeVisible()
    await user.click(within(first).getByRole('button', { name: 'Remove source' }))
    expect(api.removeSourceDraft).toHaveBeenCalledExactlyOnceWith(4, draft.id)
    await user.click(within(second).getByRole('button', { name: 'Remove source' }))
    await waitFor(() => expect(api.prepareBigQueryRemoval).toHaveBeenCalledExactlyOnceWith(5, other.id))
    expect(api.removeSourceDraft).toHaveBeenCalledTimes(1)
    expect(api.resumeBigQuery).not.toHaveBeenCalled()
    expect(api.prepareSourceAction).not.toHaveBeenCalled()
  })

  it('offers only continued cleanup after an interrupted bridge removal', async () => {
    const user = userEvent.setup()
    const action = pendingAction({ state: 'recovery_required', status: 'recovery_required',
      canCancel: false, canRenew: false, failureCode: 'source_removal_required' })
    const api = actionApi(actionSnapshot(action))
    api.getBigQuerySetups = vi.fn(async () => ({ schemaVersion: 1 as const, available: true,
      setups: [{ sourceId: draft.id, actionId: action.actionId, ready: true,
        credentialRequired: false, recoveryRequired: false }] }))
    api.prepareBigQueryRemoval = vi.fn().mockRejectedValue(new GatewayApiError(409, 'source_removal_unverified'))
    render(<GatewayProvider api={api}><SourcesPage /></GatewayProvider>)
    await user.click(await screen.findByRole('button', { name: 'Continue removal' }))
    expect(api.prepareBigQueryRemoval).toHaveBeenCalledExactlyOnceWith(4, draft.id)
    expect(screen.queryByRole('button', { name: 'Resume installation' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Continue BigQuery setup' })).not.toBeInTheDocument()
  })

  it('removes an unused draft from its source details', async () => {
    const user = userEvent.setup()
    const api = actionApi({ schemaVersion: 1, actions: [], blockingAction: null })
    api.removeSourceDraft = vi.fn().mockRejectedValue(new GatewayApiError(409, 'source_conflict'))
    render(<GatewayProvider api={api}><SourcesPage /></GatewayProvider>)
    await user.click(await screen.findByRole('button', { name: draft.label }))
    await user.click(screen.getByRole('button', { name: 'Remove source' }))
    await waitFor(() => expect(api.removeSourceDraft).toHaveBeenCalledExactlyOnceWith(4, draft.id))
    expect(screen.getByRole('button', { name: draft.label })).toBeVisible()
  })

  it('discovers slow consent in a fresh page without a return URL and blocks another Apply', async () => {
    const user = userEvent.setup()
    const action = pendingAction()
    const api = actionApi(actionSnapshot(action))
    render(<GatewayProvider api={api}><SourcesPage /></GatewayProvider>)
    const card = await screen.findByRole('article', { name: `Installation of ${draft.label}` })
    expect(within(card).getByText('Waiting for Cloudflare')).toBeVisible()
    expect(within(card).getByText(`Action: ${action.actionId}`)).toBeVisible()
    expect(card.querySelectorAll('time')).toHaveLength(2)
    expect(screen.queryByText('Saved draft')).not.toBeInTheDocument()
    const apply = screen.getByRole('button', { name: 'Install source' })
    expect(apply).toBeDisabled()
    await user.click(apply)
    expect(api.prepareSourceAction).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Check status' }))
    expect(api.getSourceActions).toHaveBeenCalledTimes(2)
  })

  it('requires server-authorized cancellation before restarting a definitely-unstarted expired attempt', async () => {
    const user = userEvent.setup()
    const action = pendingAction({ state: 'authorization_expired', expiresAt: new Date(Date.now() - 1_000).toISOString() })
    let current = actionSnapshot(action)
    const api = actionApi(current)
    api.getSourceActions = vi.fn(async () => current)
    api.cancelSourceAction = vi.fn(async () => {
      const cancelled = { ...action, state: 'failed' as const, status: 'failed' as const, failureCode: 'source_action_denied', canCancel: false }
      current = actionSnapshot(cancelled)
      return cancelled
    })
    render(<GatewayProvider api={api}><SourcesPage /></GatewayProvider>)
    const card = await screen.findByRole('article', { name: `Installation of ${draft.label}` })
    expect(within(card).getByText('Authorization expired before work began')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Install source' })).toBeDisabled()
    await user.click(within(card).getByRole('button', { name: 'Cancel installation' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Install source' })).toBeEnabled())
    expect(api.cancelSourceAction).toHaveBeenCalledWith(action.actionId)
    expect(api.prepareSourceAction).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Cancel installation' })).not.toBeInTheDocument()
  })

  it.each(['applying', 'recovery_required'] as const)('never offers restart for %s work, even beyond expiry', async (state) => {
    const action = pendingAction({ state, status: state, canCancel: false, expiresAt: new Date(Date.now() - 1_000).toISOString() })
    const api = actionApi(actionSnapshot(action))
    render(<GatewayProvider api={api}><SourcesPage /></GatewayProvider>)
    const card = await screen.findByRole('article', { name: `Installation of ${draft.label}` })
    expect(within(card).getByText(state === 'applying' ? 'Applying and verifying' : 'Recovery required')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Install source' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Cancel installation' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Resume installation' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Remove source' })).not.toBeInTheDocument()
    expect(screen.queryByText(/nothing changed|start a fresh authorization/i)).not.toBeInTheDocument()
  })

  it('renews only the server-approved recorded action while ordinary Apply remains blocked', async () => {
    const user = userEvent.setup()
    const action = pendingAction({ state: 'recovery_required', status: 'recovery_required', canCancel: false, canRenew: true })
    const api = actionApi(actionSnapshot(action))
    api.prepareSourceAction = vi.fn().mockRejectedValue(new GatewayApiError(409, 'source_action_conflict'))
    render(<GatewayProvider api={api}><SourcesPage /></GatewayProvider>)
    const renew = await screen.findByRole('button', { name: 'Resume installation' })
    expect(screen.getByRole('button', { name: 'Install source' })).toBeDisabled()
    await user.click(renew)
    await waitFor(() => expect(api.prepareSourceAction).toHaveBeenCalledExactlyOnceWith(sources.revision, draft.id, action.actionId))
    expect(api.cancelSourceAction).not.toHaveBeenCalled()
  })

  it('rechecks renewal eligibility after clicking a stale recovery page', async () => {
    const user = userEvent.setup()
    const action = pendingAction({ state: 'recovery_required', status: 'recovery_required', canCancel: false, canRenew: true })
    const api = actionApi(actionSnapshot(action))
    api.getSourceActions = vi.fn().mockResolvedValueOnce(actionSnapshot(action))
      .mockResolvedValue(actionSnapshot({ ...action, canRenew: false }))
    render(<GatewayProvider api={api}><SourcesPage /></GatewayProvider>)
    await user.click(await screen.findByRole('button', { name: 'Resume installation' }))
    await waitFor(() => expect(api.getSourceActions).toHaveBeenCalledTimes(2))
    expect(api.prepareSourceAction).not.toHaveBeenCalled()
    expect(api.cancelSourceAction).not.toHaveBeenCalled()
  })

  it.each([
    ['source_connection_required', 'Connect your source'],
    ['source_sync_required', 'Sync source tools'],
    ['source_tools_mismatch', 'Review source tools'],
  ])('explains %s and links the recorded source without offering a new installation', async (failureCode, label) => {
    const connectionUrl = `https://dash.cloudflare.com/${'1'.repeat(32)}/one/access-controls/ai-controls/mcp-server/edit/synthetic-source`
    const action = pendingAction({ state: 'recovery_required', status: 'recovery_required',
      canCancel: false, canRenew: true, failureCode, connectionUrl })
    const api = actionApi(actionSnapshot(action))
    render(<GatewayProvider api={api}><SourcesPage /></GatewayProvider>)
    const card = await screen.findByRole('article', { name: `Installation of ${draft.label}` })
    expect(within(card).getByText(label)).toBeVisible()
    expect(within(card).getByRole('link', { name: 'Open source in Cloudflare' })).toHaveAttribute('href', connectionUrl)
    expect(within(card).getByRole('button', { name: 'Resume installation' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Install source' })).toBeDisabled()
    expect(screen.queryByText('Recovery required')).not.toBeInTheDocument()
    expect(api.prepareSourceAction).not.toHaveBeenCalled()
  })

  it('does not offer cancellation to a different administrator', async () => {
    const api = actionApi(actionSnapshot(pendingAction({ canCancel: false })))
    render(<GatewayProvider api={api}><SourcesPage /></GatewayProvider>)
    await screen.findByText(/Only the administrator who started/)
    expect(screen.queryByRole('button', { name: 'Cancel installation' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Install source' })).toBeDisabled()
  })

  it('reconciles a late successful installation on Check status instead of offering a second install', async () => {
    const user = userEvent.setup()
    const action = pendingAction()
    let completed = false
    const api = actionApi(actionSnapshot(action))
    api.getSourceActions = vi.fn(async () => actionSnapshot(completed ? { ...action, state: 'succeeded', status: 'succeeded', canCancel: false } : action))
    api.getSources = vi.fn(async (): Promise<ManagedSources> => ({ ...sources, revision: completed ? 5 : 4, sources: [{ ...draft, status: completed ? 'installed' : 'draft' }] }))
    render(<GatewayProvider api={api}><SourcesPage /></GatewayProvider>)
    await screen.findByRole('article', { name: `Installation of ${draft.label}` })
    completed = true
    await user.click(screen.getByRole('button', { name: 'Check status' }))
    const sourceRow = await within(screen.getByRole('table', { name: 'Source list' }))
      .findByRole('row', { name: new RegExp(`${draft.label} Public Installed`, 'u') })
    expect(within(sourceRow).getByText('Installed')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Install source' })).not.toBeInTheDocument()
    expect(api.prepareSourceAction).not.toHaveBeenCalled()
  })

  it('names a different pending source and blocks all draft Apply buttons', async () => {
    const other = { ...draft, id: 'source-3333333333333333', label: 'Company knowledge' }
    const api = actionApi(actionSnapshot(pendingAction({ sourceId: other.id })))
    api.getSources = vi.fn(async () => ({ ...sources, sources: [draft, other] }))
    render(<GatewayProvider api={api}><SourcesPage /></GatewayProvider>)
    await screen.findByRole('article', { name: `Installation of ${other.label}` })
    for (const button of screen.getAllByRole('button', { name: 'Install source' })) expect(button).toBeDisabled()
  })

  it('identifies an unrelated lifecycle action without suggesting cancellation', async () => {
    const api = actionApi({ schemaVersion: 1, actions: [], blockingAction: { kind: 'runtime', actionId: `action_${'b'.repeat(32)}` } })
    render(<GatewayProvider api={api}><SourcesPage /></GatewayProvider>)
    await screen.findByText(/update or rollback action is blocking/)
    expect(screen.getByRole('button', { name: 'Install source' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Cancel installation' })).not.toBeInTheDocument()
  })

  it('keeps Apply blocked when status cannot be read and allows an explicit retry', async () => {
    const user = userEvent.setup()
    const api = actionApi({ schemaVersion: 1, actions: [], blockingAction: null })
    api.getSourceActions = vi.fn().mockRejectedValueOnce(new GatewayApiError(503, 'source_actions_unavailable')).mockResolvedValue({ schemaVersion: 1, actions: [], blockingAction: null })
    render(<GatewayProvider api={api}><SourcesPage /></GatewayProvider>)
    await screen.findByText(/Applying sources is disabled until status can be checked/)
    expect(screen.getByRole('button', { name: 'Install source' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Check status' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Install source' })).toBeEnabled())
  })
})

describe('SourcesPage', () => {
  afterEach(cleanup)

  it.each([false, true])('disables source addition and draft application while retaining existing sources (empty=%s)', async (empty) => {
    const user = userEvent.setup()
    const current: ManagedSources = {
      ...sources, installationEnabled: false,
      sources: empty ? [] : [
        { id: 'source-1111111111111111', label: 'Installed knowledge', url: 'https://knowledge.example.com/mcp', authMode: 'oauth', onBehalfOfUser: false, enabledTools: ['search'], status: 'installed' },
        { id: 'source-2222222222222222', label: 'Retained draft', url: 'https://draft.example.com/mcp', authMode: 'none', onBehalfOfUser: false, enabledTools: ['get_product'], status: 'draft' },
      ],
    }
    const api: GatewayAdminApi = {
      removeSource: vi.fn(), getBigQuerySetups: vi.fn(async () => ({ schemaVersion: 1 as const, available: false, setups: [] })), prepareBigQuery: vi.fn(), resumeBigQuery: vi.fn(),
      getStatus: vi.fn(async () => status), getSources: vi.fn(async () => current), getUpdate: vi.fn(async () => update),
      getTeam: vi.fn(), prepareTeamAction: vi.fn(), getTeamAction: vi.fn(), cancelTeamAction: vi.fn(),
      discoverSource: vi.fn(), prepareBigQueryRemoval: vi.fn(), removeSourceDraft: vi.fn(), saveSourceDraft: vi.fn(), prepareSourceAction: vi.fn(), getSourceActions: vi.fn(async () => ({ schemaVersion: 1 as const, actions: [], blockingAction: null })), getSourceAction: vi.fn(), cancelSourceAction: vi.fn(), getSourceActionTools: vi.fn(), authorizeSource: vi.fn<GatewayAdminApi['authorizeSource']>(), chooseSourceActionTools: vi.fn(),
      prepareRuntimeAction: vi.fn(), getRuntimeAction: vi.fn(), prepareTeardownAction: vi.fn(), getTeardownAction: vi.fn(),
    getManagementCredentialStatus: vi.fn(), prepareManagementCredentialAction: vi.fn(), verifyManagementAccess: vi.fn(),
    }
    render(<GatewayProvider api={api}><SourcesPage /></GatewayProvider>)
    expect(await screen.findByText(`${SOURCE_ADDITION_PAUSED_MESSAGE} Saved drafts are retained but cannot be applied.`)).toBeInTheDocument()
    const add = screen.getByRole('button', { name: 'Add source' })
    expect(add).toBeDisabled()
    await user.click(add)
    expect(screen.queryByRole('textbox', { name: 'MCP URL' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Install source' })).not.toBeInTheDocument()
    if (empty) {
      expect(screen.getByRole('button', { name: 'Add your first source' })).toBeDisabled()
    } else {
      expect(screen.getByText('Installed knowledge')).toBeInTheDocument()
      await user.click(screen.getByRole('button', { name: 'Installed knowledge' }))
      expect(screen.getByText('Operator-connected OAuth')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Installation unavailable' })).toBeDisabled()
      expect(screen.getByText('search')).toBeVisible()
      expect(screen.getByText('Retained draft')).toBeInTheDocument()
    }
    expect(api.discoverSource).not.toHaveBeenCalled()
    expect(api.saveSourceDraft).not.toHaveBeenCalled()
    expect(api.prepareSourceAction).not.toHaveBeenCalled()
  })

  it.each([true, false])('leads a gateway without its management token to the one way of adding it (empty=%s)', async (empty) => {
    const user = userEvent.setup()
    // jsdom follows a fragment, not a navigation: stand on the operation page so the handoff is observable.
    window.history.replaceState(null, '', '/__ankka/operation')
    const current: ManagedSources = { ...sources, applyMode: 'account_token', installationEnabled: false, sources: empty ? [] : [draft] }
    const prepared = { schemaVersion: 1 as const, actionId: `action_${'m'.repeat(32)}`, status: 'authorization_required' as const, expiresAt: '2030-01-01T00:00:00.000Z', handoffUrl: `${window.location.origin}/__ankka/operation#${'a'.repeat(40)}` }
    const api: GatewayAdminApi = {
      ...actionApi({ schemaVersion: 1, actions: [], blockingAction: null }),
      getSources: vi.fn(async () => current),
      getTeam: vi.fn(async () => ({
        schemaVersion: 1 as const, revision: 1, editingEnabled: false, editingDisabledReason: 'management_credential_missing' as const,
        managementCredentialConfigured: false, managementCredentialChoice: 'provided' as const, members: [], adminEmails: ['admin@example.com'],
        sources: [], pendingAction: null, proposedMembers: null,
      })),
      prepareManagementCredentialAction: vi.fn(async () => prepared),
    }
    render(<GatewayProvider api={api}><SourcesPage /></GatewayProvider>)
    const card = (await screen.findByRole('heading', { name: 'Add your management token' })).closest('section')
    expect(card).toHaveTextContent('Your gateway needs one Cloudflare API token of its own to add sources and change team access, because every approval you give it is temporary.')
    expect(card).toHaveTextContent('Cloudflare cannot limit this token to your gateway: it can edit every Access policy in your account, and it never passes through anything Ankka hosts.')
    expect(card).toHaveTextContent('You pasted a token during setup, but your gateway lost it before it could be saved. It kept nothing of it, so the token has to be added again.')
    expect(screen.getByText('Saved drafts are retained. They can be installed once your gateway has the token.')).toBeVisible()
    // The card replaces the sentence that sent people to Settings; nothing is installable meanwhile.
    expect(screen.queryByRole('link', { name: 'Settings' })).not.toBeInTheDocument()
    expect(screen.queryByText(/Saved drafts are retained but cannot be applied/u)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add source' })).toBeDisabled()
    if (empty) expect(screen.getByText('Your gateway needs its management token before it can install a source.')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Add management token' }))
    expect(api.prepareManagementCredentialAction).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(window.location.hash).toBe(`#${'a'.repeat(40)}`))
    window.history.replaceState(null, '', '/')
  })

  it('keeps the token card for a missing token only: a token it cannot read points to Settings, and a gateway that installs asks nothing', async () => {
    const current: ManagedSources = { ...sources, applyMode: 'account_token', installationEnabled: false, sources: [draft] }
    const unreadable: GatewayAdminApi = {
      ...actionApi({ schemaVersion: 1, actions: [], blockingAction: null }),
      getSources: vi.fn(async () => current), getTeam: vi.fn(async () => { throw new GatewayApiError(503, 'team_unavailable') }),
    }
    render(<GatewayProvider api={unreadable}><SourcesPage /></GatewayProvider>)
    expect(await screen.findByText(/Source installation needs a working management token\. Check it in/u)).toBeVisible()
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/settings')
    expect(screen.queryByRole('heading', { name: 'Add your management token' })).not.toBeInTheDocument()
    cleanup()

    const installing = actionApi({ schemaVersion: 1, actions: [], blockingAction: null })
    render(<GatewayProvider api={installing}><SourcesPage /></GatewayProvider>)
    expect(await screen.findByRole('button', { name: 'Add source' })).toBeEnabled()
    expect(installing.getTeam).not.toHaveBeenCalled()
  })

  it('reads its sources again when the token arrived after the dashboard loaded, instead of calling installation paused', async () => {
    const disabled: ManagedSources = { ...sources, applyMode: 'account_token', installationEnabled: false, sources: [draft] }
    const api: GatewayAdminApi = {
      ...actionApi({ schemaVersion: 1, actions: [], blockingAction: null }),
      getSources: vi.fn<GatewayAdminApi['getSources']>().mockResolvedValueOnce(disabled).mockResolvedValue({ ...disabled, installationEnabled: true }),
      getTeam: vi.fn(async () => ({
        schemaVersion: 1 as const, revision: 1, editingEnabled: true, editingDisabledReason: null, managementCredentialConfigured: true,
        members: [], adminEmails: ['admin@example.com'], sources: [], pendingAction: null, proposedMembers: null,
      })),
    }
    render(<GatewayProvider api={api}><SourcesPage /></GatewayProvider>)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add source' })).toBeEnabled())
    expect(api.getSources).toHaveBeenCalledTimes(2)
    expect(screen.queryByText(/temporarily unavailable/u)).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Add your management token' })).not.toBeInTheDocument()
  })

  it('names an open token change as what source installation waits for', async () => {
    const pointer = { kind: 'management_credential' as const, actionId: `action_${'m'.repeat(32)}` }
    render(<GatewayProvider api={actionApi({ schemaVersion: 1, actions: [], blockingAction: pointer })}><SourcesPage /></GatewayProvider>)
    expect(await screen.findByText(/A gateway management token action is blocking source installation\./u)).toBeVisible()
    expect(screen.getByRole('button', { name: 'Install source' })).toBeDisabled()
  })

  it('shows the protected BigQuery catalogue but blocks connection and keeps all tools unselected', async () => {
    const user = userEvent.setup()
    const saveSourceDraft = vi.fn()
    const api: GatewayAdminApi = {
      removeSource: vi.fn(), getBigQuerySetups: vi.fn(async () => ({ schemaVersion: 1 as const, available: false, setups: [] })), prepareBigQuery: vi.fn(), resumeBigQuery: vi.fn(),
      getStatus: vi.fn(async () => status),
      getTeam: vi.fn(), prepareTeamAction: vi.fn(), getTeamAction: vi.fn(), cancelTeamAction: vi.fn(), getSources: vi.fn(async () => sources), getUpdate: vi.fn(async () => update),
      discoverSource: vi.fn(async (url): Promise<SourceDiscovery> => ({
        schemaVersion: 1, status: 'authorization_required', endpoint: url, protocolVersion: '2026-07-28',
        authentication: 'oauth', connectionBlock: 'source_google_shared_oauth_unsupported',
        tools: [
          { name: 'execute_sql_readonly', description: 'Synthetic read query.', readOnlyHint: true, defaultSelected: true },
          { name: 'execute_sql', description: 'Synthetic write query.', destructiveHint: true, defaultSelected: false },
        ],
      })),
      prepareBigQueryRemoval: vi.fn(), removeSourceDraft: vi.fn(), saveSourceDraft, prepareSourceAction: vi.fn(), getSourceActions: vi.fn(async () => ({ schemaVersion: 1 as const, actions: [], blockingAction: null })), getSourceAction: vi.fn(), cancelSourceAction: vi.fn(), getSourceActionTools: vi.fn(), authorizeSource: vi.fn<GatewayAdminApi['authorizeSource']>(), chooseSourceActionTools: vi.fn(),
      prepareRuntimeAction: vi.fn(), getRuntimeAction: vi.fn(), prepareTeardownAction: vi.fn(), getTeardownAction: vi.fn(),
    getManagementCredentialStatus: vi.fn(), prepareManagementCredentialAction: vi.fn(), verifyManagementAccess: vi.fn(),
    }
    render(<GatewayProvider api={api}><SourcesPage /></GatewayProvider>)
    await screen.findByText('No sources yet')
    expect(screen.queryByText(/roll ?back|provisioning|runtime release|removing your gateway/iu)).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Add source' }))
    expect(screen.getByText(/New sources start with nobody assigned/)).toBeInTheDocument()
    await user.type(screen.getByLabelText('Source name'), 'GA4 example')
    await user.type(screen.getByLabelText('MCP URL'), 'https://bigquery.googleapis.com/mcp')
    await user.click(screen.getByRole('button', { name: 'Inspect source' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('without an admin credential flow')
    expect(screen.getByText('OAuth protected')).toBeInTheDocument()
    expect(screen.queryByText('Public endpoint')).not.toBeInTheDocument()
    expect(screen.queryByText(/Connect this source as a gateway operator/u)).not.toBeInTheDocument()
    expect(screen.getByText('Synthetic read query.')).toBeInTheDocument()
    for (const checkbox of screen.getAllByRole('checkbox')) expect(checkbox).not.toBeChecked()
    await user.click(screen.getByRole('button', { name: 'Select shown' }))
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeDisabled()
    const form = screen.getByRole('button', { name: 'Save draft' }).closest('form')
    if (!form) throw new Error('Expected source form')
    fireEvent.submit(form)
    expect(saveSourceDraft).not.toHaveBeenCalled()
    expect(api.prepareSourceAction).not.toHaveBeenCalled()
  })

  it('uses a reviewed catalog entry only as a seed for inspection and exact-tool review', async () => {
    const user = userEvent.setup()
    const preset = SYNTHETIC_SOURCE_CATALOG.sources[0]
    const saveSourceDraft = vi.fn(async () => ({ ...sources, revision: 5 }))
    const prepareSourceAction = vi.fn()
    const api: GatewayAdminApi = {
      removeSource: vi.fn(), getBigQuerySetups: vi.fn(async () => ({ schemaVersion: 1 as const, available: false, setups: [] })), prepareBigQuery: vi.fn(), resumeBigQuery: vi.fn(),
      getStatus: vi.fn(async () => status),
      getTeam: vi.fn(), prepareTeamAction: vi.fn(), getTeamAction: vi.fn(), cancelTeamAction: vi.fn(),
      getSources: vi.fn(async () => sources),
      getUpdate: vi.fn(async () => update),
      discoverSource: vi.fn(async (url): Promise<SourceDiscovery> => ({
        schemaVersion: 1,
        status: 'authorization_required',
        endpoint: url,
        protocolVersion: '2026-07-28',
        authentication: 'oauth',
        tools: [],
      })),
      prepareBigQueryRemoval: vi.fn(), removeSourceDraft: vi.fn(), saveSourceDraft,
      prepareSourceAction,
      getSourceActions: vi.fn(async () => ({ schemaVersion: 1 as const, actions: [], blockingAction: null })), getSourceAction: vi.fn(), cancelSourceAction: vi.fn(), getSourceActionTools: vi.fn(), authorizeSource: vi.fn<GatewayAdminApi['authorizeSource']>(), chooseSourceActionTools: vi.fn(),
      prepareRuntimeAction: vi.fn(), getRuntimeAction: vi.fn(),
      prepareTeardownAction: vi.fn(), getTeardownAction: vi.fn(),
    getManagementCredentialStatus: vi.fn(), prepareManagementCredentialAction: vi.fn(), verifyManagementAccess: vi.fn(),
    }

    render(<GatewayProvider api={api}><SourcesPage catalog={SYNTHETIC_SOURCE_CATALOG} /></GatewayProvider>)
    await screen.findByText('No sources yet')
    await user.click(screen.getByRole('button', { name: 'Add source' }))

    await user.click(screen.getByRole('button', { name: 'Custom MCP URL' }))
    expect(screen.getByLabelText('MCP URL')).toHaveValue('')
    await user.click(screen.getByRole('button', { name: /Reviewed catalog/u }))
    expect(screen.queryByLabelText('MCP URL')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: `Select ${preset.displayName}` }))

    expect(screen.getByLabelText('Source name')).toHaveValue(preset.displayName)
    expect(screen.getByLabelText('MCP URL')).toHaveValue(preset.implementation.deployment.url)
    expect(screen.getByLabelText('MCP URL')).toHaveAttribute('readonly')
    expect(screen.getByLabelText('Catalog-recommended tools')).toHaveTextContent('properties.list')
    expect(screen.queryByRole('button', { name: 'Save draft' })).not.toBeInTheDocument()

    expect(screen.getByText(/recommendations are preselected when you choose its tools, after you have connected it/u)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Inspect source' }))
    expect(api.discoverSource).toHaveBeenCalledWith(preset.implementation.deployment.url)
    // A sign-in preset takes the same flow as a custom one: no names are typed or prefilled, and the draft has none.
    expect(await screen.findByText('This source needs sign-in, so its tools can only be listed after you connect it.')).toBeInTheDocument()
    expect(screen.getByText(/The catalog recommends 2 tools for this source\. Those that exist in its real list are preselected when you choose\./u)).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: 'Exact tool names' })).not.toBeInTheDocument()
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Save draft' }))
    expect(saveSourceDraft).toHaveBeenCalledWith(4, {
      label: preset.displayName,
      url: preset.implementation.deployment.url,
      authMode: 'oauth',
      enabledTools: [],
    })
    expect(prepareSourceAction).not.toHaveBeenCalled()
  })

  it('rejects a catalog entry when live inspection finds different authentication', async () => {
    const user = userEvent.setup()
    const preset = SYNTHETIC_SOURCE_CATALOG.sources[0]
    const saveSourceDraft = vi.fn()
    const api: GatewayAdminApi = {
      removeSource: vi.fn(), getBigQuerySetups: vi.fn(async () => ({ schemaVersion: 1 as const, available: false, setups: [] })), prepareBigQuery: vi.fn(), resumeBigQuery: vi.fn(),
      getStatus: vi.fn(async () => status),
      getTeam: vi.fn(), prepareTeamAction: vi.fn(), getTeamAction: vi.fn(), cancelTeamAction: vi.fn(),
      getSources: vi.fn(async () => sources),
      getUpdate: vi.fn(async () => update),
      discoverSource: vi.fn(async (url): Promise<SourceDiscovery> => ({
        schemaVersion: 1,
        status: 'discovered',
        endpoint: url,
        protocolVersion: '2026-07-28',
        authentication: 'none',
        tools: [{ name: 'reports.read', defaultSelected: true }],
      })),
      prepareBigQueryRemoval: vi.fn(), removeSourceDraft: vi.fn(), saveSourceDraft,
      prepareSourceAction: vi.fn(), getSourceActions: vi.fn(async () => ({ schemaVersion: 1 as const, actions: [], blockingAction: null })), getSourceAction: vi.fn(), cancelSourceAction: vi.fn(), getSourceActionTools: vi.fn(), authorizeSource: vi.fn<GatewayAdminApi['authorizeSource']>(), chooseSourceActionTools: vi.fn(),
      prepareRuntimeAction: vi.fn(), getRuntimeAction: vi.fn(),
      prepareTeardownAction: vi.fn(), getTeardownAction: vi.fn(),
    getManagementCredentialStatus: vi.fn(), prepareManagementCredentialAction: vi.fn(), verifyManagementAccess: vi.fn(),
    }

    render(<GatewayProvider api={api}><SourcesPage catalog={SYNTHETIC_SOURCE_CATALOG} /></GatewayProvider>)
    await screen.findByText('No sources yet')
    await user.click(screen.getByRole('button', { name: 'Add source' }))
    await user.click(screen.getByRole('button', { name: `Select ${preset.displayName}` }))
    await user.click(screen.getByRole('button', { name: 'Inspect source' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('authentication no longer matches')
    expect(screen.queryByRole('button', { name: 'Save draft' })).not.toBeInTheDocument()
    expect(saveSourceDraft).not.toHaveBeenCalled()
  })

  it('discovers a catalogue and saves the reviewed exact allowlist', async () => {
    const user = userEvent.setup()
    const saveSourceDraft = vi.fn(async () => ({ ...sources, revision: 5 }))
    const api: GatewayAdminApi = {
      removeSource: vi.fn(), getBigQuerySetups: vi.fn(async () => ({ schemaVersion: 1 as const, available: false, setups: [] })), prepareBigQuery: vi.fn(), resumeBigQuery: vi.fn(),
      getStatus: vi.fn(async () => status),
      getTeam: vi.fn(), prepareTeamAction: vi.fn(), getTeamAction: vi.fn(), cancelTeamAction: vi.fn(),
      getSources: vi.fn(async () => sources),
      getUpdate: vi.fn(async () => update),
      discoverSource: vi.fn(async (url): Promise<SourceDiscovery> => ({
        schemaVersion: 1, status: 'discovered', endpoint: url, protocolVersion: '2026-07-28', authentication: 'none',
        tools: [{ name: 'search', title: 'Search', description: 'Search documents.', readOnlyHint: true, defaultSelected: true }],
      })),
      prepareBigQueryRemoval: vi.fn(), removeSourceDraft: vi.fn(), saveSourceDraft,
      prepareSourceAction: vi.fn(), getSourceActions: vi.fn(async () => ({ schemaVersion: 1 as const, actions: [], blockingAction: null })), getSourceAction: vi.fn(), cancelSourceAction: vi.fn(), getSourceActionTools: vi.fn(), authorizeSource: vi.fn<GatewayAdminApi['authorizeSource']>(), chooseSourceActionTools: vi.fn(),
      prepareRuntimeAction: vi.fn(), getRuntimeAction: vi.fn(),
      prepareTeardownAction: vi.fn(), getTeardownAction: vi.fn(),
    getManagementCredentialStatus: vi.fn(), prepareManagementCredentialAction: vi.fn(), verifyManagementAccess: vi.fn(),
    }

    render(<GatewayProvider api={api}><SourcesPage /></GatewayProvider>)
    await screen.findByText('No sources yet')
    await user.click(screen.getByRole('button', { name: 'Add source' }))
    await user.type(screen.getByLabelText('Source name'), 'Company knowledge')
    await user.type(screen.getByLabelText('MCP URL'), 'https://knowledge.example.com/mcp')
    await user.click(screen.getByRole('button', { name: 'Inspect source' }))
    expect(await screen.findByText('Search documents.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Save draft' }))

    expect(saveSourceDraft).toHaveBeenCalledWith(4, {
      label: 'Company knowledge',
      url: 'https://knowledge.example.com/mcp',
      authMode: 'none',
      enabledTools: ['search'],
    })
  })

  it('clears a successful inspection when a retry fails', async () => {
    const user = userEvent.setup()
    let inspectionCount = 0
    const saveSourceDraft = vi.fn()
    const discoverSource = vi.fn(async (url): Promise<SourceDiscovery> => {
      inspectionCount += 1
      if (inspectionCount > 1) throw new Error('The source could not be reached.')
      return {
        schemaVersion: 1,
        status: 'discovered',
        endpoint: url,
        protocolVersion: '2026-07-28',
        authentication: 'none',
        tools: [{ name: 'search', title: 'Search', description: 'Search documents.', defaultSelected: true }],
      }
    })
    const api: GatewayAdminApi = {
      removeSource: vi.fn(), getBigQuerySetups: vi.fn(async () => ({ schemaVersion: 1 as const, available: false, setups: [] })), prepareBigQuery: vi.fn(), resumeBigQuery: vi.fn(),
      getStatus: vi.fn(async () => status),
      getTeam: vi.fn(), prepareTeamAction: vi.fn(), getTeamAction: vi.fn(), cancelTeamAction: vi.fn(),
      getSources: vi.fn(async () => sources),
      getUpdate: vi.fn(async () => update),
      discoverSource,
      prepareBigQueryRemoval: vi.fn(), removeSourceDraft: vi.fn(), saveSourceDraft,
      prepareSourceAction: vi.fn(), getSourceActions: vi.fn(async () => ({ schemaVersion: 1 as const, actions: [], blockingAction: null })), getSourceAction: vi.fn(), cancelSourceAction: vi.fn(), getSourceActionTools: vi.fn(), authorizeSource: vi.fn<GatewayAdminApi['authorizeSource']>(), chooseSourceActionTools: vi.fn(),
      prepareRuntimeAction: vi.fn(), getRuntimeAction: vi.fn(),
      prepareTeardownAction: vi.fn(), getTeardownAction: vi.fn(),
    getManagementCredentialStatus: vi.fn(), prepareManagementCredentialAction: vi.fn(), verifyManagementAccess: vi.fn(),
    }

    render(<GatewayProvider api={api}><SourcesPage /></GatewayProvider>)
    await screen.findByText('No sources yet')
    await user.click(screen.getByRole('button', { name: 'Add source' }))
    await user.type(screen.getByLabelText('Source name'), 'Company knowledge')
    await user.type(screen.getByLabelText('MCP URL'), 'https://knowledge.example.com/mcp')
    await user.click(screen.getByRole('button', { name: 'Inspect source' }))

    expect(await screen.findByText('Search documents.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Inspect source' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('could not be reached')
    expect(screen.queryByText('Search documents.')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Save draft' })).not.toBeInTheDocument()
    expect(saveSourceDraft).not.toHaveBeenCalled()
  })

  it.each([228, 224])('keeps a %i-tool catalogue filterable and supports bulk exact selection', async (toolCount) => {
    const user = userEvent.setup()
    const toolNames = Array.from(
      { length: toolCount },
      (_, index) => `catalogue_read_${String(index).padStart(3, '0')}`,
    )
    const saveSourceDraft = vi.fn(async (): Promise<ManagedSources> => ({
      ...sources,
      revision: 5,
      sources: [{
        id: 'source-0000000000000000',
        label: 'Large read API',
        url: 'https://catalogue-read.example.com/mcp',
        authMode: 'none',
        onBehalfOfUser: false,
        enabledTools: toolNames,
        status: 'draft',
      }],
    }))
    const api: GatewayAdminApi = {
      removeSource: vi.fn(), getBigQuerySetups: vi.fn(async () => ({ schemaVersion: 1 as const, available: false, setups: [] })), prepareBigQuery: vi.fn(), resumeBigQuery: vi.fn(),
      getStatus: vi.fn(async () => status),
      getTeam: vi.fn(), prepareTeamAction: vi.fn(), getTeamAction: vi.fn(), cancelTeamAction: vi.fn(),
      getSources: vi.fn(async () => sources),
      getUpdate: vi.fn(async () => update),
      discoverSource: vi.fn(async (url): Promise<SourceDiscovery> => ({
        schemaVersion: 1,
        status: 'discovered',
        endpoint: url,
        protocolVersion: '2026-07-28',
        authentication: 'none',
        tools: toolNames.map((name) => ({
          name,
          title: name.replaceAll('_', ' '),
          description: `Synthetic read operation ${name}.`,
          readOnlyHint: true,
          destructiveHint: false,
          defaultSelected: false,
        })),
      })),
      prepareBigQueryRemoval: vi.fn(), removeSourceDraft: vi.fn(), saveSourceDraft,
      prepareSourceAction: vi.fn(), getSourceActions: vi.fn(async () => ({ schemaVersion: 1 as const, actions: [], blockingAction: null })), getSourceAction: vi.fn(), cancelSourceAction: vi.fn(), getSourceActionTools: vi.fn(), authorizeSource: vi.fn<GatewayAdminApi['authorizeSource']>(), chooseSourceActionTools: vi.fn(),
      prepareRuntimeAction: vi.fn(), getRuntimeAction: vi.fn(),
      prepareTeardownAction: vi.fn(), getTeardownAction: vi.fn(),
    getManagementCredentialStatus: vi.fn(), prepareManagementCredentialAction: vi.fn(), verifyManagementAccess: vi.fn(),
    }

    render(<GatewayProvider api={api}><SourcesPage /></GatewayProvider>)
    await screen.findByText('No sources yet')
    await user.click(screen.getByRole('button', { name: 'Add source' }))
    fireEvent.change(screen.getByLabelText('Source name'), { target: { value: 'Large read API' } })
    fireEvent.change(screen.getByLabelText('MCP URL'), {
      target: { value: 'https://catalogue-read.example.com/mcp' },
    })
    await user.click(screen.getByRole('button', { name: 'Inspect source' }))

    expect(await screen.findByText(`Showing ${toolCount} of ${toolCount} tools; 0 selected.`)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Filter tools'), {
      target: { value: `catalogue_read_${String(toolCount - 1).padStart(3, '0')}` },
    })
    expect(screen.getByText(`Showing 1 of ${toolCount} tools; 0 selected.`)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Select shown' }))
    expect(screen.getByText(`Showing 1 of ${toolCount} tools; 1 selected.`)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Clear shown' }))
    expect(screen.getByText(`Showing 1 of ${toolCount} tools; 0 selected.`)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Select shown' }))
    fireEvent.change(screen.getByLabelText('Filter tools'), { target: { value: '' } })
    await user.click(screen.getByRole('button', { name: 'Select shown' }))
    expect(screen.getByText(`Showing ${toolCount} of ${toolCount} tools; ${toolCount} selected.`)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Save draft' }))

    expect(saveSourceDraft).toHaveBeenCalledWith(4, {
      label: 'Large read API',
      url: 'https://catalogue-read.example.com/mcp',
      authMode: 'none',
      enabledTools: toolNames,
    })
    const savedSource = await screen.findByRole('button', { name: 'Large read API' })
    expect(savedSource).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText(`${toolCount} exact tools`)).not.toBeInTheDocument()
    await user.click(savedSource)
    expect(screen.getByText(`${toolCount} exact tools`)).toBeInTheDocument()
  }, 15_000)

  it('says why a sign-in source lists no tools and what happens next, and saves it without any', async () => {
    const user = userEvent.setup()
    const saveSourceDraft = vi.fn(async () => ({ ...sources, revision: 5 }))
    const api: GatewayAdminApi = {
      removeSource: vi.fn(), getBigQuerySetups: vi.fn(async () => ({ schemaVersion: 1 as const, available: false, setups: [] })), prepareBigQuery: vi.fn(), resumeBigQuery: vi.fn(),
      getStatus: vi.fn(async () => status),
      getTeam: vi.fn(), prepareTeamAction: vi.fn(), getTeamAction: vi.fn(), cancelTeamAction: vi.fn(),
      getSources: vi.fn(async () => sources),
      getUpdate: vi.fn(async () => update),
      discoverSource: vi.fn(async (url): Promise<SourceDiscovery> => ({
        schemaVersion: 1,
        status: 'authorization_required',
        endpoint: url,
        protocolVersion: '2026-07-28',
        authentication: 'oauth',
        tools: [],
      })),
      prepareBigQueryRemoval: vi.fn(), removeSourceDraft: vi.fn(), saveSourceDraft,
      prepareSourceAction: vi.fn(), getSourceActions: vi.fn(async () => ({ schemaVersion: 1 as const, actions: [], blockingAction: null })), getSourceAction: vi.fn(), cancelSourceAction: vi.fn(), getSourceActionTools: vi.fn(), authorizeSource: vi.fn<GatewayAdminApi['authorizeSource']>(), chooseSourceActionTools: vi.fn(),
      prepareRuntimeAction: vi.fn(), getRuntimeAction: vi.fn(),
      prepareTeardownAction: vi.fn(), getTeardownAction: vi.fn(),
    getManagementCredentialStatus: vi.fn(), prepareManagementCredentialAction: vi.fn(), verifyManagementAccess: vi.fn(),
    }

    render(<GatewayProvider api={api}><SourcesPage /></GatewayProvider>)
    await screen.findByText('No sources yet')
    await user.click(screen.getByRole('button', { name: 'Add source' }))
    await user.type(screen.getByLabelText('Source name'), 'Protected read API')
    await user.type(screen.getByLabelText('MCP URL'), 'https://protected.example.com/mcp')
    await user.click(screen.getByRole('button', { name: 'Inspect source' }))
    expect(await screen.findByText('This source needs sign-in, so its tools can only be listed after you connect it.')).toBeInTheDocument()
    expect(screen.getByText('OAuth protected')).toBeInTheDocument()
    const next = within(screen.getByLabelText('What happens next')).getAllByRole('listitem').map((item) => item.textContent)
    expect(next).toEqual([
      'Save this draft and install it. The gateway creates the source with nothing enabled and nobody assigned, and does not attach it to your Portal.',
      'Connect the source once in Cloudflare, as a gateway operator. The connection is shared with the team members you later give access; its credential stays in your Cloudflare account.',
      'Come back to this page. It lists the source’s real tools and you choose which to allow. Only those are attached.',
    ])
    // This gateway has nothing a rollback could restore, so saving decides nothing and says nothing about it.
    expect(screen.queryByText(/no longer roll back/u)).not.toBeInTheDocument()
    expect(screen.queryByText(/catalog recommends/u)).not.toBeInTheDocument()
    // One way, no fallback: no name is ever typed.
    expect(screen.queryByRole('textbox', { name: 'Exact tool names' })).not.toBeInTheDocument()
    expect(screen.queryByText(/One exact tool per line/u)).not.toBeInTheDocument()
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    expect(screen.getByText('This draft is saved with no tools. You choose them after connecting the source.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Save draft' }))

    expect(saveSourceDraft).toHaveBeenCalledWith(4, {
      label: 'Protected read API',
      url: 'https://protected.example.com/mcp',
      authMode: 'oauth',
      enabledTools: [],
    })
  })
})

describe('Add BigQuery setup', () => {
  afterEach(cleanup)
  it('shows the retained Google error after a fresh page load and resumes through BigQuery, even with a management token', async () => {
    const user = userEvent.setup()
    const action = pendingAction({ state: 'failed', status: 'failed', canCancel: false,
      failureCode: 'bigquery_google_query_http_403' })
    const api = actionApi(actionSnapshot(action))
    api.getSources = vi.fn(async () => ({ ...sources, applyMode: 'account_token' as const, sources: [draft] }))
    api.getBigQuerySetups = vi.fn(async () => ({ schemaVersion: 1 as const, available: true, setups: [{ sourceId: draft.id,
      actionId: action.actionId, ready: false, credentialRequired: true, recoveryRequired: false }] }))
    api.resumeBigQuery = vi.fn().mockRejectedValue(new GatewayApiError(409, 'bigquery_setup_conflict'))
    const page = render(<GatewayProvider api={api}><SourcesPage /></GatewayProvider>)
    expect(await screen.findByText(/connection check failed \(HTTP 403\)/)).toHaveTextContent('BigQuery Job User and MCP User')
    expect(screen.getByText('Error code: bigquery_google_query_http_403')).toBeVisible()
    expect(screen.queryByText('Waiting for Cloudflare')).not.toBeInTheDocument()
    expect(screen.queryByText(/No new Cloudflare consent/)).not.toBeInTheDocument()
    page.unmount()
    render(<GatewayProvider api={api}><SourcesPage /></GatewayProvider>)
    const card = await screen.findByRole('article', { name: `Installation of ${draft.label}` })
    expect(within(card).getByText('BigQuery setup failed')).toBeVisible()
    await user.click(await screen.findByRole('button', { name: 'Continue BigQuery setup' }))
    await waitFor(() => expect(api.resumeBigQuery).toHaveBeenCalledExactlyOnceWith(action.actionId))
    expect(api.prepareSourceAction).not.toHaveBeenCalled()
  })
  it('explains BigQuery consent separately from ordinary account-token installation', async () => {
    const action = pendingAction()
    const api = actionApi(actionSnapshot(action))
    api.getSources = vi.fn(async () => ({ ...sources, applyMode: 'account_token' as const, sources: [draft] }))
    api.getBigQuerySetups = vi.fn(async () => ({ schemaVersion: 1 as const, available: true, setups: [{ sourceId: draft.id,
      actionId: action.actionId, ready: false, credentialRequired: true, recoveryRequired: false }] }))
    render(<GatewayProvider api={api}><SourcesPage /></GatewayProvider>)
    expect(await screen.findByText(/BigQuery bridge setup needs its own Cloudflare approval/)).toBeVisible()
    expect(screen.queryByText(/No new Cloudflare consent/)).not.toBeInTheDocument()
  })
  it('shows bounded Access failure details and keeps an uncertain creation blocked', async () => {
    const action = { ...pendingAction(), state: 'recovery_required' as const, canCancel: false, canRenew: true,
      failureCode: 'bigquery_setup_required' }
    const api = actionApi(actionSnapshot(action))
    api.getBigQuerySetups = vi.fn(async () => ({ schemaVersion: 1 as const, available: true, setups: [{ sourceId: draft.id,
      actionId: action.actionId, ready: false, credentialRequired: true, recoveryRequired: true,
      pendingResource: 'application' as const, failure: { stage: 'application' as const, httpStatus: 403 } }] }))
    render(<GatewayProvider api={api}><SourcesPage /></GatewayProvider>)
    expect(await screen.findByText(/Cloudflare did not confirm creation of the Access application/)).toBeInTheDocument()
    expect(screen.getByText('Access application request failed (HTTP 403).')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Continue BigQuery setup' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Resume installation' })).not.toBeInTheDocument()
  })
  it('reviews project and dataset access before Cloudflare approval without collecting a key in the draft', async () => {
    const user = userEvent.setup()
    const api = actionApi({ schemaVersion: 1, actions: [], blockingAction: null })
    api.getSources = vi.fn(async () => sources)
    api.getBigQuerySetups = vi.fn(async () => ({ schemaVersion: 1 as const, available: true, setups: [] }))
    api.prepareBigQuery = vi.fn().mockRejectedValue(new GatewayApiError(409, 'bigquery_setup_conflict'))
    render(<GatewayProvider api={api}><SourcesPage /></GatewayProvider>)
    await user.click(await screen.findByRole('button', { name: 'Add BigQuery' }))
    expect(screen.getByRole('button', { name: 'Continue to Cloudflare' })).toBeDisabled()
    expect(screen.queryByLabelText('Google service-account JSON key')).not.toBeInTheDocument()
    await user.type(screen.getByLabelText('Query project ID'), 'query-project')
    await user.type(screen.getByLabelText('Datasets to discover'), 'data-project.reporting')
    await user.click(screen.getByRole('checkbox', { name: /dedicated service account/ }))
    await user.click(screen.getByRole('button', { name: 'Continue to Cloudflare' }))
    await waitFor(() => expect(api.prepareBigQuery).toHaveBeenCalledExactlyOnceWith({ revision: 4, label: 'BigQuery',
      configuration: { queryProjectId: 'query-project', allowedDatasets: [{ projectId: 'data-project', datasetId: 'reporting' }] }, readOnlyConfirmed: true }))
    expect(await screen.findByRole('alert')).toHaveTextContent('existing BigQuery setup')
    expect(api.prepareSourceAction).not.toHaveBeenCalled()
  })
  it('resumes an unfinished bridge using its recorded BigQuery operation', async () => {
    const user = userEvent.setup()
    const action = pendingAction()
    const api = actionApi(actionSnapshot(action))
    api.getBigQuerySetups = vi.fn(async () => ({ schemaVersion: 1 as const, available: true, setups: [{ sourceId: draft.id,
      actionId: action.actionId, ready: false, credentialRequired: true, recoveryRequired: false }] }))
    api.resumeBigQuery = vi.fn().mockRejectedValue(new GatewayApiError(409, 'bigquery_setup_conflict'))
    render(<GatewayProvider api={api}><SourcesPage /></GatewayProvider>)
    await user.click(await screen.findByRole('button', { name: 'Continue BigQuery setup' }))
    await waitFor(() => expect(api.resumeBigQuery).toHaveBeenCalledExactlyOnceWith(action.actionId))
    expect(api.prepareSourceAction).not.toHaveBeenCalled()
  })
})

// The gateway reports `installEndsRollbackTo` only while installing a source really ends a rollback: the gateway was
// updated, the earlier release can still be restored, and the first installation here would change that.
describe('the rollback sentence beside the install control', () => {
  afterEach(cleanup)
  const idle: SourceActions = { schemaVersion: 1, actions: [], blockingAction: null }
  const sentence = 'After this you can no longer roll back to gateway-v0.9.9.'

  it('says so in plain words directly beside Install source, and nowhere else', async () => {
    const api = actionApi(idle)
    api.getSources = vi.fn(async () => ({ ...sources, installEndsRollbackTo: 'gateway-v0.9.9', sources: [draft] }))
    render(<GatewayProvider api={api}><SourcesPage /></GatewayProvider>)
    const install = await screen.findByRole('button', { name: 'Install source' })
    expect(install).toHaveAccessibleDescription(sentence)
    expect(screen.getAllByText(sentence)).toHaveLength(1)
    expect(install.parentElement).toContainElement(screen.getByText(sentence))
    expect(screen.queryByText(/provisioning|runtime release|recover any source action|removing your gateway/iu)).not.toBeInTheDocument()
  })

  it.each([
    ['a fresh install or an older gateway that does not report it', {}],
    ['a gateway whose rollback is already decided or that has nothing to restore', { installEndsRollbackTo: null }],
    ['a gateway that cannot install right now', { installEndsRollbackTo: 'gateway-v0.9.9', installationEnabled: false }],
  ])('stays silent for %s', async (_state, reported) => {
    const api = actionApi(idle)
    api.getSources = vi.fn(async () => ({ ...sources, ...reported, sources: [draft] }))
    render(<GatewayProvider api={api}><SourcesPage /></GatewayProvider>)
    const control = await screen.findByRole('button', { name: /Install source|Installation unavailable/u })
    expect(control).not.toHaveAccessibleDescription()
    expect(screen.queryByText(/roll ?back/iu)).not.toBeInTheDocument()
  })

  it('drops the sentence as soon as the gateway reports that the installation decided it', async () => {
    const user = userEvent.setup()
    const api = actionApi(idle)
    let installed = false
    api.getSources = vi.fn(async (): Promise<ManagedSources> => installed
      ? { ...sources, revision: 5, installEndsRollbackTo: null, sources: [{ ...draft, status: 'installed' }] }
      : { ...sources, installEndsRollbackTo: 'gateway-v0.9.9', sources: [draft] })
    api.prepareSourceAction = vi.fn(async () => {
      installed = true
      return { schemaVersion: 1 as const, actionId: `action_${'c'.repeat(32)}`, status: 'succeeded' as const, expiresAt: new Date(Date.now() + 60_000).toISOString() }
    })
    render(<GatewayProvider api={api}><SourcesPage /></GatewayProvider>)
    expect(await screen.findByText(sentence)).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Install source' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Install source' })).not.toBeInTheDocument())
    expect(screen.queryByText(/roll ?back/iu)).not.toBeInTheDocument()
  })

  it('moves to Resume installation while a recorded installation blocks a new one', async () => {
    const action = pendingAction({ state: 'recovery_required', status: 'recovery_required', canCancel: false, canRenew: true })
    const api = actionApi(actionSnapshot(action))
    api.getSources = vi.fn(async () => ({ ...sources, installEndsRollbackTo: 'gateway-v0.9.9', sources: [draft] }))
    render(<GatewayProvider api={api}><SourcesPage /></GatewayProvider>)
    const resume = await screen.findByRole('button', { name: 'Resume installation' })
    expect(screen.getAllByText(sentence)).toHaveLength(1)
    expect(resume.parentElement).toContainElement(screen.getByText(sentence))
    expect(screen.getByRole('button', { name: 'Install source' })).not.toHaveAccessibleDescription()
  })

  it('says the same before a BigQuery setup continues to Cloudflare', async () => {
    const user = userEvent.setup()
    const api = actionApi(idle)
    api.getSources = vi.fn(async () => ({ ...sources, installEndsRollbackTo: 'gateway-v0.9.9' }))
    api.getBigQuerySetups = vi.fn(async () => ({ schemaVersion: 1 as const, available: true, setups: [] }))
    render(<GatewayProvider api={api}><SourcesPage /></GatewayProvider>)
    await user.click(await screen.findByRole('button', { name: 'Add BigQuery' }))
    const proceed = screen.getByRole('button', { name: 'Continue to Cloudflare' })
    expect(proceed.parentElement).toContainElement(screen.getByText(sentence))
  })
})

describe('individual source removal', () => {
  afterEach(cleanup)

  function removalApi() {
    const api = actionApi({ schemaVersion: 1, actions: [], blockingAction: null })
    let current: ManagedSources = { ...sources, removalEnabled: true, removalCredentialConfigured: true,
      pendingRemoval: null, sources: [{ ...draft, status: 'installed' }] }
    api.getSources = vi.fn(async () => current)
    api.removeSource = vi.fn(async (revision, sourceId) => {
      expect(revision).toBe(current.revision)
      current = { ...current, revision: revision + 1, sources: current.sources.filter((source) => source.id !== sourceId) }
      return current
    })
    return { api, setSources(value: Partial<ManagedSources>) { current = { ...current, ...value } } }
  }

  it('requires confirmation and refreshes the source list after removal', async () => {
    const user = userEvent.setup()
    const { api } = removalApi()
    render(<GatewayProvider api={api}><SourcesPage /></GatewayProvider>)
    await user.click(await screen.findByRole('button', { name: draft.label }))
    const label = 'Remove source'
    await user.click(screen.getByRole('button', { name: label }))
    expect(api.removeSource).not.toHaveBeenCalled()
    expect(screen.getByText(`Remove “${draft.label}” from your gateway?`)).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(api.removeSource).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: label }))
    await user.click(screen.getByRole('button', { name: label }))
    await screen.findByText('No sources yet')
    expect(api.removeSource).toHaveBeenCalledExactlyOnceWith(sources.revision, draft.id)
    expect(screen.getByText('Source removed from your gateway. Its upstream service and data are unchanged.')).toBeVisible()
  })

  it('opens saved removal progress on a fresh page and resumes it', async () => {
    const user = userEvent.setup()
    const { api, setSources } = removalApi()
    setSources({ pendingRemoval: { sourceId: draft.id } })
    api.getSourceActions = vi.fn<GatewayAdminApi['getSourceActions']>(async () => ({ schemaVersion: 1, actions: [],
      blockingAction: { kind: 'source_removal', actionId: `action_${'b'.repeat(32)}`, sourceId: draft.id } }))
    render(<GatewayProvider api={api}><SourcesPage /></GatewayProvider>)
    await user.click(await screen.findByRole('button', { name: 'Continue removal' }))
    await waitFor(() => expect(api.removeSource).toHaveBeenCalledExactlyOnceWith(sources.revision, draft.id))
  })

  it('keeps the source visible and shows recovery after an uncertain response', async () => {
    const user = userEvent.setup()
    const { api, setSources } = removalApi()
    api.removeSource = vi.fn(async () => {
      setSources({ pendingRemoval: { sourceId: draft.id } })
      throw new GatewayApiError(409, 'source_removal_recovery_required')
    })
    render(<GatewayProvider api={api}><SourcesPage /></GatewayProvider>)
    await user.click(await screen.findByRole('button', { name: draft.label }))
    await user.click(screen.getByRole('button', { name: 'Remove source' }))
    await user.click(screen.getByRole('button', { name: 'Remove source' }))
    await screen.findByRole('button', { name: 'Continue removal' })
    expect(screen.getByRole('alert')).toHaveTextContent('Removal could not be confirmed')
    expect(screen.getByRole('button', { name: draft.label })).toBeVisible()
    expect(api.removeSource).toHaveBeenCalledTimes(1)
  })

  it.each(['older-runtime', 'no-token', 'managed-bigquery', 'other-action'])('explains or disables removal when unavailable: %s', async (reason) => {
    const user = userEvent.setup()
    const { api, setSources } = removalApi()
    if (reason === 'older-runtime') setSources({ removalEnabled: false })
    if (reason === 'no-token') setSources({ removalCredentialConfigured: false })
    if (reason === 'managed-bigquery') api.getBigQuerySetups = vi.fn<GatewayAdminApi['getBigQuerySetups']>(async () => ({ schemaVersion: 1, available: true,
      setups: [{ sourceId: draft.id, actionId: `action_${'b'.repeat(32)}`, ready: true, credentialRequired: false, recoveryRequired: false }] }))
    if (reason === 'other-action') api.getSourceActions = vi.fn<GatewayAdminApi['getSourceActions']>(async () => ({ schemaVersion: 1, actions: [],
      blockingAction: { kind: 'team', actionId: `action_${'b'.repeat(32)}` } }))
    render(<GatewayProvider api={api}><SourcesPage /></GatewayProvider>)
    await user.click(await screen.findByRole('button', { name: draft.label }))
    if (reason === 'other-action') expect(screen.getByRole('button', { name: 'Remove source' })).toBeDisabled()
    else expect(screen.queryByRole('button', { name: 'Remove source' })).not.toBeInTheDocument()
    if (reason === 'no-token') expect(screen.getByText(/Add a management token in/u)).toBeVisible()
    if (reason === 'managed-bigquery') expect(screen.getByText(/Individual removal of managed BigQuery bridges/u)).toBeVisible()
    expect(api.removeSource).not.toHaveBeenCalled()
  })
})
