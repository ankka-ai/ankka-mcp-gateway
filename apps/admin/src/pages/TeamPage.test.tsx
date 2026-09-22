import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GatewayApiError, type GatewayAdminApi, type GatewayStatus, type ManagedSources, type TeamActionResult, type RuntimeUpdate, type Team, type TeamAction, type TeamGrant, type TeamMember } from '../api'
import { GatewayProvider } from '../GatewayContext'
import { createPreviewGatewayAdminApi } from '../preview-api'
import { TeamPage } from './TeamPage'

const sourceId = 'source-1111111111111111'
const actionId = `action_${'a'.repeat(32)}`
const expiresAt = '2030-01-01T00:00:00.000Z'
const status: GatewayStatus = {
  schemaVersion: 1, status: 'ready', controlPlaneOrigin: 'https://deploy.ankka.ai', release: 'gateway-v1.0.0',
  gateway: { name: 'Example Gateway', hostname: 'mcp.example.com', mcpUrl: 'https://mcp.example.com/mcp', capabilityMode: 'read_only', codeMode: 'default_on' },
  source: null, access: { administratorCount: 1, memberCount: 1 }, updatedAt: '2026-08-27T12:00:00.000Z',
}
const sources: ManagedSources = { schemaVersion: 1, revision: 1, applyMode: 'oauth_per_action', installationEnabled: false, sources: [] }
const update: RuntimeUpdate = { schemaVersion: 1, channel: 'stable', status: 'up_to_date', current: null, available: null, rollback: { available: false } }
const team: Team = {
  schemaVersion: 1, revision: 7, editingEnabled: true, editingDisabledReason: null, managementCredentialConfigured: true,
  adminEmails: ['admin@example.com'],
  members: [{ email: 'admin@example.com', sourceIds: [] }, { email: 'analyst@example.com', sourceIds: [] }],
  sources: [
    { id: sourceId, label: 'Company knowledge', enabledTools: ['fetch_document', 'search'], status: 'installed' },
    { id: 'source-2222222222222222', label: 'Product catalogue', enabledTools: ['get_product'], status: 'draft' },
  ],
  pendingAction: null,
  proposedMembers: null,
  teams: [],
  proposedTeams: null,
}

function api(overrides: Partial<GatewayAdminApi> = {}): GatewayAdminApi {
  return {
    removeSource: vi.fn(), getBigQuerySetups: vi.fn(async () => ({ schemaVersion: 1 as const, available: false, setups: [] })), prepareBigQuery: vi.fn(), resumeBigQuery: vi.fn(),
    getStatus: vi.fn(async () => status), getSources: vi.fn(async () => sources), getUpdate: vi.fn(async () => update),
    getTeam: vi.fn(async () => structuredClone(team)), prepareTeamAction: vi.fn(), getTeamAction: vi.fn(), cancelTeamAction: vi.fn(),
    discoverSource: vi.fn(), prepareBigQueryRemoval: vi.fn(), removeSourceDraft: vi.fn(), saveSourceDraft: vi.fn(), prepareSourceAction: vi.fn(), getSourceActions: vi.fn(async () => ({ schemaVersion: 1 as const, actions: [], blockingAction: null })), getSourceAction: vi.fn(), cancelSourceAction: vi.fn(), getSourceActionTools: vi.fn(), authorizeSource: vi.fn<GatewayAdminApi['authorizeSource']>(), chooseSourceActionTools: vi.fn(), getInstalledSourceTools: vi.fn(), updateInstalledSourceTools: vi.fn(), renameInstalledSource: vi.fn(),
    prepareRuntimeAction: vi.fn(), getRuntimeAction: vi.fn(), prepareTeardownAction: vi.fn(), getTeardownAction: vi.fn(),
    getManagementCredentialStatus: vi.fn(), prepareManagementCredentialAction: vi.fn(), verifyManagementAccess: vi.fn(),
    ...overrides,
  }
}

function renderTeam(client = api()) {
  render(<GatewayProvider api={client}><TeamPage /></GatewayProvider>)
  return client
}



function accessCheckbox(member: HTMLElement, name?: RegExp) {
  fireEvent.click(within(member).getByRole('button', { name: /^Access for/ }))
  const checkbox = screen.getByRole('checkbox', name ? { name } : undefined)
  fireEvent.click(screen.getByRole('button', { name: 'Done' }))
  return checkbox
}

async function toggleAccess(user: ReturnType<typeof userEvent.setup>, member: HTMLElement, name?: RegExp) {
  await user.click(within(member).getByRole('button', { name: /^Access for/ }))
  await user.click(screen.getByRole('checkbox', name ? { name } : undefined))
  await user.click(screen.getByRole('button', { name: 'Done' }))
}

describe('TeamPage', () => {
  afterEach(() => { cleanup(); window.history.replaceState(null, '', '/'); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers() })

  it('moves connector selection into an access dialog with shared tool details and restores focus on close', async () => {
    const user = userEvent.setup()
    const client = renderTeam()
    const person = await screen.findByRole('group', { name: 'analyst@example.com' })
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    const access = within(person).getByRole('button', { name: 'Access for analyst@example.com' })
    await user.click(access)
    const dialog = screen.getByRole('dialog', { name: 'Member access' })
    expect(within(dialog).getByText('analyst@example.com')).toBeVisible()
    expect(within(dialog).queryByRole('checkbox', { name: /Product catalogue/ })).not.toBeInTheDocument()
    await user.click(within(dialog).getByText('2 tools'))
    expect(within(dialog).getByText('fetch_document')).toBeVisible()
    expect(within(dialog).getByText('search')).toBeVisible()
    expect(within(dialog).getAllByRole('checkbox')).toHaveLength(1)
    await user.click(within(dialog).getByRole('checkbox', { name: 'Company knowledge' }))
    expect(client.prepareTeamAction).not.toHaveBeenCalled()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(access).toHaveFocus()
    expect(within(person).getByText('1 connector selected')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
    await user.click(screen.getByRole('button', { name: 'Discard unsaved changes' }))
    expect(within(person).getByText('No connectors selected.')).toBeVisible()
  })

  it('opens a focused add-user dialog and cancels without changing the team', async () => {
    const user = userEvent.setup()
    const client = renderTeam()
    await screen.findByRole('group', { name: 'admin@example.com' })
    expect(screen.getByRole('heading', { name: 'Team members (2)' })).toBeInTheDocument()
    expect(screen.queryByText(/including administrators/)).not.toBeInTheDocument()
    expect(screen.queryByText('Edit connector access')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument()
    const trigger = screen.getByRole('button', { name: 'Add user' })
    await user.click(trigger)
    const dialog = screen.getByRole('dialog', { name: 'Add user' })
    const email = within(dialog).getByLabelText('Email')
    await waitFor(() => expect(email).toHaveFocus())
    await user.type(email, 'cancelled@example.com')
    await user.tab()
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus()
    await user.tab({ shift: true })
    expect(email).toHaveFocus()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(trigger).toHaveFocus()
    expect(screen.queryByRole('group', { name: 'cancelled@example.com' })).not.toBeInTheDocument()
    await user.click(trigger)
    expect(screen.getByLabelText('Email')).toHaveValue('')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByText('No unsaved changes')).not.toBeInTheDocument()
    expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument()
    expect(client.prepareTeamAction).not.toHaveBeenCalled()
  })

  it('starts new users with no connectors and keeps unsaved selections separate from saved access', async () => {
    const user = userEvent.setup()
    const client = renderTeam()
    await screen.findByRole('group', { name: 'admin@example.com' })
    expect(screen.queryByRole('button', { name: 'Refresh' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Remove admin@example.com' })).not.toBeInTheDocument()
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Administrators' })).not.toBeInTheDocument()
    expect(screen.queryByText('Administrator roles are managed in the deployment configuration.')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Add user' }))
    await user.type(screen.getByLabelText('Email'), 'New.Person@Example.com')
    await user.click(screen.getByRole('button', { name: 'Add user' }))
    const newPerson = screen.getByRole('group', { name: 'new.person@example.com' })
    const checkbox = accessCheckbox(newPerson, /Company knowledge/)
    expect(checkbox).not.toBeChecked()
    expect(within(newPerson).queryByRole('checkbox')).not.toBeInTheDocument()
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument()

    await toggleAccess(user, newPerson, /Company knowledge/)
    expect(accessCheckbox(newPerson, /Company knowledge/)).toBeChecked()
    expect(client.prepareTeamAction).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Discard unsaved changes' }))
    expect(screen.queryByRole('group', { name: 'new.person@example.com' })).not.toBeInTheDocument()
    expect(screen.queryByText('No unsaved changes')).not.toBeInTheDocument()
    expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument()
  })

  it('edits administrator connector access without changing roles', async () => {
    const user = userEvent.setup()
    renderTeam()
    const administrator = await screen.findByRole('group', { name: 'admin@example.com' })
    await toggleAccess(user, administrator, /Company knowledge/)
    expect(accessCheckbox(administrator)).toBeChecked()
    expect(screen.getByText('Administrator')).toBeInTheDocument()
  })

  it('keeps existing-connector permission controls usable while connector addition is paused', async () => {
    const user = userEvent.setup()
    const client = renderTeam()
    const administrator = await screen.findByRole('group', { name: 'admin@example.com' })
    expect(screen.getByText(/New-connector installation is temporarily unavailable in this release/)).toBeInTheDocument()
    const source = accessCheckbox(administrator, /Company knowledge/)
    expect(source).toBeEnabled()
    await toggleAccess(user, administrator, /Company knowledge/)
    expect(accessCheckbox(administrator, /Company knowledge/)).toBeChecked()
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Add user' })).toBeEnabled()
    expect(client.prepareSourceAction).not.toHaveBeenCalled()
  })

  it('rejects a duplicate email without adding another user', async () => {
    const user = userEvent.setup()
    renderTeam()
    await screen.findByRole('group', { name: 'analyst@example.com' })
    await user.click(screen.getByRole('button', { name: 'Add user' }))
    await user.type(screen.getByLabelText('Email'), 'ANALYST@example.com')
    await user.click(screen.getByRole('button', { name: 'Add user' }))
    expect(screen.getByRole('alert')).toHaveTextContent('This user is already in your team.')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getAllByRole('group', { name: 'analyst@example.com' })).toHaveLength(1)
  })

  it('allows adding users beyond the former 51-user cap without limiting existing edits', async () => {
    const user = userEvent.setup()
    const members = [{ email: 'admin@example.com', sourceIds: [] }, ...Array.from({ length: 50 }, (_, index) => ({ email: `person${index}@example.com`, sourceIds: [] }))]
    const client = renderTeam(api({ getTeam: vi.fn(async () => ({ ...team, members })) }))
    expect(await screen.findByRole('heading', { name: 'Team members (51)' })).toBeInTheDocument()
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add user' })).toBeEnabled()
    const administrator = screen.getByRole('group', { name: 'admin@example.com' })
    expect(accessCheckbox(administrator)).toBeEnabled()
    await user.click(screen.getByRole('button', { name: 'Add user' }))
    await user.type(screen.getByLabelText('Email'), 'another@example.com')
    await user.click(screen.getByRole('button', { name: 'Add user' }))
    expect(screen.getByRole('group', { name: 'another@example.com' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Team members (52)' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add user' })).toBeEnabled()
    expect(client.prepareTeamAction).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Remove person0@example.com' }))
    expect(screen.getByRole('heading', { name: 'Team members (51)' })).toBeInTheDocument()
  })

  it('rejects an overlong local email part without preparing any change', async () => {
    const user = userEvent.setup()
    const client = renderTeam()
    await screen.findByRole('group', { name: 'admin@example.com' })
    await user.click(screen.getByRole('button', { name: 'Add user' }))
    await user.type(screen.getByLabelText('Email'), `${'a'.repeat(65)}@example.com`)
    await user.click(screen.getByRole('button', { name: 'Add user' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a valid email address')
    expect(screen.queryByText('No unsaved changes')).not.toBeInTheDocument()
    expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument()
    expect(client.prepareTeamAction).not.toHaveBeenCalled()
  })

  it('shows a newly installed connector without implicitly assigning it to anyone', async () => {
    const client = renderTeam(api({ getTeam: vi.fn(async () => ({ ...team, sources: team.sources.map((source) => ({ ...source, status: 'installed' as const })) })) }))
    await screen.findByRole('group', { name: 'admin@example.com' })
    for (const email of ['admin@example.com', 'analyst@example.com']) expect(accessCheckbox(screen.getByRole('group', { name: email }), /Product catalogue/)).not.toBeChecked()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByText('No unsaved changes')).not.toBeInTheDocument()
    expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument()
    expect(client.prepareTeamAction).not.toHaveBeenCalled()
  })

  it('submits only the reviewed proposal and never optimistically changes saved access', async () => {
    const user = userEvent.setup()
    const prepareTeamAction = vi.fn(() => new Promise<never>(() => {}))
    renderTeam(api({ prepareTeamAction }))
    const person = await screen.findByRole('group', { name: 'analyst@example.com' })
    await toggleAccess(user, person)
    await user.dblClick(screen.getByRole('button', { name: 'Save' }))
    expect(prepareTeamAction).toHaveBeenCalledExactlyOnceWith(7, [
      { email: 'admin@example.com', sourceIds: [] },
      { email: 'analyst@example.com', sourceIds: [sourceId] },
    ], [])
    expect(screen.queryByText(/Team access saved and verified in Cloudflare/)).not.toBeInTheDocument()
  })

  it('keeps a recovery proposal read-only and resumes its exact recorded membership', async () => {
    const user = userEvent.setup()
    const proposedMembers = [{ email: 'admin@example.com', sourceIds: [sourceId] }]
    const pendingAction: TeamAction = { schemaVersion: 1, actionId, status: 'recovery_required', expiresAt, failureCode: 'team_recovery_required', canCancel: false }
    const prepareTeamAction = vi.fn(() => new Promise<never>(() => {}))
    renderTeam(api({ getTeam: vi.fn(async () => ({ ...team, pendingAction, proposedMembers })), prepareTeamAction }))
    expect(await screen.findByText(/Nothing was automatically restored/)).toBeInTheDocument()
    expect(screen.getByText('Recorded change')).toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'analyst@example.com' })).not.toBeInTheDocument()
    expect(accessCheckbox(screen.getByRole('group', { name: 'admin@example.com' }))).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Add user' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Resume recorded change' }))
    expect(prepareTeamAction).toHaveBeenCalledWith(7, proposedMembers, [])
  })

  it('does not permit a recovery action when its recorded proposal cannot be retrieved', async () => {
    const pendingAction: TeamAction = { schemaVersion: 1, actionId, status: 'recovery_required', expiresAt, failureCode: null, canCancel: false }
    const client = renderTeam(api({ getTeam: vi.fn(async () => ({ ...team, pendingAction })) }))
    expect(await screen.findByText(/recorded proposal is unavailable/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Resume recorded change' })).toBeDisabled()
    expect(client.prepareTeamAction).not.toHaveBeenCalled()
  })

  it('loads verified state after a callback completes instead of treating the callback as proof', async () => {
    window.history.replaceState(null, '', `/team?accessAction=${actionId}&accessActionResult=complete`)
    const succeeded: TeamAction = { schemaVersion: 1, actionId, status: 'succeeded', expiresAt, failureCode: null, canCancel: false }
    const verified: Team = { ...team, revision: 8, pendingAction: succeeded, members: [{ email: 'admin@example.com', sourceIds: [] }, { email: 'analyst@example.com', sourceIds: [sourceId] }] }
    const getTeam = vi.fn().mockResolvedValueOnce(team).mockResolvedValue(verified)
    const getTeamAction = vi.fn(async () => succeeded)
    renderTeam(api({ getTeam, getTeamAction }))
    expect(await screen.findByText(/Team access saved and verified in Cloudflare/)).toBeInTheDocument()
    expect(getTeamAction).toHaveBeenCalledWith(actionId)
    expect(window.location.search).not.toContain('accessActionResult')
    expect(window.location.search).not.toContain('accessAction=')
  })

  it('does not announce a historical success when opening or revisiting Team', async () => {
    const succeeded: TeamAction = { schemaVersion: 1, actionId, status: 'succeeded', expiresAt, failureCode: null, canCancel: false }
    const client = api({ getTeam: vi.fn(async () => ({ ...team, pendingAction: succeeded })) })
    for (let visit = 0; visit < 2; visit += 1) {
      renderTeam(client)
      await screen.findByRole('group', { name: 'admin@example.com' })
      expect(screen.queryByText(/Team access saved and verified in Cloudflare/)).not.toBeInTheDocument()
      expect(screen.queryByText(/Unsaved selections have not been applied/)).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Add user' })).toBeEnabled()
      cleanup()
    }
    expect(client.prepareTeamAction).not.toHaveBeenCalled()
  })

  it.each(['dismiss', 'edit', 'timeout'] as const)('clears a verified recovery confirmation on %s without replaying it', async (reason) => {
    const user = userEvent.setup()
    const pendingAction: TeamAction = { schemaVersion: 1, actionId, status: 'recovery_required', expiresAt, failureCode: 'team_recovery_required', canCancel: false }
    const succeeded: TeamActionResult['action'] = { ...pendingAction, action: 'access', status: 'succeeded', failureCode: null }
    const verified = { ...team, revision: 8, pendingAction: succeeded }
    const client = api({
      getTeam: vi.fn().mockResolvedValueOnce({ ...team, pendingAction, proposedMembers: team.members }).mockResolvedValue(verified),
      prepareTeamAction: vi.fn(async () => ({ schemaVersion: 1 as const, action: succeeded })),
    })
    renderTeam(client)
    const resume = await screen.findByRole('button', { name: 'Resume recorded change' })
    if (reason === 'timeout') vi.useFakeTimers()
    await act(async () => { fireEvent.click(resume) })
    expect(screen.getByText('Team access saved and verified in Cloudflare.')).toBeVisible()
    expect(screen.queryByText(/Unsaved selections have not been applied/)).not.toBeInTheDocument()
    if (reason === 'dismiss') await user.click(screen.getByRole('button', { name: 'Dismiss team access confirmation' }))
    else if (reason === 'edit') {
      await toggleAccess(user, screen.getByRole('group', { name: 'analyst@example.com' }))
      expect(screen.getByText('Unsaved changes')).toBeVisible()
      await user.click(screen.getByRole('button', { name: 'Discard unsaved changes' }))
    } else {
      await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
      vi.useRealTimers()
    }
    expect(screen.queryByText(/Team access saved and verified in Cloudflare/)).not.toBeInTheDocument()
    cleanup()
    renderTeam(client)
    await screen.findByRole('group', { name: 'admin@example.com' })
    expect(screen.queryByText(/Team access saved and verified in Cloudflare/)).not.toBeInTheDocument()
    expect(client.prepareTeamAction).toHaveBeenCalledExactlyOnceWith(7, team.members, [])
  })

  it('applies an entire batch with one local Save and reloads the verified roster without a hosted handoff', async () => {
    window.history.replaceState(null, '', '/team')
    const user = userEvent.setup()
    const secondSource = 'source-2222222222222222'
    const current = { ...team, sources: team.sources.map((source) => ({ ...source, status: 'installed' as const })) }
    const members = [
      { email: 'admin@example.com', sourceIds: [sourceId] },
      { email: 'analyst@example.com', sourceIds: [secondSource] },
      { email: 'new.person@example.com', sourceIds: [sourceId] },
    ]
    const succeeded: TeamActionResult['action'] = { schemaVersion: 1, action: 'access', actionId, status: 'succeeded', expiresAt, failureCode: null, canCancel: false }
    const getTeam = vi.fn().mockResolvedValueOnce(current).mockResolvedValue({ ...current, members, pendingAction: succeeded, revision: 8 })
    const client = renderTeam(api({ getTeam, prepareTeamAction: vi.fn(async (): Promise<TeamActionResult> => ({ schemaVersion: 1, action: succeeded })) }))
    const administrator = await screen.findByRole('group', { name: 'admin@example.com' })
    await toggleAccess(user, administrator, /Company knowledge/)
    await toggleAccess(user, screen.getByRole('group', { name: 'analyst@example.com' }), /Product catalogue/)
    await user.click(screen.getByRole('button', { name: 'Add user' }))
    await user.type(screen.getByLabelText('Email'), 'New.Person@Example.com')
    await user.click(screen.getByRole('button', { name: 'Add user' }))
    await toggleAccess(user, screen.getByRole('group', { name: 'new.person@example.com' }), /Company knowledge/)
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText(/Team access saved and verified in Cloudflare/)).toBeInTheDocument()
    expect(screen.getByText(/Team access saved and verified in Cloudflare/)).toBeInTheDocument()
    expect(screen.queryByText('No unsaved changes')).not.toBeInTheDocument()
    expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument()
    expect(client.prepareTeamAction).toHaveBeenCalledExactlyOnceWith(7, members, [])
    expect(client.prepareSourceAction).not.toHaveBeenCalled()
    expect(client.getStatus).toHaveBeenCalledTimes(1)
    expect(getTeam).toHaveBeenCalledTimes(2)
    expect(window.location.pathname).toBe('/team')
    expect(window.location.search).toBe('')
  })

  it.each([
    ['skipped', 'You skipped the token during setup.'],
    ['provided', 'Your setup token was not saved. Add it again.'],
    [null, 'No management token was added during setup.'],
    [undefined, 'No management token was added during setup.'],
  ] as const)('keeps writes disabled without a management token and leads to the one way of adding it (setup: %s)', async (choice, sentence) => {
    const user = userEvent.setup()
    // jsdom follows a fragment, not a navigation: stand on the operation page so the handoff is observable.
    window.history.replaceState(null, '', '/__ankka/operation')
    const prepared = { schemaVersion: 1 as const, actionId, status: 'authorization_required' as const, expiresAt, handoffUrl: `${window.location.origin}/__ankka/operation#${'a'.repeat(40)}` }
    const withoutToken: Team = { ...team, editingEnabled: false, editingDisabledReason: 'management_credential_missing', managementCredentialConfigured: false }
    // A gateway from before this field existed leaves it out altogether.
    if (choice !== undefined) withoutToken.managementCredentialChoice = choice
    const client = renderTeam(api({
      getTeam: vi.fn(async () => withoutToken),
      prepareManagementCredentialAction: vi.fn(async () => prepared),
    }))
    const person = await screen.findByRole('group', { name: 'analyst@example.com' })
    expect(accessCheckbox(person)).toBeDisabled()
    // One card says what the token is for, what it can reach, why it is missing here, and starts the way to add it.
    const card = screen.getByRole('heading', { name: 'Add your management token' }).closest('section')
    expect(card).toHaveTextContent('Add connectors and manage team access with a Cloudflare API token.')
    expect(card).toHaveTextContent('This token can edit all Access policies in your Cloudflare account. It stays in your gateway and never passes through Ankka.')
    expect(card).toHaveTextContent(sentence)
    expect(screen.queryByRole('link', { name: 'Settings' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Add management token' }))
    expect(client.prepareManagementCredentialAction).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(window.location.hash).toBe(`#${'a'.repeat(40)}`))
    window.history.replaceState(null, '', '/')
    const save = screen.getByRole('button', { name: 'Save' })
    expect(save).toBeDisabled()
    await user.click(save)
    expect(client.prepareTeamAction).not.toHaveBeenCalled()
  })

  it('resumes an expired legacy proposal locally without requiring a hosted callback', async () => {
    const user = userEvent.setup()
    const proposedMembers = [{ email: 'admin@example.com', sourceIds: [sourceId] }]
    const pendingAction: TeamAction = { schemaVersion: 1, actionId, status: 'authorization_required', expiresAt: '2020-01-01T00:00:00.000Z', failureCode: null, canCancel: true }
    const succeeded: TeamActionResult['action'] = { ...pendingAction, status: 'succeeded', canCancel: false }
    const getTeam = vi.fn().mockResolvedValueOnce({ ...team, pendingAction, proposedMembers }).mockResolvedValue({ ...team, pendingAction: succeeded, proposedMembers: null, members: proposedMembers, revision: 8 })
    const client = renderTeam(api({ getTeam, prepareTeamAction: vi.fn(async (): Promise<TeamActionResult> => ({ schemaVersion: 1, action: succeeded })) }))
    expect(await screen.findByText(/Hosted authorization is no longer used/)).toBeInTheDocument()
    expect(accessCheckbox(screen.getByRole('group', { name: 'admin@example.com' }))).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Save recorded change' }))
    expect(await screen.findByText(/Team access saved and verified in Cloudflare/)).toBeInTheDocument()
    expect(client.prepareTeamAction).toHaveBeenCalledExactlyOnceWith(7, proposedMembers, [])
    expect(client.getTeamAction).not.toHaveBeenCalled()
    expect(window.location.search).toBe('')
  })

  it('directs a retained uncertain legacy proposal to manual Cloudflare reconciliation', async () => {
    const proposedMembers = team.members.map((member) => ({ ...member, sourceIds: member.email === 'analyst@example.com' ? [sourceId] : [] }))
    const pendingAction: TeamAction = { schemaVersion: 1, actionId, status: 'recovery_required', expiresAt, failureCode: 'team_management_credential_invalid', canCancel: false }
    const getTeam = vi.fn(async () => ({
      ...team,
      editingEnabled: false,
      editingDisabledReason: 'managed_in_cloudflare' as const,
      managementCredentialConfigured: false,
      pendingAction,
      proposedMembers,
    }))
    const client = renderTeam(api({ getTeam }))
    expect(await screen.findByText(/Nothing was automatically restored/)).toHaveTextContent('Verify management access in Settings to see what is missing, or replace the token there.')
    // A release that manages membership in Cloudflare never offers the token card.
    expect(screen.queryByRole('heading', { name: 'Add your management token' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Resume recorded change' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Cancel recorded change' })).not.toBeInTheDocument()
    expect(accessCheckbox(screen.getByRole('group', { name: 'analyst@example.com' }))).toBeChecked()
    expect(accessCheckbox(screen.getByRole('group', { name: 'analyst@example.com' }))).toBeDisabled()
    expect(client.prepareTeamAction).not.toHaveBeenCalled()
  })

  it('locks uncertain preparation failures until the error retry checks saved state and never exposes raw exception details', async () => {
    const user = userEvent.setup()
    const prepareTeamAction = vi.fn().mockRejectedValue(new Error('private provider detail'))
    const client = renderTeam(api({ prepareTeamAction }))
    const person = await screen.findByRole('group', { name: 'analyst@example.com' })
    await toggleAccess(user, person)
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('The team access request could not be confirmed')
    expect(screen.queryByText('private provider detail')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(accessCheckbox(person)).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled()
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(accessCheckbox(person)).toBeEnabled())
    expect(accessCheckbox(person)).not.toBeChecked()
    expect(client.getTeam).toHaveBeenCalledTimes(2)
    expect(prepareTeamAction).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument()
  })

  it('shows a revision conflict without silently retrying against a newer revision', async () => {
    const user = userEvent.setup()
    const prepareTeamAction = vi.fn().mockRejectedValue(new GatewayApiError(409, 'team_access_revision_conflict'))
    renderTeam(api({ prepareTeamAction }))
    const person = await screen.findByRole('group', { name: 'analyst@example.com' })
    await toggleAccess(user, person)
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Team access changed in another tab')
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(prepareTeamAction).toHaveBeenCalledTimes(1)
  })

  it('does not treat a success callback as proof when action status is unavailable', async () => {
    const user = userEvent.setup()
    window.history.replaceState(null, '', `/team?accessAction=${actionId}&accessActionResult=complete`)
    const client = renderTeam(api({ getTeamAction: vi.fn().mockRejectedValue(new Error('private provider detail')) }))
    expect(await screen.findByRole('alert')).toHaveTextContent('action status is unavailable')
    expect(screen.queryByText(/Team access saved and verified in Cloudflare/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add user' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(client.prepareTeamAction).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add user' })).toBeEnabled())
    expect(window.location.search).not.toContain('accessAction=')
    expect(client.getTeamAction).toHaveBeenCalledTimes(1)
  })

  it('pauses terminal-action polling when the subsequent saved Team read fails', async () => {
    window.history.replaceState(null, '', `/team?accessAction=${actionId}&accessActionResult=complete`)
    const pendingAction: TeamAction = { schemaVersion: 1, actionId, status: 'applying', expiresAt, failureCode: null, canCancel: false }
    let rejectRead!: (error: Error) => void
    const terminalRead = new Promise<Team>((_resolve, reject) => { rejectRead = reject })
    const getTeam = vi.fn<GatewayAdminApi['getTeam']>()
      .mockResolvedValueOnce({ ...team, pendingAction, proposedMembers: team.members })
      .mockReturnValueOnce(terminalRead)
      .mockImplementation(() => new Promise<Team>(() => {}))
    const getTeamAction = vi.fn(async (): Promise<TeamAction> => ({ ...pendingAction, status: 'succeeded' }))
    const client = renderTeam(api({ getTeam, getTeamAction }))
    await waitFor(() => expect(getTeam).toHaveBeenCalledTimes(2))
    await act(async () => { rejectRead(new Error('private provider detail')) })

    expect(await screen.findByRole('alert')).toHaveTextContent('action status is unavailable')
    expect(screen.getByText(/Editing is paused until the recorded state can be checked/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save recorded change' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled()
    expect(screen.queryByText(/private provider detail/)).not.toBeInTheDocument()
    expect(getTeamAction).toHaveBeenCalledTimes(1)
    expect(getTeam).toHaveBeenCalledTimes(2)
    expect(client.prepareTeamAction).not.toHaveBeenCalled()
  })

  it('clears a terminal-action callback after reading a saved Team with no pending action', async () => {
    window.history.replaceState(null, '', `/team?accessAction=${actionId}&accessActionResult=complete`)
    const pendingAction: TeamAction = { schemaVersion: 1, actionId, status: 'applying', expiresAt, failureCode: null, canCancel: false }
    const getTeam = vi.fn<GatewayAdminApi['getTeam']>()
      .mockResolvedValueOnce({ ...team, pendingAction, proposedMembers: team.members })
      .mockResolvedValue({ ...team, revision: 8 })
    const getTeamAction = vi.fn(async (): Promise<TeamAction> => ({ ...pendingAction, status: 'succeeded' }))
    const client = renderTeam(api({ getTeam, getTeamAction }))

    await waitFor(() => expect(getTeam).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(window.location.search).not.toContain('accessAction='))
    expect(screen.getByRole('button', { name: 'Add user' })).toBeEnabled()
    expect(getTeamAction).toHaveBeenCalledTimes(1)
    expect(getTeam).toHaveBeenCalledTimes(2)
    expect(client.prepareTeamAction).not.toHaveBeenCalled()
  })

  it('only reports cancellation after the Worker confirms it and reloads the saved state', async () => {
    const user = userEvent.setup()
    const pendingAction: TeamAction = { schemaVersion: 1, actionId, status: 'authorization_required', expiresAt, failureCode: null, canCancel: true }
    const canceled: TeamAction = { ...pendingAction, status: 'failed', failureCode: 'team_action_cancelled', canCancel: false }
    const proposedMembers = [{ email: 'admin@example.com', sourceIds: [sourceId] }]
    const getTeam = vi.fn().mockResolvedValueOnce({ ...team, pendingAction, proposedMembers }).mockResolvedValue({ ...team, pendingAction: canceled })
    const client = renderTeam(api({ getTeam, getTeamAction: vi.fn(async () => pendingAction), cancelTeamAction: vi.fn(async () => canceled) }))
    await user.click(await screen.findByRole('button', { name: 'Cancel recorded change' }))
    expect(await screen.findByText('The recorded change was canceled before any access policy was changed.')).toBeInTheDocument()
    expect(client.cancelTeamAction).toHaveBeenCalledWith(actionId)
    expect(getTeam).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('button', { name: 'Add user' })).toBeEnabled()
    expect(accessCheckbox(screen.getByRole('group', { name: 'admin@example.com' }))).not.toBeChecked()
  })

  it.each(['authorization_required', 'recovery_required'] as const)('retains a %s proposal without credentials and permits only Worker-approved cancellation', async (actionStatus) => {
    const user = userEvent.setup()
    const pendingAction: TeamAction = { schemaVersion: 1, actionId, status: actionStatus, expiresAt, failureCode: null, canCancel: true }
    const proposedMembers = [{ email: 'admin@example.com', sourceIds: [sourceId] }]
    const canceled: TeamAction = { ...pendingAction, status: 'failed', failureCode: 'team_action_cancelled', canCancel: false }
    const managedInCloudflare = {
      ...team,
      editingEnabled: false,
      editingDisabledReason: 'managed_in_cloudflare' as const,
      managementCredentialConfigured: false,
    }
    const getTeam = vi.fn().mockResolvedValueOnce({ ...managedInCloudflare, pendingAction, proposedMembers }).mockResolvedValue({ ...managedInCloudflare, pendingAction: canceled })
    const client = renderTeam(api({ getTeam, cancelTeamAction: vi.fn(async () => canceled) }))
    expect(await screen.findByText('Recorded change')).toBeInTheDocument()
    const record = accessCheckbox(screen.getByRole('group', { name: 'admin@example.com' }))
    expect(record).toBeChecked()
    expect(record).toBeDisabled()
    expect(screen.getByRole('button', { name: actionStatus === 'recovery_required' ? 'Resume recorded change' : 'Save recorded change' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Cancel recorded change' }))
    expect(await screen.findByText('The recorded change was canceled before any access policy was changed.')).toBeInTheDocument()
    expect(client.cancelTeamAction).toHaveBeenCalledExactlyOnceWith(actionId)
    expect(client.prepareTeamAction).not.toHaveBeenCalled()
  })

  it.each(['authorization_required', 'applying', 'recovery_required'] as const)('does not offer cancellation for a non-cancellable %s action', async (actionStatus) => {
    const pendingAction: TeamAction = { schemaVersion: 1, actionId, status: actionStatus, expiresAt, failureCode: null, canCancel: false }
    const client = renderTeam(api({ getTeam: vi.fn(async () => ({ ...team, pendingAction, proposedMembers: team.members })), getTeamAction: vi.fn(async () => pendingAction) }))
    await screen.findByText('Recorded change')
    expect(screen.queryByRole('button', { name: 'Cancel recorded change' })).not.toBeInTheDocument()
    expect(client.cancelTeamAction).not.toHaveBeenCalled()
    for (const email of ['admin@example.com', 'analyst@example.com']) expect(accessCheckbox(screen.getByRole('group', { name: email }))).toBeDisabled()
  })

  it('does not claim cancellation when the recorded action started applying before cancellation', async () => {
    const user = userEvent.setup()
    const pendingAction: TeamAction = { schemaVersion: 1, actionId, status: 'authorization_required', expiresAt, failureCode: null, canCancel: true }
    const client = renderTeam(api({
      getTeam: vi.fn(async () => ({ ...team, pendingAction, proposedMembers: team.members })),
      getTeamAction: vi.fn(async () => pendingAction),
      cancelTeamAction: vi.fn(async () => ({ ...pendingAction, status: 'applying' as const, canCancel: false })),
    }))
    await user.click(await screen.findByRole('button', { name: 'Cancel recorded change' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Cancellation could not be confirmed')
    expect(screen.queryByText('The recorded change was canceled before any access policy was changed.')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save recorded change' })).toBeDisabled()
    expect(client.cancelTeamAction).toHaveBeenCalledTimes(1)
  })

  it('pauses editing for a pending lifecycle action without hiding team members', async () => {
    const client = renderTeam(api({ getTeam: vi.fn(async () => ({ ...team, editingEnabled: false, editingDisabledReason: 'lifecycle_action_pending' as const })) }))
    expect(await screen.findByText(/Another connector, update, teardown, or management token action is in progress/)).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Add your management token' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(client.prepareTeamAction).not.toHaveBeenCalled()
  })

  it('keeps the real release-review capability disabled and never prepares a write', async () => {
    const user = userEvent.setup()
    const client = renderTeam(api({ getTeam: vi.fn(async () => ({ ...team, editingEnabled: false, editingDisabledReason: 'release_review_required' as const })) }))
    expect(await screen.findByText(/disabled until this gateway release is reviewed and approved/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add user' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Remove analyst@example.com' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    for (const email of ['admin@example.com', 'analyst@example.com']) expect(accessCheckbox(screen.getByRole('group', { name: email }))).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(client.prepareTeamAction).not.toHaveBeenCalled()
  })

  it('shows a safe unavailable state when team loading fails', async () => {
    const getTeam = vi.fn().mockRejectedValue(new Error('private provider detail'))
    renderTeam(api({ getTeam }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Team access could not be loaded.'))
    expect(screen.queryByText('private provider detail')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument()
  })

  it('keeps recovery resume disabled while the release is awaiting approval', async () => {
    const user = userEvent.setup()
    const pendingAction: TeamAction = { schemaVersion: 1, actionId, status: 'recovery_required', expiresAt, failureCode: null, canCancel: false }
    const client = renderTeam(api({ getTeam: vi.fn(async () => ({ ...team, editingEnabled: false, editingDisabledReason: 'release_review_required' as const, pendingAction, proposedMembers: team.members })) }))
    const resume = await screen.findByRole('button', { name: 'Resume recorded change' })
    expect(resume).toBeDisabled()
    await user.click(resume)
    expect(client.prepareTeamAction).not.toHaveBeenCalled()
  })

  it('explicitly labels the local synthetic preview and keeps Team writes disabled', async () => {
    vi.stubEnv('VITE_GATEWAY_UI_PREVIEW', '1')
    window.history.replaceState(null, '', '/team?preview=ready')
    const previewApi = createPreviewGatewayAdminApi()
    if (!previewApi) throw new Error('Expected preview API')
    renderTeam(previewApi)
    expect(screen.getByText(/Local preview — synthetic users; no Cloudflare changes/)).toBeInTheDocument()
    const person = await screen.findByRole('group', { name: 'analyst@example.com' })
    expect(accessCheckbox(person)).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(screen.queryByText(/Team membership is managed directly in Cloudflare/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Team access saved and verified in Cloudflare/)).not.toBeInTheDocument()
    expect(window.location.pathname).toBe('/team')
    expect(screen.queryByText('No unsaved changes')).not.toBeInTheDocument()
    expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument()
  })

  it('saves modal selections in the explicitly editable synthetic preview', async () => {
    vi.stubEnv('VITE_GATEWAY_UI_PREVIEW', '1')
    window.history.replaceState(null, '', '/team?preview=team-editable')
    const previewApi = createPreviewGatewayAdminApi()
    if (!previewApi) throw new Error('Expected preview API')
    const user = userEvent.setup()
    renderTeam(previewApi)
    const person = await screen.findByRole('group', { name: 'analyst@example.com' })
    await toggleAccess(user, person)
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText(/Team access saved and verified in Cloudflare/)).toBeVisible()
    expect(accessCheckbox(person)).toBeChecked()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('keeps direct grants until you move the ones a team already covers', async () => {
    const user = userEvent.setup()
    const prepareTeamAction = vi.fn<(revision: number, members: TeamMember[], teams?: TeamGrant[]) => Promise<never>>(() => new Promise(() => {}))
    renderTeam(api({ prepareTeamAction }))
    await screen.findByRole('group', { name: 'analyst@example.com' })
    await user.click(screen.getByRole('button', { name: 'Create team' }))
    expect(screen.getByText(/A connector you add later stays closed until you add it to this team/)).toBeVisible()
    await user.type(screen.getByLabelText('Name'), 'Finance')
    await user.type(screen.getByLabelText('Members'), 'analyst@example.com')
    await user.click(screen.getByRole('button', { name: 'Add' }))
    await user.click(screen.getByRole('checkbox', { name: 'Company knowledge' }))
    await user.click(screen.getByRole('button', { name: 'Save team' }))
    const teamRow = screen.getByRole('group', { name: 'Finance' })
    expect(teamRow).toHaveTextContent('analyst@example.com')
    expect(screen.getByRole('group', { name: 'analyst@example.com' })).toHaveTextContent('Effective access: Company knowledge (Finance)')
    await toggleAccess(user, screen.getByRole('group', { name: 'analyst@example.com' }), /Company knowledge/)
    expect(screen.getByRole('group', { name: 'analyst@example.com' })).toHaveTextContent('Effective access: Company knowledge (Direct, Finance)')
    await user.click(screen.getByRole('button', { name: 'Move covered direct grants into this team' }))
    expect(screen.getByRole('group', { name: 'analyst@example.com' })).toHaveTextContent('No connectors selected.')
    expect(screen.getByRole('group', { name: 'analyst@example.com' })).toHaveTextContent('Effective access: Company knowledge (Finance)')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(prepareTeamAction).toHaveBeenCalledOnce()
    const savedCall = prepareTeamAction.mock.calls[0]
    if (!savedCall) throw new Error('expected a team save')
    const [, members, teams] = savedCall
    if (!teams?.[0]) throw new Error('expected a team grant')
    expect(members).toEqual([
      { email: 'admin@example.com', sourceIds: [] },
      { email: 'analyst@example.com', sourceIds: [] },
    ])
    expect(teams).toEqual([{
      id: teams[0].id,
      name: 'Finance',
      memberEmails: ['analyst@example.com'],
      sourceIds: [sourceId],
    }])
  })
})
