import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GatewayApiError, type ConnectExample, type ConnectState, type GatewayAdminApi, type GatewayStatus, type ManagedSources, type RuntimeUpdate, type Team } from '../api'
import { GatewayProvider } from '../GatewayContext'
import { ConnectPage } from './ConnectPage'

const knowledge = 'source-1111111111111111'
const catalogue = 'source-2222222222222222'
const status: GatewayStatus = {
  schemaVersion: 1, status: 'ready', controlPlaneOrigin: 'https://deploy.ankka.ai', release: 'gateway-v1.0.0',
  gateway: { name: 'Example Gateway', hostname: 'mcp.example.com', mcpUrl: 'https://mcp.example.com/mcp', capabilityMode: 'read_only', codeMode: 'default_on' },
  source: null, access: { administratorCount: 1, memberCount: 1 }, updatedAt: '2026-08-27T12:00:00.000Z',
}
const source = (id: string, label: string) => ({ id, label, url: `https://${id}.example.com/mcp`, authMode: 'none' as const,
  onBehalfOfUser: false, enabledTools: ['search'], status: 'installed' as const })
const sources: ManagedSources = { schemaVersion: 1, revision: 1, applyMode: 'oauth_per_action', installationEnabled: true,
  sources: [source(knowledge, 'Company knowledge'), source(catalogue, 'Product catalogue')] }
const update: RuntimeUpdate = { schemaVersion: 1, channel: 'stable', status: 'up_to_date', current: null, available: null, rollback: { available: false } }
const team: Team = {
  schemaVersion: 1, revision: 3, editingEnabled: true, editingDisabledReason: null, managementCredentialConfigured: true,
  adminEmails: ['admin@example.com'], members: [{ email: 'admin@example.com', sourceIds: [] }, { email: 'analyst@example.com', sourceIds: [] }],
  sources: [], pendingAction: null, proposedMembers: null, proposedTeams: null,
  teams: [{ id: 'team-0123456789abcdef', name: 'Marketing', memberEmails: ['analyst@example.com'], sourceIds: [knowledge] }],
}
const examples: ConnectExample[] = [{ id: 'example-aaaaaaaaaaaa', prompt: 'Find the onboarding checklist.', sourceIds: [knowledge] }]
const connect = (overrides: Partial<ConnectState> = {}): ConnectState => ({
  schemaVersion: 1, revision: 1, examples: structuredClone(examples), updatedAt: '2026-10-20T09:30:00.000Z', updatedBy: 'admin@example.com',
  page: { status: 'off', failureCode: null }, managementCredentialConfigured: true, ...overrides,
})

function api(overrides: Partial<GatewayAdminApi> = {}): GatewayAdminApi {
  return {
    removeSource: vi.fn(), getBigQuerySetups: vi.fn(async () => ({ schemaVersion: 1 as const, available: false, setups: [] })), prepareBigQuery: vi.fn(), resumeBigQuery: vi.fn(),
    getStatus: vi.fn(async () => status), checkSourceConnection: vi.fn(), getSources: vi.fn(async () => sources), getUpdate: vi.fn(async () => update),
    getTeam: vi.fn(async () => structuredClone(team)), prepareTeamAction: vi.fn(), getTeamAction: vi.fn(), cancelTeamAction: vi.fn(),
    discoverSource: vi.fn(), prepareBigQueryRemoval: vi.fn(), removeSourceDraft: vi.fn(), saveSourceDraft: vi.fn(), prepareSourceAction: vi.fn(), getSourceActions: vi.fn(async () => ({ schemaVersion: 1 as const, actions: [], blockingAction: null })), getSourceAction: vi.fn(), cancelSourceAction: vi.fn(), getSourceActionTools: vi.fn(), reconnectSource: vi.fn<GatewayAdminApi['reconnectSource']>(), switchSourceToServiceToken: vi.fn(), authorizeSource: vi.fn<GatewayAdminApi['authorizeSource']>(), chooseSourceActionTools: vi.fn(), getInstalledSourceTools: vi.fn(), updateInstalledSourceTools: vi.fn(), renameInstalledSource: vi.fn(),
    prepareRuntimeAction: vi.fn(), getRuntimeAction: vi.fn(), prepareTeardownAction: vi.fn(), getTeardownAction: vi.fn(),
    getManagementCredentialStatus: vi.fn(), prepareManagementCredentialAction: vi.fn(), verifyManagementAccess: vi.fn(),
    getConnect: vi.fn(async () => connect()), saveConnectExamples: vi.fn(), setConnectPage: vi.fn(),
    ...overrides,
  }
}

function renderConnect(client = api()) {
  render(<GatewayProvider api={client}><ConnectPage /></GatewayProvider>)
  return client
}

describe('ConnectPage', () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks() })

  it('explains the Access application before turning the page on, then lists a link per team', async () => {
    const user = userEvent.setup()
    const client = renderConnect(api({ setConnectPage: vi.fn(async () => connect({ page: { status: 'on', failureCode: null } })) }))
    expect(await screen.findByText(/only asks people to sign in/)).toBeVisible()
    expect(screen.queryByRole('button', { name: /Copy link/ })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Turn on' }))
    expect(client.setConnectPage).toHaveBeenCalledWith(true)
    expect(await screen.findByText('Marketing')).toBeVisible()
    expect(screen.getByText(`${window.location.origin}/__ankka/connect/team-0123456789abcdef`)).toBeVisible()
    expect(screen.getByRole('button', { name: 'Copy link for everyone' })).toBeVisible()
    expect(screen.getByRole('link', { name: 'Open the page for Marketing' })).toHaveAttribute('href', `${window.location.origin}/__ankka/connect/team-0123456789abcdef`)
  })

  it('needs the management token to turn the page on and shows why an attempt stopped', async () => {
    renderConnect(api({ getConnect: vi.fn(async () => connect({ managementCredentialConfigured: false,
      page: { status: 'enabling', failureCode: 'connect_page_conflict' } })) }))
    expect(await screen.findByText(/Another Cloudflare Access application already covers/)).toBeVisible()
    expect(screen.getByText(/Add your management token in Settings first/)).toBeVisible()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Turn off' })).toBeEnabled()
  })

  it('edits examples, shows which teams see them, and saves them with the loaded revision', async () => {
    const user = userEvent.setup()
    const client = renderConnect(api({ saveConnectExamples: vi.fn(async (revision: number, next: ConnectExample[]) => connect({ revision: revision + 1, examples: next })) }))
    const first = await screen.findByRole('listitem', { name: 'Example 1' })
    expect(within(first).getByText('Shown to: Marketing')).toBeVisible()
    await user.click(within(first).getByRole('checkbox', { name: 'Product catalogue' }))
    expect(within(first).getByText('Shown to: No team has all of these connectors yet')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Add example' }))
    const second = screen.getByRole('listitem', { name: 'Example 2' })
    expect(within(second).getByText('Shown to: Everyone')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Save examples' }))
    expect(within(second).getByRole('alert')).toHaveTextContent('Write a question or remove this example.')
    expect(client.saveConnectExamples).not.toHaveBeenCalled()
    await user.type(within(second).getByRole('textbox', { name: 'Question 2' }), '  What can you help me with?  ')
    await user.type(within(second).getByRole('textbox', { name: 'What the answer shows (optional)' }), ' A short tour of your sources. ')
    await user.click(screen.getByRole('button', { name: 'Save examples' }))
    await waitFor(() => expect(client.saveConnectExamples).toHaveBeenCalledTimes(1))
    expect(client.saveConnectExamples).toHaveBeenCalledWith(1, [
      { id: 'example-aaaaaaaaaaaa', prompt: 'Find the onboarding checklist.', sourceIds: [knowledge, catalogue].sort() },
      { id: expect.stringMatching(/^example-[a-f0-9]{12}$/u), prompt: 'What can you help me with?', answer: 'A short tour of your sources.', sourceIds: [] },
    ])
    expect(await screen.findByText('Examples saved.')).toBeVisible()
  })

  it('takes removed connectors off examples when saving', async () => {
    const user = userEvent.setup()
    const removed = 'source-9999999999999999'
    const client = renderConnect(api({
      getConnect: vi.fn(async () => connect({ examples: [{ id: 'example-aaaaaaaaaaaa', prompt: 'Compare stock levels.', sourceIds: [knowledge, removed] }] })),
      saveConnectExamples: vi.fn(async () => { throw new GatewayApiError(409, 'connect_examples_revision_conflict') }),
    }))
    expect(await screen.findByText(/Saving takes those connectors off the examples/)).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Save examples' }))
    await waitFor(() => expect(client.saveConnectExamples).toHaveBeenCalledWith(1, [
      { id: 'example-aaaaaaaaaaaa', prompt: 'Compare stock levels.', sourceIds: [knowledge] }]))
    expect(await screen.findByText('The examples changed in another tab. Refresh before saving again.')).toBeVisible()
  })
})
