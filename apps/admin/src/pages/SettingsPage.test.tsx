import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GatewayApiError, type GatewayAdminApi, type GatewayStatus, type ManagedSources, type ManagementVerification, type RuntimeUpdate, type ManagementCredentialStatus } from '../api'
import { GatewayProvider } from '../GatewayContext'
import { router, routeTree } from '../router'
import { SettingsPage } from './SettingsPage'

const status: GatewayStatus = {
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
  access: { administratorCount: 1, memberCount: 0 },
  updatedAt: '2026-08-27T12:00:00.000Z',
}
const sources: ManagedSources = {
  schemaVersion: 1, revision: 1, applyMode: 'oauth_per_action', installationEnabled: false, sources: [],
}
const update: RuntimeUpdate = {
  schemaVersion: 1,
  channel: 'stable',
  status: 'up_to_date',
  current: { release: 'gateway-v1.0.0', artifactSha256: `sha256:${'a'.repeat(64)}` },
  available: null,
  rollback: { available: false },
}

function api(): GatewayAdminApi {
  return {
    removeSource: vi.fn(), getBigQuerySetups: vi.fn(async () => ({ schemaVersion: 1 as const, available: false, setups: [] })), prepareBigQuery: vi.fn(), resumeBigQuery: vi.fn(),
    getStatus: vi.fn(async () => status),
    getSources: vi.fn(async () => sources),
    getTeam: vi.fn(), prepareTeamAction: vi.fn(), getTeamAction: vi.fn(), cancelTeamAction: vi.fn(),
    getUpdate: vi.fn(async () => update),
    discoverSource: vi.fn(),
    prepareBigQueryRemoval: vi.fn(), removeSourceDraft: vi.fn(), saveSourceDraft: vi.fn(),
    prepareSourceAction: vi.fn(),
    getSourceActions: vi.fn(async () => ({ schemaVersion: 1 as const, actions: [], blockingAction: null })), getSourceAction: vi.fn(),
    cancelSourceAction: vi.fn(), getSourceActionTools: vi.fn(), authorizeSource: vi.fn<GatewayAdminApi['authorizeSource']>(), chooseSourceActionTools: vi.fn(),
    prepareRuntimeAction: vi.fn(),
    getRuntimeAction: vi.fn(),
    prepareTeardownAction: vi.fn(),
    getManagementCredentialStatus: vi.fn(), prepareManagementCredentialAction: vi.fn(), verifyManagementAccess: vi.fn(),
    getTeardownAction: vi.fn(),
  }
}

describe('SettingsPage danger zone', () => {
  const originalScrollIntoView = HTMLElement.prototype.scrollIntoView
  afterEach(() => {
    window.history.replaceState(null, '', '/')
    HTMLElement.prototype.scrollIntoView = originalScrollIntoView
  })

  it('focuses the receipt-authorized teardown section from the installer handoff', async () => {
    window.history.replaceState(null, '', '/?teardown=review')
    const scrollIntoView = vi.fn()
    HTMLElement.prototype.scrollIntoView = scrollIntoView

    render(<GatewayProvider api={api()}><RouterProvider router={router} /></GatewayProvider>)

    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/settings')
    const button = screen.getByRole('button', { name: 'Review teardown plan' })
    const section = button.closest('section')
    await waitFor(() => expect(section).toHaveFocus())
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' })
    expect(screen.getByText(/Opening the plan does not change your gateway/u)).toBeInTheDocument()
  })
})

describe('SettingsPage rollback', () => {
  beforeEach(cleanup)
  afterEach(() => { cleanup(); window.history.replaceState(null, '', '/') })
  const recorded = { release: 'gateway-v0.9.9', artifactSha256: `sha256:${'b'.repeat(64)}` }
  const restorable: RuntimeUpdate = { ...update, rollback: { available: true, ...recorded, dataRollback: false } }
  const excluded: RuntimeUpdate = { ...update, rollback: { available: false, reason: 'minimum_runtime_release', release: recorded.release } }

  it('offers the rollback the gateway reports as available', async () => {
    const client = api()
    client.getUpdate = vi.fn(async () => restorable)
    render(<GatewayProvider api={client}><SettingsPage /></GatewayProvider>)
    expect(await screen.findByRole('button', { name: 'Rollback' })).toBeEnabled()
    expect(screen.queryByText(/no longer roll back/u)).not.toBeInTheDocument()
  })

  it('offers no rollback button and says why once the recorded release can no longer be restored', async () => {
    const client = api()
    client.getUpdate = vi.fn(async () => excluded)
    render(<GatewayProvider api={client}><SettingsPage /></GatewayProvider>)
    expect(await screen.findByText('You can no longer roll back to gateway-v0.9.9. A source was installed or Team access was changed after the update, and the older version cannot work with those changes.')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Rollback' })).not.toBeInTheDocument()
    expect(client.prepareRuntimeAction).not.toHaveBeenCalled()
  })

  it('says nothing about rollback when no earlier release is recorded', async () => {
    render(<GatewayProvider api={api()}><SettingsPage /></GatewayProvider>)
    expect(await screen.findByText('Software updates')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Rollback' })).not.toBeInTheDocument()
    expect(screen.queryByText(/roll back/u)).not.toBeInTheDocument()
  })

  it('reads the update answer again when opened after another page, so an installation that ended the rollback shows', async () => {
    const client = api()
    client.getUpdate = vi.fn<GatewayAdminApi['getUpdate']>().mockResolvedValueOnce(restorable).mockResolvedValue(excluded)
    const pages = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: ['/sources'] }) })
    render(<GatewayProvider api={client}><RouterProvider router={pages} /></GatewayProvider>)
    await screen.findByRole('heading', { name: 'Sources', level: 1 })
    await waitFor(() => expect(client.getUpdate).toHaveBeenCalledTimes(1))
    await act(() => pages.navigate({ to: '/settings' }))
    expect(await screen.findByText(/You can no longer roll back to gateway-v0\.9\.9\./u)).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Rollback' })).not.toBeInTheDocument()
    expect(client.getUpdate).toHaveBeenCalledTimes(2)
  })
})

describe('SettingsPage management token', () => {
  beforeEach(cleanup)
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); window.history.replaceState(null, '', '/') })
  const ACTION = `action_${'m'.repeat(32)}`
  const withoutToken: ManagementCredentialStatus = {
    schemaVersion: 1, managementCredentialConfigured: false, managementCredentialChoice: 'skipped',
  }
  const withToken: ManagementCredentialStatus = { ...withoutToken, managementCredentialConfigured: true }
  const verified: ManagementVerification = { schemaVersion: 1, status: 'verified', token: 'active', portals: 'verified', accessPolicies: 'verified' }

  function section() {
    const found = screen.getByRole('heading', { name: 'Cloudflare management' }).closest('section')
    if (found === null) throw new Error('management section missing')
    return within(found)
  }
  /** The page renders once the update answer is in; the section is there from then on. */
  async function opened() {
    await screen.findByRole('heading', { name: 'Cloudflare management' })
    return section()
  }

  it('offers one way to add the token, says why it is missing, and no longer sends anyone to Cloudflare’s secret settings', async () => {
    const client = api()
    client.getManagementCredentialStatus = vi.fn(async () => withoutToken)
    // jsdom follows a fragment, not a navigation: stand on the operation page so the handoff is observable.
    window.history.replaceState(null, '', '/__ankka/operation')
    const prepared = { schemaVersion: 1 as const, actionId: ACTION, status: 'authorization_required' as const, expiresAt: '2030-01-01T00:00:00.000Z', handoffUrl: `${window.location.origin}/__ankka/operation#${'a'.repeat(40)}` }
    client.prepareManagementCredentialAction = vi.fn(async () => prepared)
    const user = userEvent.setup()
    const { container } = render(<GatewayProvider api={client}><SettingsPage /></GatewayProvider>)

    expect(await (await opened()).findByRole('heading', { name: 'Add your management token' })).toBeInTheDocument()
    expect(section().getByText('You skipped the token during setup.')).toBeVisible()
    expect(section().getByText(/Create the token first as a Cloudflare account Administrator/u)).toBeVisible()
    expect(container.textContent).not.toMatch(/Variables and Secrets|encrypted secret named|Enter the token only in Cloudflare|wrangler/u)
    expect(section().queryByRole('button', { name: 'Verify management access' })).not.toBeInTheDocument()
    expect(section().queryByRole('button', { name: 'Replace management token' })).not.toBeInTheDocument()
    // The dashboard never takes the token itself.
    expect(container.querySelector('input')).toBeNull()

    await user.click(section().getByRole('button', { name: 'Add management token' }))
    expect(client.prepareManagementCredentialAction).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(window.location.hash).toBe(`#${'a'.repeat(40)}`))
  })

  it('offers replacement through the same steps and says who deletes the old token, by its name', async () => {
    const client = api()
    client.getManagementCredentialStatus = vi.fn(async () => withToken)
    render(<GatewayProvider api={client}><SettingsPage /></GatewayProvider>)
    expect(await (await opened()).findByText('Management token configured.')).toBeVisible()
    expect(client.getTeam).not.toHaveBeenCalled()
    expect(section().getByRole('button', { name: 'Replace management token' })).toBeEnabled()
    expect(section().getByRole('button', { name: 'Verify management access' })).toBeEnabled()
    const details = section().getByText('Token details').closest('details')
    expect(details).not.toHaveAttribute('open')
    expect(details).toHaveTextContent(`Look for Ankka gateway ${window.location.hostname}; the older creation date identifies the previous token.`)
    expect(details).toHaveTextContent('Replacing the token or removing your gateway does not delete it.')
    expect(section().queryByRole('heading', { name: 'Add your management token' })).not.toBeInTheDocument()
  })

  const verifications: [ManagementVerification, string[]][] = [
    [verified, ['Verified. The token is active with MCP Portals Edit and Access: Apps and Policies Edit permissions.']],
    [{ ...verified, status: 'permission_missing', accessPolicies: 'permission_missing' }, [
      'The token is active.', 'MCP Portals Edit: proven. Your gateway wrote its own MCP Portal back unchanged.',
      'Access: Apps and Policies Edit: missing. Cloudflare refused the token for your gateway’s own Portal Access policy.',
      'Create a new token from the link, which fills in both permissions, and replace this one.']],
    [{ ...verified, status: 'permission_missing', portals: 'permission_missing' }, [
      'MCP Portals Edit: missing. Cloudflare refused the token for your gateway’s own MCP Portal.',
      'Access: Apps and Policies Edit: proven. Your gateway wrote its own Portal Access policy back unchanged.']],
    [{ ...verified, status: 'drift', portals: 'drift' }, [
      'MCP Portals Edit: not proven. Your gateway’s own MCP Portal no longer matches what your gateway recorded, so nothing was written to it. Review it in Cloudflare; this page does not reset it.']],
    [{ ...verified, status: 'unconfirmed', accessPolicies: 'unconfirmed' }, [
      'Access: Apps and Policies Edit: not confirmed. Cloudflare gave no clear answer for your gateway’s own Portal Access policy, or your gateway’s records could not be read.']],
    [{ ...verified, status: 'rejected', token: 'rejected', portals: 'not_checked', accessPolicies: 'not_checked' }, [
      'Cloudflare rejected the token: it was revoked, has expired, or belongs to another account. Replace it.']],
    [{ ...verified, status: 'unconfirmed', token: 'unconfirmed', portals: 'not_checked', accessPolicies: 'not_checked' }, [
      'Cloudflare did not answer the token check, so nothing is proven yet. Try again in a moment.']],
    [{ ...verified, status: 'busy', token: 'not_checked', portals: 'not_checked', accessPolicies: 'not_checked' }, [
      'A source installation, update, removal, Team change or token change is unfinished, so nothing was checked. Verify again when it has finished.']],
    [{ ...verified, status: 'missing', token: 'missing', portals: 'not_checked', accessPolicies: 'not_checked' }, [
      'Your gateway has no management token.']],
  ]
  it.each(verifications)('says what a verification proved: %j', async (answer, lines) => {
    const client = api()
    client.getManagementCredentialStatus = vi.fn(async () => withToken)
    client.verifyManagementAccess = vi.fn(async () => answer)
    const user = userEvent.setup()
    render(<GatewayProvider api={client}><SettingsPage /></GatewayProvider>)
    await user.click(await (await opened()).findByRole('button', { name: 'Verify management access' }))
    for (const line of lines) expect(await (await opened()).findByText(line)).toBeVisible()
    expect(client.verifyManagementAccess).toHaveBeenCalledTimes(1)
  })

  it('keeps Verify and Replace reachable when token status cannot be read', async () => {
    const client = api()
    client.getManagementCredentialStatus = vi.fn(async () => { throw new GatewayApiError(503, 'management_credential_unavailable') })
    client.verifyManagementAccess = vi.fn(async () => { throw new GatewayApiError(503, 'management_credential_unavailable') })
    const user = userEvent.setup()
    render(<GatewayProvider api={client}><SettingsPage /></GatewayProvider>)
    expect(await (await opened()).findByText('Your gateway could not read its management token status. Reload this page or verify management access.')).toBeVisible()
    expect(section().getByRole('button', { name: 'Replace management token' })).toBeEnabled()
    await user.click(section().getByRole('button', { name: 'Verify management access' }))
    expect(await (await opened()).findByRole('alert')).toHaveTextContent('The check could not be run. Reload this page and try again.')
  })

  it('notices by itself when the token arrives after the flow returns, then offers verification', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    window.history.replaceState(null, '', `/settings?managementCredentialAction=${ACTION}&managementCredentialActionResult=applied`)
    const client = api()
    client.getManagementCredentialStatus = vi.fn<GatewayAdminApi['getManagementCredentialStatus']>()
      .mockResolvedValueOnce(withoutToken).mockResolvedValueOnce(withoutToken).mockResolvedValue(withToken)
    render(<GatewayProvider api={client}><SettingsPage /></GatewayProvider>)

    expect(await (await opened()).findByText(/Cloudflare accepted the token\. Waiting for your gateway to start with it/u)).toBeVisible()
    // The answer leaves the address at once, so a reload starts clean.
    expect(window.location.search).toBe('')
    // While it waits there is no second "Add" card and nothing to verify yet.
    expect(section().queryByRole('heading', { name: 'Add your management token' })).not.toBeInTheDocument()
    expect(section().queryByRole('button', { name: 'Verify management access' })).not.toBeInTheDocument()

    await act(() => vi.advanceTimersByTimeAsync(3_000))
    await act(() => vi.advanceTimersByTimeAsync(3_000))
    expect(await (await opened()).findByText('Cloudflare accepted the token. Your gateway now runs with it. Verify management access to prove that it can do its work.')).toBeVisible()
    expect(client.getManagementCredentialStatus).toHaveBeenCalledTimes(3)
    // Sources were loaded while the token was missing: they are read again, so the Sources page is not left disabled.
    expect(client.getSources).toHaveBeenCalledTimes(2)
    expect(section().getByRole('button', { name: 'Verify management access' })).toBeEnabled()
    expect(section().getByRole('button', { name: 'Replace management token' })).toBeEnabled()
    // It stops asking once the token is there.
    await act(() => vi.advanceTimersByTimeAsync(30_000))
    expect(client.getManagementCredentialStatus).toHaveBeenCalledTimes(3)
  })

  it.each([
    ['failed', 'approval_expired', 'Cloudflare’s approval ran out before the token arrived, so nothing was saved. Approvals last only a few minutes. Start again when you are ready to create and paste the token.'],
    ['failed', 'paste_page_closed', 'The page that takes the token was reloaded before the token was pasted, so its approval could not be used any more. Nothing was saved. Start again.'],
    ['failed', 'secret_write_http_403', 'Your gateway could not save the token (secret_write_http_403). Nothing else was changed. Start again.'],
    ['denied', null, 'You declined the approval in Cloudflare. Nothing was changed.'],
    ['cancelled', null, 'You stopped before pasting a token. Nothing was changed.'],
  ] as const)('says how a change ended without a token: %s %s', async (result, reason, message) => {
    window.history.replaceState(null, '', `/settings?managementCredentialAction=${ACTION}&managementCredentialActionResult=${result}${reason === null ? '' : `&managementCredentialActionReason=${reason}`}`)
    const client = api()
    client.getManagementCredentialStatus = vi.fn(async () => withoutToken)
    render(<GatewayProvider api={client}><SettingsPage /></GatewayProvider>)
    expect(await (await opened()).findByText(message)).toBeVisible()
    // Nothing arrived, so nothing is polled: one read, and the way to start again is right there.
    expect(await (await opened()).findByRole('button', { name: 'Add management token' })).toBeEnabled()
    expect(client.getManagementCredentialStatus).toHaveBeenCalledTimes(1)
    expect(window.location.search).toBe('')
  })

  it('ignores a result it was not handed by its own gateway’s shape', async () => {
    window.history.replaceState(null, '', '/settings?managementCredentialAction=not-an-action&managementCredentialActionResult=applied&managementCredentialActionReason=%3Cscript%3E')
    const client = api()
    client.getManagementCredentialStatus = vi.fn(async () => withoutToken)
    render(<GatewayProvider api={client}><SettingsPage /></GatewayProvider>)
    expect(await (await opened()).findByRole('button', { name: 'Add management token' })).toBeEnabled()
    expect(section().queryByText(/Cloudflare accepted the token/u)).not.toBeInTheDocument()
    expect(window.location.search).toBe('')
  })
})
