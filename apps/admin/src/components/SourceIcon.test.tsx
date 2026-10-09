import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { SourceIcon } from './SourceIcon'
import type { ManagedSource } from '../api'
import metaIcon from '../assets/connectors/meta.svg'
import ahrefsIcon from '../assets/connectors/ahrefs.svg'

const source: ManagedSource = { id: 'source-1111111111111111', label: 'Custom service', url: 'https://custom.example.com/mcp',
  authMode: 'none', onBehalfOfUser: false, enabledTools: ['search'], status: 'installed' }

describe('SourceIcon', () => {
  afterEach(cleanup)
  it.each([
    ['Meta Ads', 'https://mcp.facebook.com/ads', metaIcon],
    ['Ahrefs', 'https://api.ahrefs.com/mcp/mcp', ahrefsIcon],
  ])('uses the bundled %s logo for its official endpoint without probing protected metadata', (_provider, url, icon) => {
    const { container } = render(<SourceIcon source={{ ...source, label: 'Analytics', url }} />)
    const img = container.querySelector('img')
    if (!img) throw new Error('Expected connector image')
    expect(img).toHaveAttribute('src', icon)
    fireEvent.load(img)
    expect(screen.queryByText('A')).not.toBeInTheDocument()
  })
  it.each([
    ['Meta Ads', 'https://mcp.facebook.com.example.com/ads'],
    ['Ahrefs', 'https://api.ahrefs.com.example.com/mcp/mcp'],
  ])('does not infer the %s icon from a connector label or a lookalike hostname', (label, url) => {
    const { container } = render(<SourceIcon source={{ ...source, label, url }} />)
    expect(container.querySelector('img')).toHaveAttribute('src', `/api/sources/${source.id}/icon`)
  })
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
