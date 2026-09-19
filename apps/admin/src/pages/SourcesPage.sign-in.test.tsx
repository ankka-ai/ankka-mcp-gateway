import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GatewayApiError, type GatewayAdminApi, type GatewayStatus, type ManagedSource, type ManagedSources, type RuntimeUpdate, type SourceActions, type SourceActionSummary, type SourceActionTools } from '../api'
import { SYNTHETIC_SOURCE_CATALOG } from '../catalog/fixtures'
import { GatewayProvider, useGateway } from '../GatewayContext'
import { SourcesPage } from './SourcesPage'

// A sign-in source is installed with nothing enabled. Once its operator has connected it, the paused installation lists
// its real tools from Cloudflare's synced list, and the administrator who started it chooses.
const status: GatewayStatus = {
  schemaVersion: 1, status: 'ready', controlPlaneOrigin: 'https://deploy.ankka.ai', release: 'gateway-v1.0.0',
  gateway: { name: 'Gateway', hostname: 'mcp.example.com', mcpUrl: 'https://mcp.example.com/mcp', capabilityMode: 'read_only', codeMode: 'default_on' },
  source: null, access: { administratorCount: 1, memberCount: 0 }, updatedAt: '2026-08-27T12:00:00.000Z',
}
const update: RuntimeUpdate = { schemaVersion: 1, channel: 'stable', status: 'up_to_date', current: { release: 'gateway-v1.0.0', artifactSha256: 'a'.repeat(64) }, available: null, rollback: { available: false } }
const ACTION_ID = `action_${'a'.repeat(32)}`
const CONNECTION_URL = `https://dash.cloudflare.com/${'1'.repeat(32)}/one/access-controls/ai-controls/mcp-server/edit/synthetic-source`
const signInDraft: ManagedSource = { id: 'source-4444444444444444', label: 'Customer records', url: 'https://records.example.com/mcp',
  authMode: 'oauth', onBehalfOfUser: false, enabledTools: [], status: 'draft' }
const REAL_TOOLS: SourceActionTools['tools'] = [
  { name: 'records_delete', title: null, description: 'Delete one record.', readOnlyHint: null, destructiveHint: true, openWorldHint: null },
  { name: 'records_export', title: null, description: null, readOnlyHint: null, destructiveHint: null, openWorldHint: null },
  { name: 'records_search', title: 'Search records', description: 'Search records.', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
]

function pause(overrides: Partial<SourceActionSummary> = {}): SourceActionSummary {
  return {
    schemaVersion: 1, actionId: ACTION_ID, sourceId: signInDraft.id, status: 'recovery_required', state: 'recovery_required',
    failureCode: 'source_connection_required', issuedAt: new Date(Date.now() - 120_000).toISOString(),
    expiresAt: new Date(Date.now() + 480_000).toISOString(), canCancel: false, canRenew: true, connectionUrl: CONNECTION_URL, ...overrides,
  }
}

function offered(state: SourceActionTools['state'], tools: SourceActionTools['tools'] = []): SourceActionTools {
  return { schemaVersion: 1, actionId: ACTION_ID, sourceId: signInDraft.id, state, tools }
}

function pausedApi(action: SourceActionSummary | null, source: ManagedSource = signInDraft, tools: SourceActionTools = offered('ready', REAL_TOOLS)) {
  const snapshot: SourceActions = action === null
    ? { schemaVersion: 1, actions: [], blockingAction: null }
    : { schemaVersion: 1, actions: [action], blockingAction: { kind: 'source', actionId: action.actionId, sourceId: action.sourceId } }
  const current: ManagedSources = { schemaVersion: 1, revision: 4, applyMode: 'account_token', installationEnabled: true, sources: [source] }
  return {
    getBigQuerySetups: vi.fn<GatewayAdminApi['getBigQuerySetups']>(async () => ({ schemaVersion: 1 as const, available: false, setups: [] })), prepareBigQuery: vi.fn(), resumeBigQuery: vi.fn(),
    getStatus: vi.fn(async () => status), getSources: vi.fn<GatewayAdminApi['getSources']>(async () => current), getUpdate: vi.fn(async () => update),
    getTeam: vi.fn(), prepareTeamAction: vi.fn(), getTeamAction: vi.fn(), cancelTeamAction: vi.fn(),
    discoverSource: vi.fn<GatewayAdminApi['discoverSource']>(), removeSourceDraft: vi.fn(), saveSourceDraft: vi.fn(), prepareSourceAction: vi.fn<GatewayAdminApi['prepareSourceAction']>(),
    getSourceActions: vi.fn<GatewayAdminApi['getSourceActions']>(async () => snapshot), getSourceAction: vi.fn(), cancelSourceAction: vi.fn(),
    getSourceActionTools: vi.fn<GatewayAdminApi['getSourceActionTools']>(async () => tools),
    authorizeSource: vi.fn<GatewayAdminApi['authorizeSource']>(), chooseSourceActionTools: vi.fn<GatewayAdminApi['chooseSourceActionTools']>(),
    prepareRuntimeAction: vi.fn(), getRuntimeAction: vi.fn(), prepareTeardownAction: vi.fn(), getTeardownAction: vi.fn(),
    getManagementCredentialStatus: vi.fn(), prepareManagementCredentialAction: vi.fn(), verifyManagementAccess: vi.fn(),
  } satisfies GatewayAdminApi
}

async function choice() {
  return screen.findByRole('region', { name: `Tools of ${signInDraft.label}` })
}

describe('choosing the tools of a connected sign-in source', () => {
  afterEach(cleanup)

  it('starts provider authorization for the current action and retains the manual fallback on failure', async () => {
    const user = userEvent.setup()
    const api = pausedApi(pause(), signInDraft, offered('connection_required'))
    api.authorizeSource.mockRejectedValue(new GatewayApiError(409, 'source_oauth_unavailable'))
    render(<GatewayProvider api={api}><SourcesPage /></GatewayProvider>)
    const button = await screen.findByRole('button', { name: 'Authorize source' })
    await waitFor(() => expect(button).toBeEnabled())
    await user.click(button)
    expect(api.authorizeSource).toHaveBeenCalledExactlyOnceWith(ACTION_ID, 4, signInDraft.id)
    expect(await screen.findByRole('alert')).toHaveTextContent('open it in Cloudflare for manual OAuth setup')
    expect(screen.getByRole('link', { name: 'Open source in Cloudflare' })).toHaveAttribute('href', CONNECTION_URL)
    expect(api.prepareSourceAction).not.toHaveBeenCalled()
    expect(api.chooseSourceActionTools).not.toHaveBeenCalled()
  })

  it('lists nothing until Cloudflare is connected and never offers a resume that could attach nothing', async () => {
    const user = userEvent.setup()
    const api = pausedApi(pause())
    api.getSourceActionTools = vi.fn<GatewayAdminApi['getSourceActionTools']>()
      .mockResolvedValueOnce(offered('connection_required')).mockResolvedValue(offered('ready', REAL_TOOLS))
    render(<GatewayProvider api={api}><SourcesPage /></GatewayProvider>)
    const card = await screen.findByRole('article', { name: `Installation of ${signInDraft.label}` })
    expect(within(card).getByText('Connect your source')).toBeVisible()
    expect(within(card).getByText(/installed with nothing enabled: it is not attached to your Portal and nobody has been assigned access/u)).toBeVisible()
    expect(within(card).getByRole('link', { name: 'Open source in Cloudflare' })).toHaveAttribute('href', CONNECTION_URL)
    const region = await choice()
    expect(await within(region).findByText(/This source needs authorization before its tools can be listed/u)).toBeVisible()
    expect(within(region).queryByRole('checkbox')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Resume installation' })).not.toBeInTheDocument()
    expect(api.getSourceActionTools).toHaveBeenCalledExactlyOnceWith(ACTION_ID)

    await user.click(within(region).getByRole('button', { name: 'Check again' }))
    expect(await within(region).findByRole('checkbox', { name: /records_search/u })).toBeInTheDocument()
    expect(api.getSourceActionTools).toHaveBeenCalledTimes(2)
    expect(within(region).queryByRole('button', { name: 'Check again' })).not.toBeInTheDocument()
    expect(api.chooseSourceActionTools).not.toHaveBeenCalled()
    // The journal still records the reason of the last run. The card follows what Cloudflare says now.
    expect(await within(card).findByText('Choose tools')).toBeVisible()
    expect(within(card).queryByText('Connect your source')).not.toBeInTheDocument()
    expect(within(card).getByText(/This source is connected and nothing is enabled yet\. Choose the tools to allow from its real list below/u)).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Resume installation' })).not.toBeInTheDocument()
  })

  it('follows a source that is no longer connected, whatever reason the journal recorded', async () => {
    const api = pausedApi(pause({ failureCode: 'source_tools_required' }), signInDraft, offered('connection_required'))
    render(<GatewayProvider api={api}><SourcesPage /></GatewayProvider>)
    const card = await screen.findByRole('article', { name: `Installation of ${signInDraft.label}` })
    expect(await within(card).findByText('Connect your source')).toBeVisible()
    expect(within(card).queryByText('Choose tools')).not.toBeInTheDocument()
  })

  it('offers the real list with honest hints, preselects nothing for a custom source, and finishes in two bound steps', async () => {
    const user = userEvent.setup()
    const api = pausedApi(pause({ failureCode: 'source_tools_required' }))
    api.chooseSourceActionTools.mockResolvedValue({ schemaVersion: 1, actionId: ACTION_ID, sourceId: signInDraft.id, revision: 5, enabledTools: ['records_export', 'records_search'] })
    api.prepareSourceAction.mockResolvedValue({ schemaVersion: 1, actionId: ACTION_ID, status: 'succeeded', expiresAt: new Date(Date.now() + 600_000).toISOString() })
    render(<GatewayProvider api={api}><SourcesPage /></GatewayProvider>)
    const card = await screen.findByRole('article', { name: `Installation of ${signInDraft.label}` })
    expect(within(card).getByText('Choose tools')).toBeVisible()
    const region = await choice()
    expect(await within(region).findByText(/3 tools in Cloudflare’s synced list of this source\. Only the tools you select are attached; everything else stays disabled\./u)).toBeVisible()
    expect(within(region).getByText('Hints and descriptions are the source’s own claims, as Cloudflare synced them; 1 of 3 tools carry no hint. They help you review. They do not make a tool read-only.')).toBeVisible()
    expect(within(region).getByText('No description in Cloudflare’s synced list.')).toBeVisible()
    expect(within(region).getByText('read-only hint')).toBeVisible()
    // Nothing is preselected from a hint, not even a read-only one.
    for (const checkbox of within(region).getAllByRole('checkbox')) expect(checkbox).not.toBeChecked()
    expect(within(region).getByRole('button', { name: 'Allow tools and finish installation' })).toBeDisabled()
    expect(within(region).getByText('Select at least one tool. Until then the source stays installed with nothing enabled.')).toBeVisible()

    await user.click(within(region).getByRole('checkbox', { name: /records_search/u }))
    await user.click(within(region).getByRole('checkbox', { name: /records_export/u }))
    const reads = { sources: api.getSources.mock.calls.length, actions: api.getSourceActions.mock.calls.length }
    await user.click(within(region).getByRole('button', { name: 'Allow 2 tools and finish installation' }))
    await waitFor(() => expect(api.prepareSourceAction).toHaveBeenCalledExactlyOnceWith(5, signInDraft.id, ACTION_ID))
    expect(api.chooseSourceActionTools).toHaveBeenCalledExactlyOnceWith(ACTION_ID, 4, signInDraft.id, ['records_search', 'records_export'])
    expect(api.chooseSourceActionTools.mock.invocationCallOrder[0]).toBeLessThan(api.prepareSourceAction.mock.invocationCallOrder[0] ?? 0)
    await waitFor(() => expect(api.getSources.mock.calls.length).toBeGreaterThan(reads.sources))
    await waitFor(() => expect(api.getSourceActions.mock.calls.length).toBeGreaterThan(reads.actions))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('preselects the catalog recommendations that exist and names the ones that do not', async () => {
    const preset = SYNTHETIC_SOURCE_CATALOG.sources[0]
    if (!preset) throw new Error('Expected a synthetic preset')
    const source = { ...signInDraft, label: preset.displayName, url: preset.implementation.deployment.url }
    const api = pausedApi(pause(), source, offered('ready', [
      { name: 'properties.list', title: null, description: null, readOnlyHint: null, destructiveHint: null, openWorldHint: null },
      { name: 'properties.update', title: null, description: null, readOnlyHint: null, destructiveHint: null, openWorldHint: null },
    ]))
    render(<GatewayProvider api={api}><SourcesPage catalog={SYNTHETIC_SOURCE_CATALOG} /></GatewayProvider>)
    const region = await screen.findByRole('region', { name: `Tools of ${preset.displayName}` })
    expect(await within(region).findByRole('checkbox', { name: /properties\.list/u })).toBeChecked()
    expect(within(region).getByRole('checkbox', { name: /properties\.update/u })).not.toBeChecked()
    expect(within(region).getByText(/Catalog recommendations that exist are preselected for review\./u)).toBeVisible()
    const changed = within(region).getByRole('status')
    expect(changed).toHaveTextContent('1 recommended exact tool is absent from this source’s real list.')
    expect(changed).toHaveTextContent('reports.read')
    expect(within(region).getByRole('button', { name: 'Allow 1 tool and finish installation' })).toBeEnabled()
    // A list of names only says so instead of implying hints it does not have.
    expect(within(region).getByText(/carries no read-only or destructive hints and no descriptions, so none are shown/u)).toBeVisible()
    expect(within(region).getAllByText('No safety annotations')).toHaveLength(2)
  })

  it.each([
    ['sync_required', /has not finished syncing the tools of this source/u],
    ['unsupported', /cannot be offered here: it has more than 500 tools, a repeated name, or a name the gateway does not accept\. Nothing is enabled\./u],
  ] as const)('says what a %s list waits for and offers nothing to select', async (state, wording) => {
    const api = pausedApi(pause({ failureCode: 'source_sync_required' }), signInDraft, offered(state))
    render(<GatewayProvider api={api}><SourcesPage /></GatewayProvider>)
    const region = await choice()
    expect(await within(region).findByText(wording)).toBeVisible()
    expect(within(region).queryByRole('checkbox')).not.toBeInTheDocument()
    expect(within(region).getByRole('button', { name: 'Check again' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Resume installation' })).not.toBeInTheDocument()
  })

  it('keeps a typed or saved selection, still offers the resume, and shows a refused choice without losing the selection', async () => {
    const user = userEvent.setup()
    const typed = { ...signInDraft, enabledTools: ['records_search', 'records_serch'] }
    const api = pausedApi(pause({ failureCode: 'source_tools_mismatch' }), typed)
    api.chooseSourceActionTools.mockRejectedValue(new GatewayApiError(409, 'source_tools_mismatch'))
    render(<GatewayProvider api={api}><SourcesPage /></GatewayProvider>)
    const card = await screen.findByRole('article', { name: `Installation of ${signInDraft.label}` })
    expect(within(card).getByText('Review source tools')).toBeVisible()
    expect(within(card).getByRole('button', { name: 'Resume installation' })).toBeEnabled()
    const region = await choice()
    // The name that exists is kept; the mistyped one is not in the real list, so it cannot be selected at all.
    expect(await within(region).findByRole('checkbox', { name: /records_search/u })).toBeChecked()
    expect(within(region).queryByText('records_serch')).not.toBeInTheDocument()
    await user.click(within(region).getByRole('button', { name: 'Allow 1 tool and finish installation' }))
    expect(await within(region).findByRole('alert')).toHaveTextContent('A selected tool is not in the list Cloudflare synced from this source.')
    expect(api.prepareSourceAction).not.toHaveBeenCalled()
    expect(within(region).getByRole('checkbox', { name: /records_search/u })).toBeChecked()
  })

  it('shows a saved choice as ready to finish', async () => {
    const chosen = { ...signInDraft, enabledTools: ['records_search'] }
    const api = pausedApi(pause({ failureCode: 'source_tools_chosen' }), chosen)
    render(<GatewayProvider api={api}><SourcesPage /></GatewayProvider>)
    const card = await screen.findByRole('article', { name: `Installation of ${signInDraft.label}` })
    expect(within(card).getByText('Finish installation')).toBeVisible()
    expect(within(card).getByText(/Your tool selection is saved\. Resume to attach the source with exactly those tools/u)).toBeVisible()
    expect(within(card).getByRole('button', { name: 'Resume installation' })).toBeEnabled()
  })

  it('keeps the choice to the administrator who can resume it, and away from public sources and BigQuery bridges', async () => {
    const other = pausedApi(pause({ canRenew: false }))
    const first = render(<GatewayProvider api={other}><SourcesPage /></GatewayProvider>)
    expect(await screen.findByText('Only the administrator who started this installation can choose its tools and finish it.')).toBeVisible()
    expect(screen.queryByRole('region', { name: `Tools of ${signInDraft.label}` })).not.toBeInTheDocument()
    expect(other.getSourceActionTools).not.toHaveBeenCalled()
    first.unmount()

    const publicSource = pausedApi(pause(), { ...signInDraft, authMode: 'none', enabledTools: ['records_search'] })
    const second = render(<GatewayProvider api={publicSource}><SourcesPage /></GatewayProvider>)
    expect(await screen.findByRole('button', { name: 'Resume installation' })).toBeEnabled()
    expect(screen.queryByRole('region', { name: `Tools of ${signInDraft.label}` })).not.toBeInTheDocument()
    expect(publicSource.getSourceActionTools).not.toHaveBeenCalled()
    second.unmount()

    const bridge = pausedApi(pause(), { ...signInDraft, enabledTools: ['execute_sql_readonly'] })
    bridge.getBigQuerySetups.mockResolvedValue({ schemaVersion: 1, available: true, setups: [{ sourceId: signInDraft.id,
      actionId: ACTION_ID, ready: false, credentialRequired: false, recoveryRequired: false }] })
    render(<GatewayProvider api={bridge}><SourcesPage /></GatewayProvider>)
    await screen.findByRole('article', { name: `Installation of ${signInDraft.label}` })
    await waitFor(() => expect(bridge.getBigQuerySetups).toHaveBeenCalled())
    await waitFor(() => expect(screen.queryByRole('region', { name: `Tools of ${signInDraft.label}` })).not.toBeInTheDocument())
  })

  it('does not present the expected pause of an installation as a failed request', async () => {
    const user = userEvent.setup()
    function RequestError() {
      const { error } = useGateway()
      return <p data-testid="request-error">{error ?? 'none'}</p>
    }
    const api = pausedApi(null)
    api.prepareSourceAction.mockRejectedValueOnce(new GatewayApiError(409, 'source_connection_required'))
      .mockRejectedValueOnce(new GatewayApiError(409, 'source_action_conflict'))
    render(<GatewayProvider api={api}><RequestError /><SourcesPage /></GatewayProvider>)
    const install = await screen.findByRole('button', { name: 'Install source' })
    await waitFor(() => expect(install).toBeEnabled())
    await user.click(install)
    await waitFor(() => expect(api.prepareSourceAction).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Install source' })).toBeEnabled())
    expect(screen.getByTestId('request-error')).toHaveTextContent('none')
    // Any other refusal stays visible.
    await user.click(screen.getByRole('button', { name: 'Install source' }))
    await waitFor(() => expect(screen.getByTestId('request-error')).toHaveTextContent('This source action cannot proceed.'))
  })

  it.each([
    ['a sign-in source', 'oauth', 'After this you can no longer roll back to gateway-v0.9.9. Older releases cannot read a source saved without tools.'],
    ['a public source', 'none', null],
  ] as const)('says beside Save draft what saving %s decides about rollback, only while the gateway reports a release', async (_kind, authentication, sentence) => {
    const user = userEvent.setup()
    for (const installEndsRollbackTo of ['gateway-v0.9.9', null]) {
      const api = pausedApi(null)
      api.getSources.mockResolvedValue({ schemaVersion: 1, revision: 4, applyMode: 'account_token', installationEnabled: true, installEndsRollbackTo, sources: [] })
      api.discoverSource.mockImplementation(async (url) => ({ schemaVersion: 1, status: authentication === 'oauth' ? 'authorization_required' : 'discovered',
        endpoint: url, protocolVersion: '2026-07-28', authentication,
        tools: authentication === 'oauth' ? [] : [{ name: 'records_search', readOnlyHint: true, destructiveHint: false, defaultSelected: true }] }))
      const view = render(<GatewayProvider api={api}><SourcesPage /></GatewayProvider>)
      await user.click(await screen.findByRole('button', { name: 'Add source' }))
      await user.type(screen.getByLabelText('Source name'), 'Customer records')
      await user.type(screen.getByLabelText('MCP URL'), 'https://records.example.com/mcp')
      await user.click(screen.getByRole('button', { name: 'Inspect source' }))
      const save = await screen.findByRole('button', { name: 'Save draft' })
      // Older releases cannot read a source saved without tools, so for that one draft the save is the decision.
      if (sentence !== null && installEndsRollbackTo !== null) expect(save).toHaveAccessibleDescription(sentence)
      else {
        expect(save).not.toHaveAccessibleDescription()
        expect(screen.queryByText(/no longer roll back/u)).not.toBeInTheDocument()
      }
      view.unmount()
    }
  })

  it('says that a draft without tools has none yet instead of counting zero', async () => {
    const user = userEvent.setup()
    render(<GatewayProvider api={pausedApi(null)}><SourcesPage /></GatewayProvider>)
    await user.click(await screen.findByRole('button', { name: signInDraft.label }))
    expect(screen.getByText('No tools chosen yet. Nothing is enabled; you choose from the source’s real list after connecting it.')).toBeVisible()
    expect(screen.queryByText('0 exact tools')).not.toBeInTheDocument()
  })
})
