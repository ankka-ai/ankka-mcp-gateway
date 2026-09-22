import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { SourceIcon } from './SourceIcon'
import type { ManagedSource } from '../api'

const source: ManagedSource = { id: 'source-1111111111111111', label: 'Custom service', url: 'https://custom.example.com/mcp',
  authMode: 'none', onBehalfOfUser: false, enabledTools: ['search'], status: 'installed' }

describe('SourceIcon', () => {
  afterEach(cleanup)
  it('keeps the initial until the MCP image has loaded', () => {
    const { container } = render(<SourceIcon source={source} />)
    expect(screen.getByText('C')).toBeInTheDocument()
    const img = container.querySelector('img')
    if (!img) throw new Error('Expected connector image')
    expect(img).toHaveAttribute('src', `/api/sources/${source.id}/icon`)
    expect(img).toHaveAttribute('referrerpolicy', 'no-referrer')
    fireEvent.load(img)
    expect(screen.queryByText('C')).not.toBeInTheDocument()
    expect(img).not.toHaveClass('opacity-0')
  })
  it('retains the initial and removes a broken or unavailable image', () => {
    const { container } = render(<SourceIcon source={source} />)
    const img = container.querySelector('img')
    if (!img) throw new Error('Expected connector image')
    fireEvent.error(img)
    expect(screen.getByText('C')).toBeInTheDocument()
    expect(container.querySelector('img')).toBeNull()
  })
})
