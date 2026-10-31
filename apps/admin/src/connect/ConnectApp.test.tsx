import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConnectApp, ConnectPage } from './ConnectApp'
import { loadConnectView, type ConnectView } from './view'

const ads = 'source-1111111111111111'
const email = 'source-2222222222222222'
const view: ConnectView = {
  schemaVersion: 1,
  gateway: { name: 'Example Gateway', mcpUrl: 'https://mcp.example.com/mcp' },
  viewer: { email: 'alex@example.com' },
  team: { id: 'team-0123456789abcdef', name: 'Marketing' },
  sources: [{ id: ads, name: 'Ads reporting', icon: null }, { id: email, name: 'Meta Ads', icon: 'meta' }],
  examples: [
    { id: 'example-000000000001', prompt: 'Which campaigns spent the most last week?', answer: 'A ranked table of campaigns with spend and return.', sourceIds: [ads] },
    { id: 'example-000000000002', prompt: 'Which ad sets are close to their budget cap?', sourceIds: [email] },
    { id: 'example-000000000003', prompt: 'What can you help me with?', sourceIds: [] },
  ],
}

describe('ConnectApp', () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks() })

  it('shows the Claude steps first and the command for Claude Code', async () => {
    const user = userEvent.setup()
    render(<ConnectApp view={view} />)
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Example Gateway. Your team’s tools, inside your AI assistant.')
    expect(screen.getByText(/Connect once to use Ads reporting and Meta Ads/)).toBeVisible()
    const add = screen.getByRole('link', { name: 'Add to Claude' })
    const target = new URL(add.getAttribute('href') ?? '')
    expect(target.origin + target.pathname).toBe('https://claude.ai/customize/connectors')
    expect(target.searchParams.get('connectorUrl')).toBe('https://mcp.example.com/mcp')
    expect(target.searchParams.get('connectorName')).toBe('Example Gateway')
    await user.click(screen.getByRole('tab', { name: 'Claude Code' }))
    expect(screen.getByRole('tab', { name: 'Claude Code' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('claude mcp add --transport http example-gateway https://mcp.example.com/mcp')).toBeVisible()
    expect(screen.queryByRole('link', { name: 'Add to Claude' })).not.toBeInTheDocument()
  })

  it('groups questions by connector, filters them, and opens each in a new Claude chat', async () => {
    const user = userEvent.setup()
    render(<ConnectApp view={view} />)
    const categories = screen.getByRole('navigation', { name: 'Question categories' })
    expect(within(categories).getAllByRole('button').map(button => button.textContent)).toEqual(
      ['All questions3', 'Ads reporting1', 'Meta Ads1', 'General1'])
    expect(screen.getByText('A ranked table of campaigns with spend and return.')).toBeVisible()
    expect(screen.getAllByText('You get')).toHaveLength(1)
    const open = screen.getAllByRole('link', { name: 'Open in Claude' })
    expect(open).toHaveLength(3)
    expect(new URL(open[0]?.getAttribute('href') ?? '').searchParams.get('q')).toBe('Which campaigns spent the most last week?')
    await user.click(within(categories).getByRole('button', { name: /Meta Ads/ }))
    expect(screen.getAllByRole('link', { name: 'Open in Claude' })).toHaveLength(1)
    expect(screen.getByText('Which ad sets are close to their budget cap?')).toBeVisible()
  })

  it('suggests a starter question per connector until administrators write examples', () => {
    render(<ConnectApp view={{ ...view, team: null, examples: [] }} />)
    expect(screen.getByText(/haven’t written questions yet/)).toBeVisible()
    expect(screen.getByText('What can I ask Ads reporting? List its tools and suggest three questions I could ask.')).toBeVisible()
  })

  it('shows the gateway’s refusal instead of the page', async () => {
    render(<ConnectPage loader={async () => ({ refusal: 'connect_other_team' })} />)
    expect(await screen.findByRole('heading', { name: 'This page is for another team' })).toBeVisible()
    expect(screen.getByRole('link', { name: 'Open your page' })).toHaveAttribute('href', '/__ankka/connect')
  })
})

describe('loadConnectView', () => {
  it('asks for the team on a team link and accepts only the exact view', async () => {
    const fetcher = vi.fn(async () => Response.json(view))
    expect(await loadConnectView('/__ankka/connect/team-0123456789abcdef', fetcher)).toEqual({ view })
    expect(fetcher).toHaveBeenCalledWith('/__ankka/connect/view?team=team-0123456789abcdef', expect.objectContaining({ credentials: 'same-origin' }))
    expect(await loadConnectView('/__ankka/connect', vi.fn(async () => Response.json({ ...view, extra: true })))).toEqual({ refusal: 'connect_unavailable' })
  })

  it('maps the gateway’s fixed refusals and treats a sign-in redirect as an ended session', async () => {
    const refused = vi.fn(async () => Response.json({ schemaVersion: 1, error: 'connect_not_member' }, { status: 403 }))
    expect(await loadConnectView('/__ankka/connect', refused)).toEqual({ refusal: 'connect_not_member' })
    const unknown = vi.fn(async () => Response.json({ error: 'something_else' }, { status: 500 }))
    expect(await loadConnectView('/__ankka/connect', unknown)).toEqual({ refusal: 'connect_unavailable' })
    const redirect = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://example.cloudflareaccess.com/' } }))
    expect(await loadConnectView('/__ankka/connect', redirect)).toEqual({ refusal: 'access_required' })
  })
})
