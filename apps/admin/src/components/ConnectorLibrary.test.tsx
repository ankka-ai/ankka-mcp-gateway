import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { SOURCE_CATALOG } from '../catalog'
import { SYNTHETIC_SOURCE_CATALOG } from '../catalog/fixtures'
import { ConnectorLibrary } from './ConnectorLibrary'
import { NATIVE_CONNECTOR_RECIPES } from '../connectors/native-recipes'

afterEach(cleanup)

function library(overrides: Partial<Parameters<typeof ConnectorLibrary>[0]> = {}) {
  const props = { open: true, onOpenChange: vi.fn(), catalog: SOURCE_CATALOG, bigQueryAvailable: true, bigQueryBlocked: false, disabled: false,
    onProvider: vi.fn(), onBigQuery: vi.fn(), onCatalogSource: vi.fn(), onCustom: vi.fn(), ...overrides }
  render(<ConnectorLibrary {...props} />)
  return props
}

it('searches supported setups and provides a custom connector path when none match', async () => {
  const user = userEvent.setup()
  const props = library({ catalog: SYNTHETIC_SOURCE_CATALOG })
  const search = screen.getByRole('searchbox', { name: 'Search connectors' })
  await user.type(search, 'EXAMPLE')
  expect(screen.queryByRole('button', { name: 'Set up BigQuery' })).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Select Example Analytics' }))
  expect(props.onCatalogSource).toHaveBeenCalledWith(SYNTHETIC_SOURCE_CATALOG.sources[0])
  await user.clear(search)
  await user.type(search, 'missing connector')
  expect(screen.getByText('No connectors found')).toBeVisible()
  await user.click(screen.getByRole('button', { name: 'Add custom connector' }))
  expect(props.onCustom).toHaveBeenCalledOnce()
})

it.each([
  { bigQueryAvailable: false },
  { bigQueryBlocked: true },
  { disabled: true },
])('keeps BigQuery unavailable when the gateway cannot start it: %j', async overrides => {
  const user = userEvent.setup()
  const props = library(overrides)
  const setup = screen.getByRole('button', { name: 'Set up BigQuery' })
  expect(setup).toBeDisabled()
  await user.click(setup)
  expect(props.onBigQuery).not.toHaveBeenCalled()
})

it('opens BigQuery setup and dismisses the library with Escape', async () => {
  const user = userEvent.setup()
  const props = library()
  await user.click(screen.getByRole('button', { name: 'Set up BigQuery' }))
  expect(props.onBigQuery).toHaveBeenCalledOnce()
  await user.keyboard('{Escape}')
  expect(props.onOpenChange).toHaveBeenCalledWith(false, expect.anything())
})

it('lists provider connectors once and searches their setup details', async () => {
  const user = userEvent.setup()
  const props = library()
  for (const recipe of NATIVE_CONNECTOR_RECIPES.filter(entry => entry.id !== 'bigquery')) {
    expect(screen.getByRole('button', { name: `View ${recipe.displayName} connector` })).toBeEnabled()
  }
  expect(screen.queryByRole('button', { name: 'View BigQuery connector' })).not.toBeInTheDocument()
  await user.type(screen.getByRole('searchbox', { name: 'Search connectors' }), 'linear')
  expect(screen.queryByRole('button', { name: 'View Slack connector' })).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'View Linear connector' }))
  expect(props.onProvider).toHaveBeenCalledWith(NATIVE_CONNECTOR_RECIPES.find(recipe => recipe.id === 'linear'))
  expect(props.onCatalogSource).not.toHaveBeenCalled()
  expect(props.onBigQuery).not.toHaveBeenCalled()
})
