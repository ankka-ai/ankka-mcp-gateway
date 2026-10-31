import { ArrowSquareOut, Check, Copy, Plus, Trash } from '@phosphor-icons/react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  CONNECT_ANSWER_MAX,
  CONNECT_EXAMPLE_SOURCES_MAX,
  CONNECT_EXAMPLES_MAX,
  CONNECT_FAILURE_MESSAGES,
  CONNECT_PAGE_PATH,
  CONNECT_PROMPT_MAX,
  GatewayApiError,
  type ConnectExample,
  type ConnectState,
  type Team,
} from '../api'
import { Button } from '../components/Button'
import { Checkbox } from '../components/Checkbox'
import { DashboardSkeleton } from '../components/DashboardSkeleton'
import { PageHeader } from '../components/PageHeader'
import { StatusPill } from '../components/StatusPill'
import { useGateway } from '../GatewayContext'

interface ConnectorOption { id: string; name: string }

function newExampleId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6))
  return `example-${[...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')}`
}

function canonicalExamples(examples: ConnectExample[]): ConnectExample[] {
  return examples.map(example => {
    const canonical: ConnectExample = { id: example.id, prompt: example.prompt.trim(), sourceIds: [...example.sourceIds].sort() }
    const answer = example.answer?.trim()
    if (answer) canonical.answer = answer
    return canonical
  })
}

function errorText(cause: unknown, fallback: string): string {
  return cause instanceof GatewayApiError ? cause.message : fallback
}

function CopyLink({ href, label }: { href: string; label: string }) {
  const [copied, setCopied] = useState<'idle' | 'copied' | 'error'>('idle')
  useEffect(() => {
    if (copied === 'idle') return
    const timer = window.setTimeout(() => setCopied('idle'), 2000)
    return () => window.clearTimeout(timer)
  }, [copied])
  return <div className="flex shrink-0 items-center gap-2">
    <Button type="button" variant="secondary" className="min-w-24 justify-center" aria-label={`Copy link for ${label}`}
      onClick={() => { navigator.clipboard.writeText(href).then(() => setCopied('copied'), () => setCopied('error')) }}>
      {copied === 'copied' ? <Check size={16} aria-hidden="true" className="text-success-strong" /> : <Copy size={16} aria-hidden="true" />}
      <span>{copied === 'copied' ? 'Copied' : copied === 'error' ? 'Copy failed' : 'Copy link'}</span>
    </Button>
    <a className="gateway-button pressable inline-flex size-9 items-center justify-center rounded-lg" data-gateway-variant="secondary"
      href={href} target="_blank" rel="noopener noreferrer" aria-label={`Open the page for ${label}`}>
      <ArrowSquareOut size={16} aria-hidden="true" />
    </a>
  </div>
}

export function ConnectPage() {
  const { getConnect, saveConnectExamples, setConnectPage, getTeam, sources } = useGateway()
  const [connect, setConnect] = useState<ConnectState | null>(null)
  const [team, setTeam] = useState<Team | null>(null)
  const [draft, setDraft] = useState<ConnectExample[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [pageError, setPageError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [switching, setSwitching] = useState(false)
  const [saved, setSaved] = useState(false)
  const [invalid, setInvalid] = useState(false)

  const connectors = useMemo<ConnectorOption[]>(() => (sources?.sources ?? [])
    .filter(source => source.status === 'installed')
    .map(source => ({ id: source.id, name: source.company ? `${source.company} · ${source.label}` : source.label }))
    .sort((left, right) => left.name.localeCompare(right.name)), [sources])
  const installed = useMemo(() => new Set(connectors.map(connector => connector.id)), [connectors])

  const accept = useCallback((next: ConnectState) => {
    setConnect(next)
    setDraft(next.examples)
  }, [])
  // The gateway refuses a removed connector on an example; saving takes it off.
  const removedConnectors = useCallback((example: ConnectExample) =>
    installed.size === 0 ? [] : example.sourceIds.filter(id => !installed.has(id)), [installed])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [next, nextTeam] = await Promise.all([getConnect(), getTeam().catch(() => null)])
      accept(next)
      setTeam(nextTeam)
    } catch (cause) {
      setError(errorText(cause, 'Connect pages could not be loaded. Try again.'))
    } finally { setLoading(false) }
  }, [accept, getConnect, getTeam])

  useEffect(() => { void load() }, [load])
  useEffect(() => {
    if (!saved) return
    const timer = window.setTimeout(() => setSaved(false), 4000)
    return () => window.clearTimeout(timer)
  }, [saved])

  const changed = connect !== null && JSON.stringify(canonicalExamples(draft)) !== JSON.stringify(canonicalExamples(connect.examples))
  const strippedConnectors = draft.some(example => removedConnectors(example).length > 0)
  const teams = team?.teams ?? []

  const switchPage = async (enabled: boolean) => {
    setSwitching(true)
    setPageError(null)
    try { setConnect(await setConnectPage(enabled)) }
    catch (cause) { setPageError(errorText(cause, 'The change could not be confirmed. Refresh to check the page state.')) }
    finally { setSwitching(false) }
  }

  const save = async () => {
    if (!connect) return
    const examples = canonicalExamples(draft).map(example => ({ ...example,
      sourceIds: example.sourceIds.filter(id => !removedConnectors(example).includes(id)) }))
    if (examples.some(example => example.prompt.length === 0 || example.prompt.length > CONNECT_PROMPT_MAX ||
        (example.answer?.length ?? 0) > CONNECT_ANSWER_MAX)) {
      setInvalid(true)
      return
    }
    setSaving(true)
    setError(null)
    try {
      accept(await saveConnectExamples(connect.revision, examples))
      setSaved(true)
    } catch (cause) {
      setError(errorText(cause, 'The examples could not be saved. Refresh before trying again.'))
    } finally { setSaving(false) }
  }

  const update = (id: string, change: Partial<ConnectExample>) => {
    setSaved(false)
    setInvalid(false)
    setDraft(current => current.map(example => example.id === id ? { ...example, ...change } : example))
  }

  const visibleTo = (example: ConnectExample): string => {
    if (example.sourceIds.length === 0) return 'Everyone'
    if (removedConnectors(example).length) return 'Nobody until the removed connectors are taken off'
    const names = teams.filter(grant => grant.memberEmails.length > 0 && example.sourceIds.every(id => grant.sourceIds.includes(id))).map(grant => grant.name)
    return names.length ? names.join(', ') : 'No team has all of these connectors yet'
  }

  if (loading && !connect) return <div><PageHeader title="Connect pages" /><DashboardSkeleton page="settings" showHeader={false} /></div>
  if (!connect) return <div>
    <PageHeader title="Connect pages" />
    <p role="alert" className="notice-banner notice-error mt-6">{error ?? 'Connect pages could not be loaded.'}</p>
    <Button variant="secondary" className="mt-3" onClick={() => void load()}>Try again</Button>
  </div>

  const origin = window.location.origin
  const status = connect.page.status
  const pending = status === 'enabling' || status === 'disabling'

  return (
    <div>
      <PageHeader title="Connect pages" description="Give each team one link that shows how to connect an AI assistant to this gateway, and example questions their connectors can answer." />

      <section className="mt-7" aria-labelledby="connect-links-title">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <h2 id="connect-links-title" className="text-base font-semibold text-subheading">Team links</h2>
            <StatusPill tone={status === 'on' ? 'ready' : pending ? 'attention' : 'waiting'}>
              {status === 'on' ? 'On' : status === 'enabling' ? 'Turning on' : status === 'disabling' ? 'Turning off' : 'Off'}
            </StatusPill>
          </div>
          {status === 'on' ? <Button variant="secondary" loading={switching} onClick={() => void switchPage(false)}>Turn off</Button> : null}
        </div>
        {connect.page.failureCode ? <div role="alert" className="notice-banner notice-error mt-4">
          <p>{CONNECT_FAILURE_MESSAGES[connect.page.failureCode]}</p>
        </div> : null}
        {pageError ? <p role="alert" className="notice-banner notice-error mt-4">{pageError}</p> : null}
        {status === 'off' || pending ? <div className="mt-4 rounded-xl border border-kumo-line bg-kumo-overlay p-5">
          <p className="max-w-[70ch] text-sm leading-6 text-kumo-subtle">
            Turning this on adds one Cloudflare Access application for <span className="break-all font-medium text-kumo-default">{new URL(origin).host}{CONNECT_PAGE_PATH}</span> in your account.
            It only asks people to sign in. Your gateway then shows each person their own connectors, and a team’s page only to that team and to dashboard administrators.
            The page grants no access to tools.
          </p>
          {!connect.managementCredentialConfigured ? <p role="status" className="notice-banner notice-warning mt-4">Add your management token in Settings first. The gateway uses it to create the Access application.</p> : null}
          <div className="mt-4 flex flex-wrap gap-2">
            <Button variant="primary" loading={switching} disabled={!connect.managementCredentialConfigured || status === 'disabling'} onClick={() => void switchPage(true)}>
              {status === 'enabling' ? 'Try again' : 'Turn on'}
            </Button>
            {pending ? <Button variant="secondary" disabled={switching} onClick={() => void switchPage(false)}>{status === 'disabling' ? 'Try again' : 'Turn off'}</Button> : null}
          </div>
        </div> : null}
        {status === 'on' ? <div className="mt-4 border-t border-kumo-line">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-kumo-line/70 py-4">
            <div className="min-w-0">
              <p className="text-sm font-medium text-kumo-strong">Everyone</p>
              <p className="mt-1 text-xs text-kumo-subtle">Each person sees the connectors they can use, from any team.</p>
              <p className="mt-1 break-all text-xs text-kumo-subtle">{origin}{CONNECT_PAGE_PATH}</p>
            </div>
            <CopyLink href={`${origin}${CONNECT_PAGE_PATH}`} label="everyone" />
          </div>
          {teams.map(grant => (
            <div key={grant.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-kumo-line/70 py-4">
              <div className="min-w-0">
                <p className="break-words text-sm font-medium text-kumo-strong">{grant.name}</p>
                <p className="mt-1 text-xs text-kumo-subtle">{grant.memberEmails.length} {grant.memberEmails.length === 1 ? 'member' : 'members'} · {grant.sourceIds.length} {grant.sourceIds.length === 1 ? 'connector' : 'connectors'}</p>
                <p className="mt-1 break-all text-xs text-kumo-subtle">{origin}{CONNECT_PAGE_PATH}/{grant.id}</p>
              </div>
              <CopyLink href={`${origin}${CONNECT_PAGE_PATH}/${grant.id}`} label={grant.name} />
            </div>
          ))}
          {team === null ? <p className="py-4 text-sm text-kumo-subtle">Your teams could not be loaded, so only the link for everyone is shown.</p> : null}
          {team !== null && teams.length === 0 ? <p className="py-4 text-sm text-kumo-subtle">Create teams on the Team page to get a link for each team.</p> : null}
        </div> : null}
      </section>

      <section className="mt-10" aria-labelledby="connect-examples-title">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <h2 id="connect-examples-title" className="text-base font-semibold text-subheading">Example questions</h2>
            {changed ? <StatusPill tone="attention">Unsaved changes</StatusPill> : null}
          </div>
          <Button variant="secondary" disabled={draft.length >= CONNECT_EXAMPLES_MAX} onClick={() => {
            setSaved(false)
            setDraft(current => [...current, { id: newExampleId(), prompt: '', sourceIds: [] }])
          }}><Plus size={16} aria-hidden="true" /> Add example</Button>
        </div>
        <p className="mt-2 max-w-[70ch] text-sm leading-6 text-kumo-subtle">
          Write them the way people on your team would ask, and say what the answer shows so they know what to expect. Tick the connectors each question needs: a person sees an example only when they can use all of them.
          Without examples, the page suggests a starter question for each connector. An agent can also write them with the set_connect_examples tool on Gateway Management.
        </p>
        {strippedConnectors ? <p role="status" className="notice-banner notice-warning mt-4">Some examples name connectors that were removed. Saving takes those connectors off the examples.</p> : null}
        {error ? <p role="alert" className="notice-banner notice-error mt-4">{error}</p> : null}
        {saved ? <p role="status" className="notice-banner notice-success mt-4">Examples saved.</p> : null}
        <ol className="mt-4 flex flex-col gap-4">
          {draft.map((example, index) => {
            const promptId = `connect-example-${example.id}`
            const tooLong = example.prompt.trim().length > CONNECT_PROMPT_MAX
            const answerId = `connect-answer-${example.id}`
            const answerTooLong = (example.answer?.trim().length ?? 0) > CONNECT_ANSWER_MAX
            const empty = invalid && example.prompt.trim().length === 0
            return <li key={example.id} className="rounded-xl border border-kumo-line bg-kumo-overlay p-4 sm:p-5" aria-label={`Example ${index + 1}`}>
              <div className="flex items-start justify-between gap-3">
                <label htmlFor={promptId} className="text-sm font-medium text-kumo-strong">Question {index + 1}</label>
                <Button type="button" variant="secondary" className="size-9 justify-center p-0" aria-label={`Remove example ${index + 1}`}
                  onClick={() => { setSaved(false); setDraft(current => current.filter(item => item.id !== example.id)) }}>
                  <Trash size={16} aria-hidden="true" />
                </Button>
              </div>
              <textarea id={promptId} className="text-input mt-2 min-h-20 w-full" value={example.prompt} maxLength={CONNECT_PROMPT_MAX + 50}
                placeholder="Which campaigns spent the most last week, and what did they return?" aria-invalid={tooLong || empty}
                onChange={(event) => update(example.id, { prompt: event.target.value })} />
              {tooLong || empty ? <p role="alert" className="field-error">{empty ? 'Write a question or remove this example.' : `Keep it under ${CONNECT_PROMPT_MAX} characters.`}</p> : null}
              <label htmlFor={answerId} className="mt-3 block text-xs font-medium text-kumo-subtle">What the answer shows (optional)</label>
              <textarea id={answerId} className="text-input mt-1.5 min-h-14 w-full" value={example.answer ?? ''} maxLength={CONNECT_ANSWER_MAX + 50}
                placeholder="A ranked table of campaigns with spend, purchases and return, and which one to scale." aria-invalid={answerTooLong}
                onChange={(event) => update(example.id, { answer: event.target.value })} />
              {answerTooLong ? <p role="alert" className="field-error">Keep it under {CONNECT_ANSWER_MAX} characters.</p> : null}
              <fieldset className="mt-3">
                <legend className="text-xs font-medium text-kumo-subtle">Needs these connectors</legend>
                <div className="mt-2 flex flex-wrap gap-x-5 gap-y-2">
                  {connectors.map(connector => {
                    const checked = example.sourceIds.includes(connector.id)
                    const full = !checked && example.sourceIds.length >= CONNECT_EXAMPLE_SOURCES_MAX
                    return <label key={connector.id} className="inline-flex items-center gap-2 text-sm text-kumo-default">
                      <Checkbox checked={checked} disabled={full} onChange={(event) => update(example.id, {
                        sourceIds: event.target.checked ? [...example.sourceIds, connector.id] : example.sourceIds.filter(id => id !== connector.id),
                      })} />
                      {connector.name}
                    </label>
                  })}
                </div>
              </fieldset>
              {removedConnectors(example).length ? <p className="mt-3 text-xs text-warning-strong">Also names {removedConnectors(example).length === 1 ? 'a removed connector' : `${removedConnectors(example).length} removed connectors`}. Saving takes {removedConnectors(example).length === 1 ? 'it' : 'them'} off.</p> : null}
              <p className="mt-3 text-xs text-kumo-subtle">Shown to: {visibleTo(example)}</p>
            </li>
          })}
        </ol>
        {draft.length === 0 ? <p className="mt-4 text-sm text-kumo-subtle">No examples yet.</p> : null}
        <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-kumo-line pt-5">
          <Button variant="primary" loading={saving} disabled={!changed && !strippedConnectors} onClick={() => void save()}>Save examples</Button>
          {changed ? <Button variant="secondary" disabled={saving} onClick={() => { setInvalid(false); accept(connect) }}>Discard unsaved changes</Button> : null}
        </div>
      </section>
    </div>
  )
}
