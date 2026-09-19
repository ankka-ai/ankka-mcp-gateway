import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GatewayApiError, type GatewayAdminApi, type GatewayStatus, type ManagedSources, type RuntimeUpdate, type SourceActions, type TeardownAction } from '../api'
import { GatewayProvider } from '../GatewayContext'
import { routeTree } from '../router'

const ACTION_ID = `action_${'a'.repeat(32)}`
const REMOVAL_PAGE = '/__ankka/operation/teardown'
const status: GatewayStatus = {
  schemaVersion: 1,
  status: 'ready',
  controlPlaneOrigin: 'https://deploy.ankka.ai',
  release: 'gateway-v1.0.0',
  gateway: { name: 'Example Gateway', hostname: 'mcp.example.com', mcpUrl: 'https://mcp.example.com/mcp', capabilityMode: 'read_only', codeMode: 'default_on' },
  source: null,
  access: { administratorCount: 1, memberCount: 0 },
  updatedAt: '2026-08-27T12:00:00.000Z',
}
const sources: ManagedSources = { schemaVersion: 1, revision: 1, applyMode: 'account_token', installationEnabled: false, sources: [] }
const update: RuntimeUpdate = {
  schemaVersion: 1, channel: 'stable', status: 'up_to_date',
  current: { release: 'gateway-v1.0.0', artifactSha256: `sha256:${'a'.repeat(64)}` }, available: null, rollback: { available: false },
}
const removalRecorded: SourceActions = { schemaVersion: 1, actions: [], blockingAction: { kind: 'teardown', actionId: ACTION_ID } }

function recorded(action: Pick<TeardownAction, 'status'> & Partial<TeardownAction>): TeardownAction {
  return { schemaVersion: 1, actionId: ACTION_ID, expiresAt: '2026-08-27T12:10:00.000Z', failureCode: null, ...action }
}

/** A gateway whose connected resources are gone: its own records still answer, its Team policies do not. */
function api(overrides: Partial<GatewayAdminApi> = {}): GatewayAdminApi {
  return {
    getBigQuerySetups: vi.fn(async () => ({ schemaVersion: 1 as const, available: false, setups: [] })), prepareBigQuery: vi.fn(), resumeBigQuery: vi.fn(),
    getStatus: vi.fn(async () => status),
    getSources: vi.fn(async () => sources),
    getTeam: vi.fn(async () => { throw new GatewayApiError(503, 'team_unavailable') }),
    prepareTeamAction: vi.fn(), getTeamAction: vi.fn(), cancelTeamAction: vi.fn(),
    getUpdate: vi.fn(async () => update),
    discoverSource: vi.fn(), saveSourceDraft: vi.fn(), prepareSourceAction: vi.fn(),
    getSourceActions: vi.fn(async () => removalRecorded), getSourceAction: vi.fn(), cancelSourceAction: vi.fn(), getSourceActionTools: vi.fn(), chooseSourceActionTools: vi.fn(),
    prepareRuntimeAction: vi.fn(), getRuntimeAction: vi.fn(),
    prepareManagementCredentialAction: vi.fn(), verifyManagementAccess: vi.fn(),
    prepareTeardownAction: vi.fn(async () => ({ schemaVersion: 1 as const, actionId: `action_${'b'.repeat(32)}`, status: 'authorization_required' as const,
      expiresAt: '2030-01-01T00:00:00.000Z', handoffUrl: `${window.location.origin}${REMOVAL_PAGE}#${'h'.repeat(40)}` })),
    getTeardownAction: vi.fn(async () => recorded({ status: 'recovery_required', failureCode: 'fresh_authorization_required' })),
    ...overrides,
  }
}

function open(client: GatewayAdminApi, path = '/settings') {
  // The router keeps its own history, so the window's address can stand on the removal page: jsdom follows a fragment, not a navigation.
  window.history.replaceState(null, '', REMOVAL_PAGE)
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [path] }) })
  return render(<GatewayProvider api={client}><RouterProvider router={router} /></GatewayProvider>)
}

describe('AppShell during a removal', () => {
  afterEach(() => { cleanup(); vi.useRealTimers(); window.history.replaceState(null, '', '/') })

  it('still loads when Team answers 503 and offers the way back into the interrupted removal', async () => {
    const client = api()
    open(client)

    expect(await screen.findByRole('heading', { name: 'Settings', level: 1 })).toBeInTheDocument()
    expect(await screen.findByText(/could not read your Team policies\. Verify management access/u)).toBeInTheDocument()
    const notice = (await screen.findByText('Removal in progress')).closest('[role="status"]')
    expect(notice).toHaveTextContent('some of its connected resources may already be gone')
    expect(notice).toHaveTextContent('it resumes from the saved progress')
    expect(screen.queryByText('Couldn’t load the gateway')).not.toBeInTheDocument()
    expect(client.getTeardownAction).toHaveBeenCalledWith(ACTION_ID)

    fireEvent.click(screen.getByRole('button', { name: 'Continue removing this gateway' }))
    await waitFor(() => expect(window.location.hash).toBe(`#${'h'.repeat(40)}`))
    expect(client.prepareTeardownAction).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['the connected resources are gone and the attempt never settled', recorded({ status: 'gateway_removed' })],
    ['an attempt outlived its authorization without settling', recorded({ status: 'applying', expiresAt: '2020-01-01T00:00:00.000Z' })],
  ])('treats a removal as interrupted when %s', async (_name, action) => {
    open(api({ getTeardownAction: vi.fn(async () => action) }))
    expect(await screen.findByRole('button', { name: 'Continue removing this gateway' })).toBeInTheDocument()
  })

  it('offers no second authorization while an attempt is still removing', async () => {
    open(api({ getTeardownAction: vi.fn(async () => recorded({ status: 'applying', expiresAt: '2999-01-01T00:00:00.000Z' })) }))
    expect(await screen.findByText(/removing its connected resources right now/u)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Continue removing this gateway' })).not.toBeInTheDocument()
  })

  it.each([
    ['a reviewed plan that was never authorized', recorded({ status: 'authorization_required', expiresAt: '2999-01-01T00:00:00.000Z' })],
    ['an attempt that ended before its first deletion', recorded({ status: 'failed', failureCode: 'fresh_authorization_required' })],
  ])('shows no removal for %s', async (_name, action) => {
    const client = api({ getTeardownAction: vi.fn(async () => action) })
    open(client)
    expect(await screen.findByRole('heading', { name: 'Settings', level: 1 })).toBeInTheDocument()
    await waitFor(() => expect(client.getTeardownAction).toHaveBeenCalled())
    expect(screen.queryByText('Removal in progress')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Review teardown plan' })).toBeInTheDocument()
  })

  it('offers the same action in place of the load failure, without needing what failed to load', async () => {
    const client = api({ getStatus: vi.fn(async () => { throw new GatewayApiError(503, 'request_failed') }) })
    open(client)

    expect(await screen.findByRole('heading', { name: 'Removal in progress', level: 1 })).toBeInTheDocument()
    expect(screen.queryByText('Couldn’t load the gateway')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Continue removing this gateway' }))
    await waitFor(() => expect(window.location.hash).toBe(`#${'h'.repeat(40)}`))
    expect(client.getStatus).toHaveBeenCalledTimes(1)
  })

  it('keeps the removal state and names the refusal when the gateway cannot prepare another authorization yet', async () => {
    const client = api({
      getStatus: vi.fn(async () => { throw new GatewayApiError(503, 'request_failed') }),
      prepareTeardownAction: vi.fn(async () => { throw new GatewayApiError(409, 'teardown_action_conflict') }),
    })
    open(client)
    fireEvent.click(await screen.findByRole('button', { name: 'Continue removing this gateway' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('wait for an open removal authorization to expire')
    expect(screen.getByRole('heading', { name: 'Removal in progress', level: 1 })).toBeInTheDocument()
  })

  it('keeps the plain load failure when no removal is recorded', async () => {
    const client = api({
      getStatus: vi.fn(async () => { throw new GatewayApiError(503, 'request_failed') }),
      getSourceActions: vi.fn(async () => ({ schemaVersion: 1 as const, actions: [], blockingAction: null })),
    })
    open(client)
    expect(await screen.findByRole('heading', { name: 'Couldn’t load the gateway', level: 1 })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
    expect(client.getTeardownAction).not.toHaveBeenCalled()
  })
})
