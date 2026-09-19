import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GatewayAdminApi, GatewayStatus, ManagedSources, RuntimeUpdate } from '../api'
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
    getBigQuerySetups: vi.fn(async () => ({ schemaVersion: 1 as const, available: false, setups: [] })), prepareBigQuery: vi.fn(), resumeBigQuery: vi.fn(),
    getStatus: vi.fn(async () => status),
    getSources: vi.fn(async () => sources),
    getTeam: vi.fn(), prepareTeamAction: vi.fn(), getTeamAction: vi.fn(), cancelTeamAction: vi.fn(),
    getUpdate: vi.fn(async () => update),
    discoverSource: vi.fn(),
    saveSourceDraft: vi.fn(),
    prepareSourceAction: vi.fn(),
    getSourceActions: vi.fn(async () => ({ schemaVersion: 1 as const, actions: [], blockingAction: null })), getSourceAction: vi.fn(),
    cancelSourceAction: vi.fn(), getSourceActionTools: vi.fn(), chooseSourceActionTools: vi.fn(),
    prepareRuntimeAction: vi.fn(),
    getRuntimeAction: vi.fn(),
    prepareTeardownAction: vi.fn(),
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
