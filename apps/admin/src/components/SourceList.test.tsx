import { act, cleanup, fireEvent, render, screen, within, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ManagedSource, SourceConnection } from '../api'
import { SourceList } from './SourceList'
import { CONNECTION_CACHE_KEY, CONNECTION_CHECK_TIMEOUT_MS } from './SourceConnection'

const sources: [ManagedSource, ManagedSource] = [
  { id: 'source-1111111111111111', label: 'Knowledge', url: 'https://knowledge.example.com/mcp', authMode: 'oauth', onBehalfOfUser: false, enabledTools: ['search', 'fetch_document'], status: 'installed' },
  { id: 'source-2222222222222222', label: 'Catalogue', url: 'https://catalogue.example.com/mcp', authMode: 'none', onBehalfOfUser: false, enabledTools: ['list_products'], status: 'draft' },
]

const checkConnection = async (sourceId: string): Promise<SourceConnection> => ({
  schemaVersion: 1, sourceId, state: 'connected', checkedAt: '2026-10-03T10:00:00.000Z', reason: null,
})

describe('SourceList', () => {
  afterEach(() => {
    cleanup()
    sessionStorage.removeItem(CONNECTION_CACHE_KEY)
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('offers a recoverable shared-connection switch only for legacy Gateway Management', async () => {
    const user = userEvent.setup()
    const source = { ...sources[0], id: 'source-616e6b6b616d6370', label: 'Gateway Management', onBehalfOfUser: true }
    const onShareManagement = vi.fn().mockRejectedValueOnce(new Error('synthetic failure')).mockResolvedValue(undefined)
    const props = { sources: [source], installationEnabled: true, isBusy: false, onAuthorize: vi.fn(), onShareManagement }
    const { rerender } = render(<SourceList {...props} />)
    expect(screen.queryByRole('button', { name: 'Use shared connection' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Gateway Management' }))
    await user.click(screen.getByRole('button', { name: 'Use shared connection' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Try again to resume')
    await user.click(screen.getByRole('button', { name: 'Use shared connection' }))
    expect(onShareManagement).toHaveBeenCalledTimes(2)
    rerender(<SourceList {...props} sources={[{ ...source, onBehalfOfUser: false }]} />)
    expect(screen.queryByRole('button', { name: 'Use shared connection' })).not.toBeInTheDocument()
    expect(screen.getByText('Operator-connected OAuth')).toBeInTheDocument()
  })

  it('filters verified connections and connectors needing attention without changing them', async () => {
    const user = userEvent.setup()
    const onAuthorize = vi.fn()
    render(<SourceList onCheckConnection={checkConnection} sources={sources} installationEnabled isBusy={false} onAuthorize={onAuthorize} />)
    const filters = within(screen.getByRole('group', { name: 'Filter connectors' }))

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Connected'))
    await user.click(filters.getByRole('button', { name: 'Connected' }))
    expect(filters.getByRole('button', { name: 'Connected' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Knowledge' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Catalogue' })).not.toBeInTheDocument()

    await user.click(filters.getByRole('button', { name: 'Needs attention' }))
    expect(screen.queryByRole('button', { name: 'Knowledge' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Catalogue' })).toBeInTheDocument()

    await user.click(filters.getByRole('button', { name: 'All' }))
    expect(screen.getByRole('button', { name: 'Knowledge' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Catalogue' })).toBeInTheDocument()
    expect(onAuthorize).not.toHaveBeenCalled()
  })

  it('keeps details collapsed until the connector is expanded with the keyboard', async () => {
    const user = userEvent.setup()
    render(<SourceList onCheckConnection={checkConnection} sources={sources} installationEnabled isBusy={false} onAuthorize={vi.fn()} />)
    const source = screen.getByRole('button', { name: 'Knowledge' })
    expect(source).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText(sources[0].url)).not.toBeInTheDocument()

    source.focus()
    await user.keyboard('{Enter}')
    expect(source).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText(sources[0].url)).toBeInTheDocument()
    expect(screen.getByText('Operator-connected OAuth')).toBeInTheDocument()
    expect(screen.getByText('2 tools')).toBeInTheDocument()
    expect(within(screen.getByRole('region', { name: 'Knowledge allowed tools' })).getByText('search')).toBeInTheDocument()

    await user.keyboard('{Enter}')
    expect(source).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText(sources[0].url)).not.toBeInTheDocument()
  })

  it('preserves draft authorization and respects installation and busy restrictions', async () => {
    const user = userEvent.setup()
    const onAuthorize = vi.fn()
    const { rerender } = render(<SourceList onCheckConnection={checkConnection} sources={sources} installationEnabled isBusy={false} onAuthorize={onAuthorize} />)

    await user.click(screen.getByRole('button', { name: 'Install connector' }))
    expect(onAuthorize).toHaveBeenCalledExactlyOnceWith(sources[1].id)

    rerender(<SourceList onCheckConnection={checkConnection} sources={sources} installationEnabled={false} isBusy={false} onAuthorize={onAuthorize} />)
    expect(screen.getByRole('button', { name: 'Installation unavailable' })).toBeDisabled()
    rerender(<SourceList onCheckConnection={checkConnection} sources={sources} installationEnabled isBusy onAuthorize={onAuthorize} />)
    expect(screen.getByRole('button', { name: /Install connector/u })).toBeDisabled()
  })

  it('shows an empty filtered state without hiding the filters', async () => {
    const user = userEvent.setup()
    render(<SourceList onCheckConnection={checkConnection} sources={[sources[0]]} installationEnabled isBusy={false} onAuthorize={vi.fn()} />)
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Connected'))
    await user.click(screen.getByRole('button', { name: 'Needs attention' }))
    expect(screen.getByText('No connectors need attention.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'All' }))
    expect(screen.getByRole('button', { name: 'Knowledge' })).toBeInTheDocument()
  })

  it('searches names and URLs alongside the status filter', async () => {
    const user = userEvent.setup()
    const onAuthorize = vi.fn()
    render(<SourceList onCheckConnection={checkConnection} sources={sources} installationEnabled isBusy={false} onAuthorize={onAuthorize} />)
    const search = screen.getByRole('searchbox', { name: 'Search connectors' })

    await user.type(search, 'KNOWLEDGE')
    expect(screen.getByRole('button', { name: 'Knowledge' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Catalogue' })).not.toBeInTheDocument()

    await user.clear(search)
    await user.type(search, 'catalogue.example.com')
    expect(screen.getByRole('button', { name: 'Catalogue' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Connected' }))
    expect(screen.getByText('No matching connectors.')).toBeInTheDocument()

    await user.clear(search)
    expect(screen.getByRole('button', { name: 'Knowledge' })).toBeInTheDocument()
    expect(onAuthorize).not.toHaveBeenCalled()
  })

  it.each([undefined, 'gateway'] as const)('fetches synced tools and saves only the explicit selection', async (catalogueSource) => {
    const user = userEvent.setup()
    const bare = { title: null, description: null, readOnlyHint: null, destructiveHint: null, openWorldHint: null }
    const onLoadSourceTools = vi.fn(async () => ({
      schemaVersion: 1 as const, sourceId: sources[0].id, revision: 4, state: 'ready' as const, pendingTools: null,
      catalogueSource,
      enabledTools: ['fetch_document', 'search'],
      tools: [
        { name: 'export_document', ...bare, description: 'Export a page.', readOnlyHint: true, destructiveHint: false },
        { name: 'fetch_document', ...bare },
        { name: 'search', ...bare, description: 'Find a page.', readOnlyHint: true, destructiveHint: false },
      ],
    }))
    const onSaveSourceTools = vi.fn(async () => {})
    const { rerender } = render(<SourceList onCheckConnection={checkConnection} sources={sources} installationEnabled isBusy={false} onAuthorize={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: 'Knowledge' }))
    expect(screen.queryByRole('button', { name: 'Edit tools' })).not.toBeInTheDocument()

    rerender(<SourceList onCheckConnection={checkConnection} sources={sources} installationEnabled isBusy={false} onAuthorize={vi.fn()} onLoadSourceTools={onLoadSourceTools} onSaveSourceTools={onSaveSourceTools} />)
    await user.click(screen.getByRole('button', { name: 'Edit tools' }))
    expect(onLoadSourceTools).toHaveBeenCalledExactlyOnceWith(sources[0].id)
    expect(await screen.findByRole('checkbox', { name: /export_document/ })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: /^search/ })).toBeChecked()
    expect(screen.getByText(/Choose individual tools or allow all current and future tools/)).toBeInTheDocument()
    if (catalogueSource === 'gateway') {
      expect(screen.getByText(/in your installed gateway release/)).toBeInTheDocument()
      expect(screen.getByText(/automatically syncs Gateway Management/)).toBeInTheDocument()
      expect(screen.queryByText(/as Cloudflare synced them/)).not.toBeInTheDocument()
    }

    await user.click(screen.getByRole('checkbox', { name: /export_document/ }))
    await user.click(screen.getByRole('button', { name: 'Save tools' }))
    expect(onSaveSourceTools).toHaveBeenCalledExactlyOnceWith(sources[0].id, 4, ['export_document', 'fetch_document', 'search'], [], false)
  })

  it('renames an installed connector and leaves a draft unnamed', async () => {
    const user = userEvent.setup()
    const onRenameSource = vi.fn(async () => {})
    render(<SourceList onCheckConnection={checkConnection} sources={sources} installationEnabled isBusy={false} onAuthorize={vi.fn()} onRenameSource={onRenameSource} />)
    await user.click(screen.getByRole('button', { name: 'Catalogue' }))
    expect(screen.queryByRole('button', { name: 'Save details' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Knowledge' }))
    const name = screen.getByLabelText('Name')
    expect(name).toHaveValue('Knowledge')
    expect(screen.getByRole('button', { name: 'Save details' })).toBeDisabled()
    await user.clear(name)
    await user.type(name, 'Company knowledge')
    await user.click(screen.getByRole('button', { name: 'Save details' }))
    expect(onRenameSource).toHaveBeenCalledExactlyOnceWith(sources[0].id, 'Company knowledge', '')
  })
  it('previews company context and allows clearing it without changing the connector name', async () => {
    const user = userEvent.setup()
    const onRenameSource = vi.fn(async () => {})
    const scoped = { ...sources[0], company: 'Company B' }
    render(<SourceList onCheckConnection={checkConnection} sources={[scoped]} installationEnabled isBusy={false} onAuthorize={vi.fn()} onRenameSource={onRenameSource} />)
    await user.click(screen.getByRole('button', { name: 'Company B · Knowledge' }))
    const company = screen.getByLabelText('Company (optional)')
    expect(company).toHaveValue('Company B')
    expect(screen.getByLabelText('Name')).toHaveValue('Knowledge')
    await user.clear(company)
    await user.click(screen.getByRole('button', { name: 'Save details' }))
    expect(onRenameSource).toHaveBeenCalledExactlyOnceWith(scoped.id, 'Knowledge', '')
    await user.type(company, 'Company A')
    expect(screen.getByText('Company A · Knowledge')).toBeVisible()
  })

  it('shows an installed connector as requiring reconnection and replaces earlier success', async () => {
    const user = userEvent.setup()
    const reconnectUrl = 'https://dash.cloudflare.com/' + 'a'.repeat(32) + '/one/access-controls/ai-controls/mcp-server/edit/server-synthetic'
    const check = vi.fn().mockImplementationOnce(checkConnection).mockResolvedValue({
      schemaVersion: 1, sourceId: sources[0].id, state: 'authorization_required',
      checkedAt: '2026-10-03T10:01:00.000Z', reason: null, reconnectUrl,
    })
    render(<SourceList sources={sources} onCheckConnection={check} installationEnabled isBusy={false} onAuthorize={vi.fn()} />)
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Connected'))
    expect(screen.queryByRole('link', { name: /Reconnect/ })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Check connections' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Reconnect required'))
    expect(screen.queryByRole('link', { name: /Open .*in Cloudflare/ })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Knowledge' }))
    expect(screen.getByText(/Choose Reconnect to sign in again/)).toBeVisible()
    expect(document.querySelector('time')).toHaveAttribute('datetime', '2026-10-03T10:01:00.000Z')
    await user.click(screen.getByRole('button', { name: 'Connected' }))
    expect(screen.queryByRole('button', { name: 'Knowledge' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Needs attention' }))
    expect(screen.getByRole('button', { name: 'Knowledge' })).toBeVisible()
  })

  it('explains when an unfinished gateway change pauses a connection check', async () => {
    const user = userEvent.setup()
    const check = vi.fn().mockResolvedValue({ schemaVersion: 1, sourceId: sources[0].id,
      state: 'unknown', reason: 'lifecycle_pending', checkedAt: null })
    render(<SourceList sources={sources} onCheckConnection={check} installationEnabled isBusy={false} onAuthorize={vi.fn()} />)
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Check paused'))
    await user.click(screen.getByRole('button', { name: 'Knowledge' }))
    expect(screen.getByText(/Connection checking is paused while a gateway change is unfinished/)).toBeVisible()
  })

  it('restores the last result on remount and refreshes it without showing checking states', async () => {
    const user = userEvent.setup()
    const first = render(<SourceList sources={sources} onCheckConnection={checkConnection} connectionRevision={4} installationEnabled isBusy={false} onAuthorize={vi.fn()} />)
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Connected'))
    first.unmount()

    let finish!: (result: SourceConnection) => void
    const check = vi.fn(() => new Promise<SourceConnection>(resolve => { finish = resolve }))
    render(<SourceList sources={sources} onCheckConnection={check} connectionRevision={4} installationEnabled isBusy={false} onAuthorize={vi.fn()} />)
    expect(screen.getByRole('status')).toHaveTextContent('Connected')
    expect(check).toHaveBeenCalledExactlyOnceWith(sources[0].id, expect.any(AbortSignal))
    expect(screen.queryByText(/Checking/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Check connections' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Connected' }))
    expect(screen.getByRole('button', { name: 'Knowledge' })).toBeVisible()

    await act(async () => finish({ schemaVersion: 1, sourceId: sources[0].id, state: 'authorization_required', reason: null, checkedAt: '2026-10-09T10:00:00.000Z' }))
    expect(screen.queryByRole('button', { name: 'Knowledge' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Needs attention' }))
    expect(screen.getByRole('status')).toHaveTextContent('Reconnect required')
    expect(screen.getByRole('button', { name: 'Check connections' })).toBeEnabled()
  })

  it('invalidates cached results after configuration changes and prunes removed connectors', async () => {
    const check = vi.fn().mockImplementationOnce(checkConnection).mockImplementation(() => new Promise<SourceConnection>(() => {}))
    const props = { onCheckConnection: check, installationEnabled: true, isBusy: false, onAuthorize: vi.fn() }
    const { rerender } = render(<SourceList {...props} sources={sources} connectionRevision={4} />)
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Connected'))
    rerender(<SourceList {...props} sources={sources} connectionRevision={5} />)
    expect(screen.getByRole('status')).toHaveTextContent('Checking…')
    rerender(<SourceList {...props} sources={[sources[1]]} connectionRevision={5} />)
    expect(JSON.parse(sessionStorage.getItem(CONNECTION_CACHE_KEY) ?? '{}').results).toEqual({})
    expect(screen.getByRole('button', { name: 'Check connections' })).toBeEnabled()
  })

  it('ignores a late result from an aborted check after navigation', async () => {
    let finish!: (result: SourceConnection) => void
    const slow = vi.fn(() => new Promise<SourceConnection>(resolve => { finish = resolve }))
    const first = render(<SourceList sources={sources} onCheckConnection={slow} installationEnabled isBusy={false} onAuthorize={vi.fn()} />)
    first.unmount()
    const second = render(<SourceList sources={sources} onCheckConnection={checkConnection} installationEnabled isBusy={false} onAuthorize={vi.fn()} />)
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Connected'))
    await act(async () => finish({ schemaVersion: 1, sourceId: sources[0].id, state: 'unavailable', reason: null, checkedAt: null }))
    second.unmount()
    render(<SourceList sources={sources} onCheckConnection={slow} installationEnabled isBusy={false} onAuthorize={vi.fn()} />)
    expect(screen.getByRole('status')).toHaveTextContent('Connected')
  })

  it.each(['invalid JSON', JSON.stringify({ revision: 0, results: { [sources[0].id]: { state: 'connected' } } })])('ignores malformed cached data: %s', async stored => {
    sessionStorage.setItem(CONNECTION_CACHE_KEY, stored)
    const check = vi.fn().mockRejectedValue(new Error('unavailable'))
    render(<SourceList sources={sources} onCheckConnection={check} installationEnabled isBusy={false} onAuthorize={vi.fn()} />)
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Not verified'))
  })

  it('still checks connections and retains results during refresh when storage is unavailable', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('storage blocked') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage blocked') })
    const check = vi.fn().mockImplementationOnce(checkConnection).mockImplementation(() => new Promise<SourceConnection>(() => {}))
    render(<SourceList sources={sources} onCheckConnection={check} installationEnabled isBusy={false} onAuthorize={vi.fn()} />)
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Connected'))
    fireEvent.click(screen.getByRole('button', { name: 'Check connections' }))
    expect(check).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('status')).toHaveTextContent('Connected')
  })

  it('does not retain a green badge when rechecking fails', async () => {
    const user = userEvent.setup()
    const check = vi.fn().mockImplementationOnce(checkConnection).mockRejectedValue(new Error('unavailable'))
    render(<SourceList sources={sources} onCheckConnection={check} installationEnabled isBusy={false} onAuthorize={vi.fn()} />)
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Connected'))
    await user.click(screen.getByRole('button', { name: 'Check connections' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Not verified'))
  })

  it('does not infer health from installation or individual sign-in', async () => {
    const { rerender } = render(<SourceList sources={sources} installationEnabled isBusy={false} onAuthorize={vi.fn()} />)
    expect(screen.getByRole('status')).toHaveTextContent('Not verified')
    const check = vi.fn().mockResolvedValue({ schemaVersion: 1, sourceId: sources[0].id,
      state: 'user_managed', checkedAt: null, reason: null })
    rerender(<SourceList sources={sources} onCheckConnection={check} installationEnabled isBusy={false} onAuthorize={vi.fn()} />)
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Individual sign-in'))
  })

  it('shows queued connectors as Waiting and each result as soon as it arrives', async () => {
    const user = userEvent.setup()
    const installed = Array.from({ length: 10 }, (_, index): ManagedSource => ({
      id: `source-${index.toString(16).repeat(16)}`, label: `Connector ${index + 1}`, url: `https://connector-${index + 1}.example.com/mcp`,
      authMode: 'none', onBehalfOfUser: false, enabledTools: ['search'], status: 'installed',
    }))
    const answers = new Map<string, (result: SourceConnection) => void>()
    const check = vi.fn((sourceId: string) => new Promise<SourceConnection>((resolve) => { answers.set(sourceId, resolve) }))
    const answer = (index: number) => {
      const sourceId = installed[index]?.id ?? ''
      answers.get(sourceId)?.({ schemaVersion: 1, sourceId, state: 'connected', checkedAt: '2026-10-03T10:00:00.000Z', reason: null })
    }
    const labels = () => screen.getAllByRole('status').map(status => status.textContent)
    render(<SourceList sources={installed} onCheckConnection={check} installationEnabled isBusy={false} onAuthorize={vi.fn()} />)
    await waitFor(() => expect(labels()).toEqual([...Array(8).fill('Checking…'), 'Waiting', 'Waiting']))
    expect(check).toHaveBeenCalledTimes(8)
    expect(screen.getByRole('button', { name: 'Check connections' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Connector 10' }))
    expect(screen.getByText('Waiting for other connection checks to finish before testing this one.')).toBeVisible()
    answer(2)
    await waitFor(() => expect(labels()).toEqual(['Checking…', 'Checking…', 'Connected', ...Array(6).fill('Checking…'), 'Waiting']))
    for (const index of [0, 1, 3, 4, 5, 6, 7, 8]) answer(index)
    await waitFor(() => expect(check).toHaveBeenCalledTimes(10))
    expect(labels()).toContain('Checking…')
    answer(9)
    await waitFor(() => expect(labels()).toEqual(Array(10).fill('Connected')))
    expect(screen.getByRole('button', { name: 'Check connections' })).toBeEnabled()
  })

  it('times out a check that never answers without keeping its earlier result', async () => {
    vi.useFakeTimers()
    const signals: AbortSignal[] = []
    const check = vi.fn().mockImplementationOnce(checkConnection).mockImplementation((_sourceId: string, signal: AbortSignal) => {
      signals.push(signal)
      return new Promise<SourceConnection>(() => {})
    })
    render(<SourceList sources={sources} onCheckConnection={check} installationEnabled isBusy={false} onAuthorize={vi.fn()} />)
    await act(async () => {})
    expect(screen.getByRole('status')).toHaveTextContent('Connected')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Check connections' })) })
    expect(screen.getByRole('status')).toHaveTextContent('Connected')
    expect(screen.getByRole('button', { name: 'Check connections' })).toBeDisabled()
    await act(async () => { await vi.advanceTimersByTimeAsync(CONNECTION_CHECK_TIMEOUT_MS) })
    expect(signals.map(signal => signal.aborted)).toEqual([true])
    expect(screen.getByRole('status')).toHaveTextContent('Not verified')
    expect(screen.getByRole('button', { name: 'Check connections' })).toBeEnabled()
  })

})
