import { ArrowUpRight, Check, Copy } from '@phosphor-icons/react'
import { useEffect, useRef, useState, type ComponentType, type KeyboardEvent, type ReactNode, type SVGProps } from 'react'
import { BrandMark } from '../components/BrandMark'
import { BUNDLED_CONNECTOR_ICONS, ConnectorIcon } from '../components/SourceIcon'
import { ChatGptIcon, ClaudeIcon, CursorIcon, PlugIcon, TerminalIcon } from './ClientIcons'
import {
  CONNECT_PAGE_PATH, connectServerName, exampleGroups,
  type ConnectLoad, type ConnectRefusal, type ConnectSource, type ConnectView,
} from './view'

function iconSource(source: ConnectSource): string {
  return source.icon ? BUNDLED_CONNECTOR_ICONS[source.icon] : `${CONNECT_PAGE_PATH}/icons/${source.id}`
}

function ExternalLink({ href, className, children }: { href: string; className: string; children: ReactNode }) {
  return <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
    {children}<ArrowUpRight size={14} weight="bold" aria-hidden="true" />
  </a>
}

function CopyButton({ text, label, tone = 'dark' }: { text: string; label: string; tone?: 'dark' | 'light' }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  useEffect(() => {
    if (state === 'idle') return
    const timer = window.setTimeout(() => setState('idle'), 1600)
    return () => window.clearTimeout(timer)
  }, [state])
  const toneClass = tone === 'light'
    ? 'border-black/10 bg-white text-neutral-900 hover:bg-neutral-50'
    : 'border-white/10 bg-white/10 text-neutral-50 hover:bg-white/15'
  return <button type="button" aria-label={label}
    className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px] font-medium ${toneClass}`}
    onClick={() => { navigator.clipboard.writeText(text).then(() => setState('copied'), () => setState('failed')) }}>
    {state === 'copied' ? <Check size={14} weight="bold" aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
    <span aria-live="polite">{state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : 'Copy'}</span>
  </button>
}

interface Client {
  id: string
  label: string
  icon: ComponentType<SVGProps<SVGSVGElement>>
  steps: Array<{ title: string; body: ReactNode; action?: ReactNode }>
  code?: string
  note?: ReactNode
}

const cta = 'inline-flex h-10 items-center gap-2 rounded-[14px] bg-blue-500 px-6 text-sm font-medium text-white shadow-[0_10px_15px_-3px_rgba(59,130,246,.3),0_4px_6px_-4px_rgba(59,130,246,.3)] hover:bg-blue-600'
const guide = 'inline-flex items-center gap-1 whitespace-nowrap text-neutral-300 hover:text-white'

function clients(view: ConnectView): Client[] {
  const url = view.gateway.mcpUrl
  const server = connectServerName(view.gateway.name)
  const claude = new URL('https://claude.ai/customize/connectors')
  claude.search = new URLSearchParams({ modal: 'add-custom-connector', connectorName: view.gateway.name, connectorUrl: url }).toString()
  const cursor = new URL('cursor://anysphere.cursor-deeplink/mcp/install')
  cursor.search = new URLSearchParams({ name: server, config: btoa(JSON.stringify({ url })) }).toString()
  return [
    { id: 'claude', label: 'Claude', icon: ClaudeIcon, steps: [
      { title: 'Add the connector', body: 'Claude opens with this gateway’s name and URL filled in.',
        action: <ExternalLink href={claude.href} className={cta}>Add to Claude</ExternalLink> },
      { title: 'Connect and sign in', body: <>Select <b>Connect</b>, then sign in with your work account.</> },
      { title: 'Ask a question', body: 'Start a new chat and try one of the questions below.' },
    ], note: <>On a Team or Enterprise plan, an owner may need to add the connector for your organization first. <ExternalLink href="https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp" className={guide}>Setup guide</ExternalLink></> },
    { id: 'chatgpt', label: 'ChatGPT', icon: ChatGptIcon, steps: [
      { title: 'Add a custom server', body: <>Open <b>Plugins</b>, select <b>+</b>, then <b>Add custom MCP server</b>.</> },
      { title: 'Paste the URL', body: <>Paste the MCP server URL below and choose <b>OAuth</b>.</> },
      { title: 'Sign in and ask', body: <>Install it, sign in with your work account, then type <b>@</b> in a chat.</> },
    ], note: <>Your workspace administrator may need to add this gateway for you. <ExternalLink href="https://developers.openai.com/api/docs/guides/custom-mcp-server" className={guide}>Setup guide</ExternalLink></> },
    { id: 'claude-code', label: 'Claude Code', icon: TerminalIcon, steps: [
      { title: 'Copy the command', body: 'One command adds this gateway to Claude Code.' },
      { title: 'Run it in your terminal', body: 'Claude Code saves the server and picks it up right away.' },
      { title: 'Sign in with /mcp', body: <>Run <b>/mcp</b>, choose <b>{server}</b> and finish the sign-in.</> },
    ], code: `claude mcp add --transport http ${server} ${url}` },
    { id: 'cursor', label: 'Cursor', icon: CursorIcon, steps: [
      { title: 'Add the server', body: 'Cursor opens with the server filled in.',
        action: <ExternalLink href={cursor.href} className={cta}>Add to Cursor</ExternalLink> },
      { title: 'Sign in', body: 'Finish the sign-in when Cursor asks you to connect.' },
      { title: 'Ask a question', body: 'Try one of the questions below in the agent chat.' },
    ], note: <ExternalLink href="https://cursor.com/docs/context/mcp" className={guide}>Setup guide</ExternalLink> },
    { id: 'other', label: 'Other clients', icon: PlugIcon, steps: [
      { title: 'Add a remote server', body: 'Add a remote MCP server with the URL below.' },
      { title: 'Pick the transport', body: <>Choose <b>Streamable HTTP</b> if your client asks.</> },
      { title: 'Sign in', body: 'Finish the browser sign-in when your client prompts you.' },
    ], note: 'Your client needs support for remote MCP servers with OAuth sign-in.' },
  ]
}

function ConnectCard({ view }: { view: ConnectView }) {
  const options = clients(view)
  const [active, setActive] = useState('claude')
  const tabs = useRef<Array<HTMLButtonElement | null>>([])
  const move = (event: KeyboardEvent, index: number) => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
    if (!step) return
    event.preventDefault()
    const next = (index + step + options.length) % options.length
    const option = options[next]
    if (!option) return
    setActive(option.id)
    tabs.current[next]?.focus()
  }
  const client = options.find(option => option.id === active)
  if (!client) return null
  return <section aria-label="Connect your assistant" className="rounded-3xl border border-white/15 bg-white/5 p-3">
    <div role="tablist" aria-label="Assistants" className="flex gap-1 overflow-x-auto rounded-full bg-white/5 p-1.5 [scrollbar-width:none]">
      {options.map((option, index) => {
        const Icon = option.icon
        const selected = option.id === client.id
        return <button key={option.id} ref={element => { tabs.current[index] = element }} type="button" role="tab"
          id={`tab-${option.id}`} aria-controls={`panel-${option.id}`} aria-selected={selected} tabIndex={selected ? 0 : -1}
          onClick={() => setActive(option.id)} onKeyDown={event => move(event, index)}
          className={`inline-flex shrink-0 items-center gap-2 rounded-full px-4 py-2 text-sm ${selected ? 'bg-white font-medium text-neutral-950' : 'text-neutral-400 hover:text-white'}`}>
          <Icon className="size-4" />{option.label}
        </button>
      })}
    </div>
    <div role="tabpanel" id={`panel-${client.id}`} aria-labelledby={`tab-${client.id}`}>
      <ol className="grid grid-cols-1 pt-2 md:grid-cols-3">
        {client.steps.map((step, index) => <li key={step.title}
          className="flex flex-col border-white/10 px-3 pb-4 pt-5 not-first:border-t sm:px-5 md:min-h-[188px] md:not-first:border-l md:not-first:border-t-0">
          <p className="m-0 flex items-center gap-3 text-lg font-medium text-white">
            <span className="grid size-7 shrink-0 place-items-center rounded-full border border-white/15 text-[13px] font-normal text-neutral-300">{index + 1}</span>
            {step.title}
          </p>
          <p className="m-0 mt-3 text-sm leading-5 text-neutral-300 [&_b]:font-medium [&_b]:text-white">{step.body}</p>
          {step.action ? <div className="mt-auto pt-6">{step.action}</div> : null}
        </li>)}
      </ol>
      {client.code ? <div className="relative mx-2 mb-2">
        <pre className="m-0 overflow-auto rounded-[14px] border border-white/10 bg-black/35 py-3.5 pl-4 pr-28 text-[13px] leading-relaxed text-neutral-200"><code className="font-[ui-monospace,SFMono-Regular,Menlo,monospace]">{client.code}</code></pre>
        <div className="absolute right-2 top-2"><CopyButton text={client.code} label={`Copy the ${client.label} command`} /></div>
      </div> : null}
      {client.note ? <p className="mx-3 mb-3 mt-0 text-[13px] leading-relaxed text-neutral-500 sm:mx-5">{client.note}</p> : null}
    </div>
  </section>
}

function Examples({ view }: { view: ConnectView }) {
  const groups = exampleGroups(view)
  const [filter, setFilter] = useState<string | null>(null)
  if (groups.length === 0) return null
  const total = groups.reduce((sum, group) => sum + group.examples.length, 0)
  const shown = groups.filter(group => filter === null || group.title === filter)
  const intro = view.examples.length === 0
    ? 'Your gateway administrators haven’t written questions yet. These starters work with each of your sources.'
    : `Written for ${view.team ? `the ${view.team.name} team` : 'you'} by your gateway administrators. Open one in Claude, or copy it into any assistant.`
  const filterButton = (title: string | null, label: string, count: number) =>
    <button key={label} type="button" aria-pressed={filter === title} onClick={() => setFilter(title)}
      className={`flex shrink-0 items-center justify-between gap-3 rounded-full px-3 py-2.5 text-left text-sm font-medium text-neutral-900 hover:bg-neutral-100 md:rounded-[14px] ${filter === title ? 'bg-neutral-100' : ''}`}>
      <span>{label}</span><span className="text-xs font-normal text-neutral-400">{count}</span>
    </button>
  return <section aria-labelledby="examples-title">
    <p className="m-0 text-center text-xs font-medium uppercase tracking-[0.14em] text-neutral-500">Ready-to-ask questions</p>
    <h2 id="examples-title" className="m-0 mt-3.5 text-balance text-center text-[clamp(28px,4.4vw,40px)] font-[450] leading-[1.15] tracking-[-0.025em] text-neutral-950">
      Ask your sources in <ClaudeIcon className="mx-[0.1em] inline size-[0.82em] align-[-0.06em]" />Claude
    </h2>
    <p className="mx-auto mb-0 mt-3.5 max-w-[620px] text-pretty text-center text-base leading-[1.7] text-neutral-600">{intro}</p>
    <div className={`mt-11 grid gap-5 ${groups.length > 1 ? 'md:grid-cols-[240px_minmax(0,1fr)] md:items-start' : ''}`}>
      {groups.length > 1 ? <nav aria-label="Question categories"
        className="flex gap-0.5 overflow-x-auto rounded-full border border-black/5 bg-white p-1.5 shadow-[0_1px_2px_rgba(0,0,0,.04),0_12px_24px_-16px_rgba(0,0,0,.18)] [scrollbar-width:none] md:sticky md:top-4 md:flex-col md:rounded-3xl md:p-2">
        {filterButton(null, 'All questions', total)}
        {groups.map(group => filterButton(group.title, group.title, group.examples.length))}
      </nav> : null}
      <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-4 p-0">
        {shown.flatMap(group => group.examples).map(example => {
          const open = new URL('https://claude.ai/new')
          open.searchParams.set('q', example.prompt)
          return <li key={example.id} className="flex min-h-44 flex-col gap-4 rounded-[20px] border border-black/5 bg-white p-5 shadow-[0_1px_2px_rgba(0,0,0,.04),0_12px_24px_-16px_rgba(0,0,0,.18)]">
            {example.sources.length ? <div className="flex items-center gap-2">
              <span className="flex -space-x-1.5">{example.sources.map(source =>
                <ConnectorIcon key={source.id} label={source.name} src={iconSource(source)} tone="light" className="size-6 ring-2 ring-white" />)}</span>
              <span className="truncate text-xs text-neutral-500">{example.sources.map(source => source.name).join(' · ')}</span>
            </div> : null}
            <p className="m-0 text-pretty text-base leading-normal text-neutral-900">{example.prompt}</p>
            {example.answer ? <div className="rounded-xl bg-neutral-100/80 px-3.5 py-3">
              <p className="m-0 text-[11px] font-medium uppercase tracking-[0.12em] text-neutral-500">You get</p>
              <p className="m-0 mt-1 text-pretty text-sm leading-relaxed text-neutral-600">{example.answer}</p>
            </div> : null}
            <div className="flex-1" />
            <div className="flex flex-wrap gap-1.5">
              <ExternalLink href={open.href} className="inline-flex items-center gap-1.5 rounded-full bg-neutral-950 px-3.5 py-1.5 text-[13px] font-medium text-white hover:bg-neutral-800">Open in Claude</ExternalLink>
              <CopyButton text={example.prompt} label="Copy this question" tone="light" />
            </div>
          </li>
        })}
      </ul>
    </div>
  </section>
}

function sourceList(sources: ConnectSource[]): string {
  const names = sources.map(source => source.name)
  const listed = names.length > 4 ? [...names.slice(0, 3), `${names.length - 3} more`] : names
  return listed.length <= 1 ? listed.join('') : `${listed.slice(0, -1).join(', ')} and ${listed.at(-1)}`
}

function Brand() {
  return <div className="mx-auto mb-12 w-[min(400px,78%)] text-neutral-200 [mask-image:linear-gradient(#000,transparent)] max-sm:mb-9 [&_svg]:w-full">
    <BrandMark />
  </div>
}

const refusalCopy = {
  access_required: { title: 'Sign in to continue', message: 'Your sign-in has ended. Reload this page and sign in with your work account.' },
  connect_not_member: { title: 'You don’t have access yet', message: 'Ask your gateway administrator to add you to the gateway.' },
  connect_other_team: { title: 'This page is for another team', message: 'Your own page shows the sources you can use.', ownPage: true },
  connect_team_missing: { title: 'This team page no longer exists', message: 'The team may have been removed.', ownPage: true },
  connect_page_off: { title: 'This page is turned off', message: 'Ask your gateway administrator for the current link.' },
  connect_unavailable: { title: 'This page is unavailable', message: 'Try again in a moment.' },
} satisfies Record<ConnectRefusal, { title: string; message: string; ownPage?: boolean }>

function Refusal({ refusal }: { refusal: ConnectRefusal }) {
  const copy: { title: string; message: string; ownPage?: boolean } = refusalCopy[refusal]
  return <main className="flex min-h-dvh items-center justify-center bg-[#101010] px-4 text-neutral-50">
    <div className="w-full max-w-md text-center">
      <Brand />
      <h1 className="m-0 text-2xl font-medium tracking-tight">{copy.title}</h1>
      <p className="m-0 mt-3 text-neutral-400">{copy.message}</p>
      {copy.ownPage ? <a href={CONNECT_PAGE_PATH} className="mt-6 inline-flex rounded-full bg-white px-4 py-2 text-sm font-medium text-neutral-950">Open your page</a> : null}
    </div>
  </main>
}

export function ConnectApp({ view }: { view: ConnectView }) {
  const lede = view.sources.length === 0
    ? 'No sources are shared with you yet. Ask your gateway administrator to add you to a team.'
    : `Connect once to use ${sourceList(view.sources)} from Claude, ChatGPT or any MCP client.`
  return <div className="min-h-dvh bg-[#f6f6f5]">
    <div className="bg-[#101010] text-neutral-50">
      <div className="mx-auto max-w-[1040px] px-4 pb-20 pt-16 max-sm:pb-14 max-sm:pt-10">
        <Brand />
        <header className="mx-auto mb-12 max-w-[820px] text-center">
          <h1 className="m-0 text-balance text-[clamp(32px,5.2vw,48px)] font-[450] leading-[1.15] tracking-[-0.025em]">
            {view.gateway.name}. <span className="text-neutral-500">Your team’s tools, inside your AI assistant.</span>
          </h1>
          <p className="mx-auto mb-0 mt-5 max-w-[640px] text-pretty text-base leading-[1.75] text-neutral-400">{lede}</p>
          <p className="m-0 mt-2.5 text-[13px] text-neutral-500">Signed in as {view.viewer.email}{view.team ? ` · ${view.team.name}` : ''}</p>
        </header>
        <ConnectCard view={view} />
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2.5 text-sm text-neutral-400">
          <span>Or add this URL to any MCP client</span>
          <code className="rounded-[10px] border border-white/10 bg-white/5 px-2.5 py-1.5 font-[ui-monospace,SFMono-Regular,Menlo,monospace] text-[13px] text-neutral-50 [overflow-wrap:anywhere]">{view.gateway.mcpUrl}</code>
          <CopyButton text={view.gateway.mcpUrl} label="Copy the MCP server URL" />
        </div>
      </div>
    </div>
    <div className="text-neutral-950 [color-scheme:light]">
      <div className="mx-auto max-w-[1040px] px-4 pb-14 pt-22 max-sm:pt-14">
        <Examples view={view} />
        <div className="mt-16 grid gap-6 border-t border-black/10 pt-8 md:grid-cols-2">
          <div>
            <h3 className="m-0 text-[15px] font-medium text-neutral-900">A source is missing in your assistant</h3>
            <p className="m-0 mt-1.5 text-sm leading-relaxed text-neutral-600">Ask it to list the gateway’s servers and turn on the one you need. Sources added after you connected start turned off.</p>
          </div>
          <div>
            <h3 className="m-0 text-[15px] font-medium text-neutral-900">A source is missing on this page</h3>
            <p className="m-0 mt-1.5 text-sm leading-relaxed text-neutral-600">Your gateway administrators decide which sources each team can use. Ask them for access.</p>
          </div>
        </div>
        <footer className="mt-12 text-center text-xs text-neutral-400">Self-hosted in your team’s Cloudflare account.</footer>
      </div>
    </div>
  </div>
}

/** Loads what the visitor may see, then shows the page or the gateway's refusal. */
export function ConnectPage({ loader }: { loader: (pathname: string) => Promise<ConnectLoad> }) {
  const [load, setLoad] = useState<ConnectLoad | null>(null)
  useEffect(() => {
    let active = true
    void loader(window.location.pathname).then(next => { if (active) setLoad(next) })
    return () => { active = false }
  }, [loader])
  useEffect(() => {
    if (load && 'view' in load) document.title = `Connect · ${load.view.team ? `${load.view.gateway.name} · ${load.view.team.name}` : load.view.gateway.name}`
  }, [load])
  if (!load) return <main className="min-h-dvh bg-[#101010]" aria-busy="true"><p className="sr-only">Loading…</p></main>
  return 'view' in load ? <ConnectApp view={load.view} /> : <Refusal refusal={load.refusal} />
}
