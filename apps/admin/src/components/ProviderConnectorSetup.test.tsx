import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { ProviderConnectorSetup } from './ProviderConnectorSetup'
import { NATIVE_CONNECTOR_RECIPES } from '../connectors/native-recipes'

afterEach(cleanup)

it.each(NATIVE_CONNECTOR_RECIPES.filter(recipe => recipe.id !== 'bigquery'))('shows $displayName requirements without creating a connection', recipe => {
  const { container } = render(<ProviderConnectorSetup recipe={recipe} />)
  expect(screen.getByText(recipe.endpoint)).toBeVisible()
  expect(screen.getByRole('status')).toHaveTextContent(recipe.status === 'manual_setup'
    ? 'sign-in method your gateway does not support yet'
    : recipe.status === 'provider_permission_required' ? 'permission from the provider' : 'not available to add yet')
  expect(screen.queryByRole('button')).not.toBeInTheDocument()
  expect(container.querySelector('input')).toBeNull()
  for (const link of screen.getAllByRole('link')) {
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    expect(link.getAttribute('href')).toMatch(/^https:\/\//)
  }
})
