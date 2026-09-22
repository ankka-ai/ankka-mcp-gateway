import { useCallback, useEffect, useRef, useState } from 'react'
import { type DiscoveredTool, type ManagedSource, type SourceActionSummary, type SourceActionTools, validHandoffUrl } from '../api'
import { useGateway } from '../GatewayContext'
import { Button } from './Button'
import { ToolChecklist } from './ToolChecklist'

interface SourceToolChoiceProps {
  action: SourceActionSummary
  source: ManagedSource
  /** The saved-draft revision the choice is bound to. */
  revision: number
  /** The reviewed catalog's recommendation for this endpoint, when it has one. */
  recommendedTools: readonly string[]
  disabled: boolean
  /** What Cloudflare says about the source right now, which can be newer than the reason the journal last recorded. */
  onState?(actionId: string, state: SourceActionTools['state']): void
}

function hasHint(tool: DiscoveredTool): boolean {
  return [tool.readOnlyHint, tool.destructiveHint, tool.openWorldHint].some((hint) => hint === true || hint === false)
}

/**
 * What the list can honestly say about itself. Cloudflare does not promise what a synced tool record carries, so the
 * wording counts what this list really has instead of assuming the hints a public source shows.
 */
export function syncedHintSummary(tools: DiscoveredTool[]): string {
  const hinted = tools.filter(hasHint).length
  const described = tools.some((tool) => Boolean(tool.description))
  if (hinted === 0) {
    return `Cloudflare’s synced list for this connector carries no read-only or destructive hints${described ? '' : ' and no descriptions'}, so none are shown. Check what each tool does in the connector’s own documentation before you allow it.`
  }
  return `Hints and descriptions are the connector’s own claims, as Cloudflare synced them; ${tools.length - hinted} of ${tools.length} tools carry no hint. They help you review. They do not make a tool read-only.`
}

const WAITING = {
  connection_required: 'This connector needs authorization before its tools can be listed. After authorizing, check again. Nothing is enabled until you choose.',
  sync_required: 'Cloudflare has not finished syncing the tools of this connector. In Cloudflare, use Sync capabilities and resolve any connection error, then check again.',
  unsupported: 'Cloudflare’s synced list for this connector cannot be offered here: it has more than 500 tools, a repeated name, or a name the gateway does not accept. Nothing is enabled.',
} satisfies Record<Exclude<SourceActionTools['state'], 'ready'>, string>

/**
 * The tool choice of a connected sign-in source. The source was installed with nothing enabled; this lists its real
 * tools from Cloudflare's synced list, saves the choice as its own revision-bound step, and then resumes the recorded
 * installation, which attaches exactly those tools.
 */
export function SourceToolChoice({ action, source, revision, recommendedTools, disabled, onState }: SourceToolChoiceProps) {
  const { api, refreshSourceActions, refreshSources } = useGateway()
  const [offered, setOffered] = useState<SourceActionTools | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mounted = useRef(true)
  const reads = useRef(0)
  const seeded = useRef(false)
  const ready = useRef(false)
  // Preselected once, when the list first appears: the names the draft already has (a saved choice, or names typed
  // under the old flow), otherwise the catalog's recommendation. Only names that exist in the real list are kept, and
  // nothing is preselected from a hint.
  const preferred = useRef<readonly string[]>([])
  useEffect(() => {
    preferred.current = source.enabledTools.length > 0 ? source.enabledTools : recommendedTools
  }, [recommendedTools, source.enabledTools])

  const load = useCallback(async () => {
    const read = ++reads.current
    setLoading(true)
    setError(null)
    try {
      const next = await api.getSourceActionTools(action.actionId)
      if (!mounted.current || read !== reads.current) return
      ready.current = next.state === 'ready'
      setOffered(next)
      if (next.state === 'ready' && !seeded.current) {
        // In the same update as the list, so the list never shows without its preselection.
        seeded.current = true
        const names = new Set(next.tools.map((tool) => tool.name))
        setSelected(preferred.current.filter((name) => names.has(name)))
      }
    } catch (cause) {
      if (mounted.current && read === reads.current) setError(cause instanceof Error ? cause.message : 'The tool list could not be read.')
    } finally {
      if (mounted.current && read === reads.current) setLoading(false)
    }
  }, [action.actionId, api])

  useEffect(() => {
    mounted.current = true
    void load()
    // Coming back from Cloudflare is the moment the list may have appeared. A list already shown is left alone, so a
    // selection in progress is never replaced.
    const recheck = () => { if (!ready.current && document.visibilityState === 'visible') void load() }
    window.addEventListener('focus', recheck)
    return () => {
      mounted.current = false
      reads.current += 1
      window.removeEventListener('focus', recheck)
    }
  }, [load])

  const offeredState = offered?.state
  useEffect(() => { if (offeredState !== undefined) onState?.(action.actionId, offeredState) }, [action.actionId, offeredState, onState])

  const finish = async () => {
    if (saving || selected.length === 0) return
    setSaving(true)
    setError(null)
    try {
      const chosen = await api.chooseSourceActionTools(action.actionId, revision, source.id, selected)
      const resumed = await api.prepareSourceAction(chosen.revision, source.id, action.actionId)
      if (resumed.status === 'authorization_required') {
        const destination = validHandoffUrl(resumed.handoffUrl, window.location.origin)
        if (destination === null) throw new Error('The authorization link could not be verified.')
        window.location.assign(destination)
      }
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : 'The tool choice could not be confirmed. Check status before trying again.')
    } finally {
      // Whatever was lost on the way, the saved draft and the recorded action say what happened.
      await refreshSources().catch(() => {})
      await refreshSourceActions().catch(() => {})
      if (mounted.current) setSaving(false)
    }
  }

  const tools = offered?.state === 'ready' ? offered.tools : []
  const available = new Set(tools.map((tool) => tool.name))
  const missingRecommended = offered?.state === 'ready' ? recommendedTools.filter((tool) => !available.has(tool)) : []
  const preselected = offered?.state === 'ready' && recommendedTools.some((tool) => available.has(tool))

  return (
    <section className="mt-4 rounded-xl border border-kumo-line bg-kumo-tint/55 p-4" aria-label={`Tools of ${source.label}`}>
      <h4 className="text-sm font-semibold text-kumo-strong">Choose the tools to allow</h4>
      {offered === null && loading ? <p role="status" className="mt-2 text-xs leading-5 text-kumo-subtle">Reading this connector’s tools from Cloudflare…</p> : null}
      {offered !== null && offered.state !== 'ready' ? <p role="status" className="mt-2 max-w-[80ch] text-xs leading-5 text-kumo-subtle">{WAITING[offered.state]}</p> : null}
      {error ? <p role="alert" className="mt-2 text-xs leading-5 text-danger">{error}</p> : null}
      {offered?.state !== 'ready' ? (
        <Button type="button" variant="secondary" className="pressable mt-3" loading={loading} disabled={disabled || loading} onClick={() => void load()}>Check again</Button>
      ) : (
        <>
          <p className="mt-2 max-w-[80ch] text-xs leading-5 text-kumo-subtle">
            {tools.length} tool{tools.length === 1 ? '' : 's'} in Cloudflare’s synced list of this connector.{preselected ? ' Catalog recommendations that exist are preselected for review.' : ''} Only the tools you select are attached; everything else stays disabled.
          </p>
          <p className="mt-1 max-w-[80ch] text-xs leading-5 text-kumo-subtle">{syncedHintSummary(tools)}</p>
          {missingRecommended.length > 0 ? (
            <div className="mt-3 rounded-xl border border-kumo-line bg-kumo-tint/55 p-4 text-xs leading-5 text-kumo-subtle" role="status">
              <strong className="block text-sm text-kumo-strong">Catalog recommendation changed</strong>
              {missingRecommended.length} recommended exact tool{missingRecommended.length === 1 ? ' is' : 's are'} absent from this connector’s real list.
              <div className="mt-2 flex flex-wrap gap-2">
                {missingRecommended.map((tool) => <code key={tool} className="tool-chip">{tool}</code>)}
              </div>
            </div>
          ) : null}
          <div className="mt-4">
            <ToolChecklist
              tools={tools}
              selected={selected}
              onChange={setSelected}
              listLabel="Synced tools"
              missingDescription="No description in Cloudflare’s synced list."
              disabled={saving}
            />
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-kumo-line pt-4">
            <Button type="button" variant="primary" className="pressable" loading={saving} disabled={disabled || saving || selected.length === 0} onClick={() => void finish()}>
              {selected.length === 0 ? 'Allow tools and finish installation' : `Allow ${selected.length} tool${selected.length === 1 ? '' : 's'} and finish installation`}
            </Button>
            <span className="max-w-[60ch] text-xs leading-5 text-kumo-subtle">
              {selected.length === 0
                ? 'Select at least one tool. Until then the connector stays installed with nothing enabled.'
                : 'The gateway saves this selection, then attaches the connector with exactly these tools. Nobody is assigned access.'}
            </span>
          </div>
        </>
      )}
    </section>
  )
}
