import type { ConnectLoad, ConnectRefusal, ConnectView } from './view'

// Synthetic data for `npm run dev:ui`: /team-connect.html?preview=team|starters|empty|not-member|other-team|off
const view: ConnectView = {
  schemaVersion: 1,
  gateway: { name: 'Example Gateway', mcpUrl: 'https://mcp.example.com/mcp' },
  viewer: { email: 'alex.morgan@example.com' },
  team: { id: 'team-0123456789abcdef', name: 'Marketing' },
  sources: [
    { id: 'source-1111111111111111', name: 'Ads reporting', icon: null },
    { id: 'source-2222222222222222', name: 'Email marketing', icon: null },
    { id: 'source-3333333333333333', name: 'Meta Ads', icon: 'meta' },
    { id: 'source-616e6b6b616d6370', name: 'Gateway Management', icon: 'ankka' },
  ],
  examples: [
    { id: 'example-000000000001', prompt: 'Which campaigns spent the most last week, and what did each return?', answer: 'A ranked table of campaigns with spend, purchases and return on ad spend, and which one to scale.', sourceIds: ['source-1111111111111111'] },
    { id: 'example-000000000002', prompt: 'Compare cost per purchase this month with last month and explain the biggest change.', answer: 'Both months side by side, the campaigns that moved most, and a short explanation of why.', sourceIds: ['source-1111111111111111'] },
    { id: 'example-000000000003', prompt: 'Compare open rates of our last five newsletters and suggest a better send time.', answer: 'Open and click rates per newsletter, the best day and hour so far, and one send time to test.', sourceIds: ['source-2222222222222222'] },
    { id: 'example-000000000004', prompt: 'Which ad sets are close to their budget cap today?', answer: 'Each ad set at 80 % of its daily budget or more, with spend so far and the cap.', sourceIds: ['source-3333333333333333'] },
    { id: 'example-000000000005', prompt: 'How did paid traffic from Meta convert into newsletter sign-ups this month?', answer: 'Sign-ups attributed to Meta campaigns, the rate per campaign, and how it compares with last month.', sourceIds: ['source-2222222222222222', 'source-3333333333333333'] },
    { id: 'example-000000000006', prompt: 'What can you help me with using our gateway?', answer: 'A short tour of the sources you can use, with an example question for each.', sourceIds: [] },
  ],
}

export function previewConnectLoader(): ((pathname: string) => Promise<ConnectLoad>) | undefined {
  if (!import.meta.env.DEV || import.meta.env.VITE_GATEWAY_UI_PREVIEW !== '1') return undefined
  return async (): Promise<ConnectLoad> => {
    const scenario = new URLSearchParams(window.location.search).get('preview') ?? 'team'
    const refused: ConnectRefusal | null = scenario === 'not-member' ? 'connect_not_member'
      : scenario === 'other-team' ? 'connect_other_team' : scenario === 'off' ? 'connect_page_off' : null
    if (refused) return { refusal: refused }
    if (scenario === 'starters') return { view: { ...view, team: null, examples: [] } }
    if (scenario === 'empty') return { view: { ...view, team: null, sources: [], examples: view.examples.filter(example => example.sourceIds.length === 0) } }
    return { view }
  }
}
