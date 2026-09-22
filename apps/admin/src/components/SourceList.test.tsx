import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ManagedSource } from '../api'
import { SourceList } from './SourceList'

const sources: [ManagedSource, ManagedSource] = [
  { id: 'source-1111111111111111', label: 'Knowledge', url: 'https://knowledge.example.com/mcp', authMode: 'oauth', onBehalfOfUser: false, enabledTools: ['search', 'fetch_document'], status: 'installed' },
  { id: 'source-2222222222222222', label: 'Catalogue', url: 'https://catalogue.example.com/mcp', authMode: 'none', onBehalfOfUser: false, enabledTools: ['list_products'], status: 'draft' },
]

describe('SourceList', () => {
  afterEach(cleanup)

  it('filters installed connectors and drafts without changing them', async () => {
    const user = userEvent.setup()
    const onAuthorize = vi.fn()
    render(<SourceList sources={sources} installationEnabled isBusy={false} onAuthorize={onAuthorize} />)
    const filters = within(screen.getByRole('group', { name: 'Filter connectors' }))

    await user.click(filters.getByRole('button', { name: 'Installed' }))
    expect(filters.getByRole('button', { name: 'Installed' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Knowledge' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Catalogue' })).not.toBeInTheDocument()

    await user.click(filters.getByRole('button', { name: 'Drafts' }))
    expect(screen.queryByRole('button', { name: 'Knowledge' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Catalogue' })).toBeInTheDocument()

    await user.click(filters.getByRole('button', { name: 'All' }))
    expect(screen.getByRole('button', { name: 'Knowledge' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Catalogue' })).toBeInTheDocument()
    expect(onAuthorize).not.toHaveBeenCalled()
  })

  it('keeps details collapsed until the connector is expanded with the keyboard', async () => {
    const user = userEvent.setup()
    render(<SourceList sources={sources} installationEnabled isBusy={false} onAuthorize={vi.fn()} />)
    const source = screen.getByRole('button', { name: 'Knowledge' })
    expect(source).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText(sources[0].url)).not.toBeInTheDocument()

    source.focus()
    await user.keyboard('{Enter}')
    expect(source).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText(sources[0].url)).toBeInTheDocument()
    expect(screen.getByText('Operator-connected OAuth')).toBeInTheDocument()
    expect(screen.getByText('2 exact tools')).toBeInTheDocument()
    expect(within(screen.getByRole('region', { name: 'Knowledge allowed tools' })).getByText('search')).toBeInTheDocument()

    await user.keyboard('{Enter}')
    expect(source).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText(sources[0].url)).not.toBeInTheDocument()
  })

  it('preserves draft authorization and respects installation and busy restrictions', async () => {
    const user = userEvent.setup()
    const onAuthorize = vi.fn()
    const { rerender } = render(<SourceList sources={sources} installationEnabled isBusy={false} onAuthorize={onAuthorize} />)

    await user.click(screen.getByRole('button', { name: 'Install connector' }))
    expect(onAuthorize).toHaveBeenCalledExactlyOnceWith(sources[1].id)

    rerender(<SourceList sources={sources} installationEnabled={false} isBusy={false} onAuthorize={onAuthorize} />)
    expect(screen.getByRole('button', { name: 'Installation unavailable' })).toBeDisabled()
    rerender(<SourceList sources={sources} installationEnabled isBusy onAuthorize={onAuthorize} />)
    expect(screen.getByRole('button', { name: /Install connector/u })).toBeDisabled()
  })

  it('shows an empty filtered state without hiding the filters', async () => {
    const user = userEvent.setup()
    render(<SourceList sources={[sources[0]]} installationEnabled isBusy={false} onAuthorize={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: 'Drafts' }))
    expect(screen.getByText('No drafts.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'All' }))
    expect(screen.getByRole('button', { name: 'Knowledge' })).toBeInTheDocument()
  })

  it('searches names and URLs alongside the status filter', async () => {
    const user = userEvent.setup()
    const onAuthorize = vi.fn()
    render(<SourceList sources={sources} installationEnabled isBusy={false} onAuthorize={onAuthorize} />)
    const search = screen.getByRole('searchbox', { name: 'Search connectors' })

    await user.type(search, 'KNOWLEDGE')
    expect(screen.getByRole('button', { name: 'Knowledge' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Catalogue' })).not.toBeInTheDocument()

    await user.clear(search)
    await user.type(search, 'catalogue.example.com')
    expect(screen.getByRole('button', { name: 'Catalogue' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Installed' }))
    expect(screen.getByText('No matching connectors.')).toBeInTheDocument()

    await user.clear(search)
    expect(screen.getByRole('button', { name: 'Knowledge' })).toBeInTheDocument()
    expect(onAuthorize).not.toHaveBeenCalled()
  })

  it('fetches synced tools and saves only the explicit selection', async () => {
    const user = userEvent.setup()
    const bare = { title: null, description: null, readOnlyHint: null, destructiveHint: null, openWorldHint: null }
    const onLoadSourceTools = vi.fn(async () => ({
      schemaVersion: 1 as const, sourceId: sources[0].id, revision: 4, state: 'ready' as const, pendingTools: null,
      enabledTools: ['fetch_document', 'search'],
      tools: [
        { name: 'export_document', ...bare, description: 'Export a page.', readOnlyHint: true, destructiveHint: false },
        { name: 'fetch_document', ...bare },
        { name: 'search', ...bare, description: 'Find a page.', readOnlyHint: true, destructiveHint: false },
      ],
    }))
    const onSaveSourceTools = vi.fn(async () => {})
    const { rerender } = render(<SourceList sources={sources} installationEnabled isBusy={false} onAuthorize={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: 'Knowledge' }))
    expect(screen.queryByRole('button', { name: 'Edit tools' })).not.toBeInTheDocument()

    rerender(<SourceList sources={sources} installationEnabled isBusy={false} onAuthorize={vi.fn()} onLoadSourceTools={onLoadSourceTools} onSaveSourceTools={onSaveSourceTools} />)
    await user.click(screen.getByRole('button', { name: 'Edit tools' }))
    expect(onLoadSourceTools).toHaveBeenCalledExactlyOnceWith(sources[0].id)
    expect(await screen.findByRole('checkbox', { name: /export_document/ })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: /^search/ })).toBeChecked()
    expect(screen.getByText(/New tools stay off until you select them/)).toBeInTheDocument()

    await user.click(screen.getByRole('checkbox', { name: /export_document/ }))
    await user.click(screen.getByRole('button', { name: 'Save tools' }))
    expect(onSaveSourceTools).toHaveBeenCalledExactlyOnceWith(sources[0].id, 4, ['export_document', 'fetch_document', 'search'])
  })

  it('renames an installed connector and leaves a draft unnamed', async () => {
    const user = userEvent.setup()
    const onRenameSource = vi.fn(async () => {})
    render(<SourceList sources={sources} installationEnabled isBusy={false} onAuthorize={vi.fn()} onRenameSource={onRenameSource} />)
    await user.click(screen.getByRole('button', { name: 'Catalogue' }))
    expect(screen.queryByRole('button', { name: 'Save name' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Knowledge' }))
    const name = screen.getByLabelText('Name')
    expect(name).toHaveValue('Knowledge')
    expect(screen.getByRole('button', { name: 'Save name' })).toBeDisabled()
    await user.clear(name)
    await user.type(name, 'Company knowledge')
    await user.click(screen.getByRole('button', { name: 'Save name' }))
    expect(onRenameSource).toHaveBeenCalledExactlyOnceWith(sources[0].id, 'Company knowledge')
  })
})
