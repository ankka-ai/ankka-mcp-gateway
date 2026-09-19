import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { Button } from './Button'

it('keeps its accessible label and blocks repeat actions while loading, then becomes usable again', () => {
  const action = vi.fn()
  const view = render(<Button loading onClick={action}>Update</Button>)
  const button = screen.getByRole('button', { name: 'Update' })
  expect(button).toBeDisabled()
  expect(button).toHaveAttribute('aria-busy', 'true')
  fireEvent.click(button)
  expect(action).not.toHaveBeenCalled()
  view.rerender(<Button onClick={action}>Update</Button>)
  expect(button).toBeEnabled()
  expect(button).not.toHaveAttribute('aria-busy', 'true')
  fireEvent.click(button)
  expect(action).toHaveBeenCalledOnce()
})
