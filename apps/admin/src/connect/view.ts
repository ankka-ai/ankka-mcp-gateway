import * as v from 'valibot'

/** Where the gateway serves the team connect page, its data and its files. */
export const CONNECT_PAGE_PATH = '/__ankka/connect'
const TEAM_PATH = /^\/__ankka\/connect\/(team-[a-f0-9]{16})$/u

const connectViewSchema = v.strictObject({
  schemaVersion: v.literal(1),
  gateway: v.strictObject({ name: v.pipe(v.string(), v.minLength(1)), mcpUrl: v.pipe(v.string(), v.url(), v.startsWith('https://')) }),
  viewer: v.strictObject({ email: v.string() }),
  team: v.nullable(v.strictObject({ id: v.string(), name: v.string() })),
  sources: v.array(v.strictObject({
    id: v.pipe(v.string(), v.regex(/^source-[a-f0-9]{16}$/u)),
    name: v.string(),
    icon: v.nullable(v.picklist(['ankka', 'meta', 'ahrefs'])),
  })),
  examples: v.array(v.strictObject({ id: v.string(), prompt: v.string(), answer: v.optional(v.string()), sourceIds: v.array(v.string()) })),
})
export type ConnectView = v.InferOutput<typeof connectViewSchema>
export type ConnectSource = ConnectView['sources'][number]

/** Why the page shows nothing about the gateway, as the gateway says it. */
export type ConnectRefusal = 'access_required' | 'connect_not_member' | 'connect_other_team' | 'connect_team_missing' | 'connect_page_off' | 'connect_unavailable'
const refusals: readonly ConnectRefusal[] = ['access_required', 'connect_not_member', 'connect_other_team', 'connect_team_missing', 'connect_page_off']

export type ConnectLoad = { view: ConnectView } | { refusal: ConnectRefusal }

export function connectTeamId(pathname: string): string | null {
  return TEAM_PATH.exec(pathname)?.[1] ?? null
}

/** Reads what this visitor may see. A team page asks for that team; the gateway checks membership. */
export async function loadConnectView(pathname: string, fetcher: typeof fetch = fetch): Promise<ConnectLoad> {
  const team = connectTeamId(pathname)
  let response: Response
  try {
    response = await fetcher(`${CONNECT_PAGE_PATH}/view${team ? `?team=${team}` : ''}`, {
      credentials: 'same-origin', redirect: 'manual', headers: { accept: 'application/json' },
    })
  } catch { return { refusal: 'connect_unavailable' } }
  // An expired Access session answers with a redirect to sign in.
  if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) return { refusal: 'access_required' }
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const error = v.safeParse(v.object({ error: v.string() }), body)
    const code = error.success ? refusals.find(item => item === error.output.error) : undefined
    return { refusal: code ?? 'connect_unavailable' }
  }
  const parsed = v.safeParse(connectViewSchema, body)
  return parsed.success ? { view: parsed.output } : { refusal: 'connect_unavailable' }
}

/** The name Claude Code and Cursor save the gateway under. */
export function connectServerName(name: string): string {
  return name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/gu, '-').replace(/^-+/u, '').slice(0, 40).replace(/-+$/u, '') || 'team-gateway'
}

export interface ExampleGroup { title: string; examples: Array<ConnectView['examples'][number] & { sources: ConnectSource[] }> }

/** Examples grouped by the one connector they need, then across connectors, then general; starters when none. */
export function exampleGroups(view: ConnectView): ExampleGroup[] {
  const byId = new Map(view.sources.map(source => [source.id, source]))
  const groups: ExampleGroup[] = []
  const add = (title: string, example: ConnectView['examples'][number]) => {
    let group = groups.find(item => item.title === title)
    if (!group) groups.push(group = { title, examples: [] })
    group.examples.push({ ...example, sources: example.sourceIds.flatMap(id => byId.get(id) ?? []) })
  }
  for (const source of view.sources) {
    for (const example of view.examples) if (example.sourceIds.length === 1 && example.sourceIds[0] === source.id) add(source.name, example)
  }
  for (const example of view.examples) if (example.sourceIds.length > 1) add('Across sources', example)
  for (const example of view.examples) if (example.sourceIds.length === 0) add('General', example)
  if (groups.length === 0) {
    for (const source of view.sources.slice(0, 6)) add('Getting started', { id: `starter-${source.id}`, sourceIds: [source.id],
      prompt: `What can I ask ${source.name}? List its tools and suggest three questions I could ask.`,
      answer: `What ${source.name} can look up for you, and three questions to try next.` })
  }
  return groups
}
