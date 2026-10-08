import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { InstalledSourceToolsEditor } from './InstalledSourceTools'
import type { InstalledSourceTools, ManagedSource } from '../api'

afterEach(cleanup)
const source: ManagedSource = { id: 'source-1111111111111111', label: 'Catalogue', url: 'https://catalogue.example.com/mcp', authMode: 'none', onBehalfOfUser: false, enabledTools: ['lookup'], status: 'installed' }
const catalogue: InstalledSourceTools = { schemaVersion: 1, sourceId: source.id, revision: 4, state: 'ready', enabledTools: ['lookup'], pendingTools: null,
  tools: [{ name: 'lookup', title: null, description: 'Find a record.', readOnlyHint: true, destructiveHint: false, openWorldHint: false }] }

it('saves presentation overrides with the original routing name', async () => {
  const user = userEvent.setup()
  const onSave = vi.fn(async () => {})
  render(<InstalledSourceToolsEditor source={source} disabled={false} onLoad={async () => catalogue} onSave={onSave} />)
  await user.click(screen.getByRole('button', { name: 'Edit tools' }))
  await user.click(screen.getByText('Customize name and description'))
  await user.type(screen.getByRole('textbox', { name: 'Name shown to your client' }), 'catalog_lookup')
  await user.type(screen.getByRole('textbox', { name: 'Description shown to your client' }), 'Find a product by SKU.')
  await user.click(screen.getByRole('button', { name: 'Save tools' }))
  expect(onSave).toHaveBeenLastCalledWith(source.id, 4, ['lookup'], [{ name: 'lookup', alias: 'catalog_lookup', description: 'Find a product by SKU.' }], false)
})

it('reloads pending metadata and prevents edits while finishing a lost update', async () => {
  const user = userEvent.setup()
  const onSave = vi.fn(async () => {})
  const metadata = [{ name: 'lookup', alias: 'catalog_lookup' }]
  render(<InstalledSourceToolsEditor source={source} disabled={false} onLoad={async () => ({ ...catalogue, pendingTools: ['lookup'], pendingToolMetadata: metadata })} onSave={onSave} />)
  await user.click(screen.getByRole('button', { name: 'Edit tools' }))
  await user.click(screen.getByText('Custom name and description'))
  expect(screen.getByRole('textbox', { name: 'Name shown to your client' })).toBeDisabled()
  await user.click(screen.getByRole('button', { name: 'Finish tool update' }))
  expect(onSave).toHaveBeenLastCalledWith(source.id, 4, ['lookup'], metadata, false)
})

it('resets saved metadata while keeping the allowlist', async () => {
  const user = userEvent.setup()
  const onSave = vi.fn(async () => {})
  render(<InstalledSourceToolsEditor source={source} disabled={false} onLoad={async () => ({ ...catalogue, toolMetadata: [{ name: 'lookup', alias: 'catalog_lookup' }] })} onSave={onSave} />)
  await user.click(screen.getByRole('button', { name: 'Edit tools' }))
  await user.click(screen.getByText('Custom name and description'))
  await user.click(screen.getByRole('button', { name: 'Reset to upstream values' }))
  await user.click(screen.getByRole('button', { name: 'Save tools' }))
  expect(onSave).toHaveBeenLastCalledWith(source.id, 4, ['lookup'], [], false)
})

it('can reuse an alias from a tool removed from the selection', async () => {
  const user = userEvent.setup()
  const onSave = vi.fn(async () => {})
  const listed: InstalledSourceTools = { ...catalogue, toolMetadata: [{ name: 'lookup', alias: 'catalog_lookup' }],
    tools: [...catalogue.tools, { name: 'lookup_other', title: null, description: 'Find another record.', readOnlyHint: true, destructiveHint: false, openWorldHint: false }] }
  render(<InstalledSourceToolsEditor source={source} disabled={false} onLoad={async () => listed} onSave={onSave} />)
  await user.click(screen.getByRole('button', { name: 'Edit tools' }))
  await user.click(screen.getByRole('checkbox', { name: /^lookuplookup/u }))
  await user.click(screen.getByRole('checkbox', { name: /^lookup_otherlookup_other/u }))
  await user.click(screen.getByText('Customize name and description'))
  await user.type(screen.getByRole('textbox', { name: 'Name shown to your client' }), 'catalog_lookup')
  await user.click(screen.getByRole('button', { name: 'Save tools' }))
  expect(onSave).toHaveBeenLastCalledWith(source.id, 4, ['lookup_other'], [{ name: 'lookup_other', alias: 'catalog_lookup' }], false)
})

it('opts into future tools explicitly and shows newly discovered tools as allowed when reopened', async () => {
  const user = userEvent.setup()
  const onSave = vi.fn(async () => {})
  const nextTool = { name: 'future_lookup', title: null, description: 'Added later.', readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  const onLoad = vi.fn().mockResolvedValueOnce(catalogue).mockResolvedValue({ ...catalogue, allTools: true, tools: [...catalogue.tools, nextTool] })
  render(<InstalledSourceToolsEditor source={source} disabled={false} onLoad={onLoad} onSave={onSave} />)
  await user.click(screen.getByRole('button', { name: 'Edit tools' }))
  const all = screen.getByRole('checkbox', { name: /All tools, including future additions/ })
  expect(all).not.toBeChecked()
  await user.click(all)
  await user.click(screen.getByRole('button', { name: 'Save tools' }))
  expect(onSave).toHaveBeenLastCalledWith(source.id, 4, ['lookup'], [], true)
  await user.click(screen.getByRole('button', { name: 'Edit tools' }))
  expect(screen.getByRole('checkbox', { name: /future_lookupfuture_lookup/ })).toBeChecked()
  expect(screen.getByRole('checkbox', { name: /future_lookupfuture_lookup/ })).toBeDisabled()
  await user.click(screen.getByRole('checkbox', { name: /All tools, including future additions/ }))
  await user.click(screen.getByRole('button', { name: 'Save tools' }))
  expect(onSave).toHaveBeenLastCalledWith(source.id, 4, ['lookup'], [], false)
})
