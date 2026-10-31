import { Dialog } from '@cloudflare/kumo/primitives/dialog'
import { X } from '@phosphor-icons/react'
import { useState } from 'react'
import type { AgentGrant, DiscoveredTool, InstalledSourceTools, Team } from '../api'
import { Button } from './Button'
import { ToolChecklist } from './ToolChecklist'

type AgentTool = NonNullable<AgentGrant['tools']>[number]

interface Loaded {
  sourceId: string
  label: string
  prefix: string | undefined
  tools: DiscoveredTool[]
  selected: string[]
}

interface AgentToolsDialogProps {
  agent: AgentGrant
  /** The connectors this agent reaches once saved; only their tools are offered. */
  reach: string[]
  sources: Team['sources']
  disabled: boolean
  loadTools(sourceId: string): Promise<InstalledSourceTools>
  onSave(tools: AgentTool[]): void
}

/**
 * The tools an agent may call through the agent entrance. A connector the agent has no tools on yet starts
 * with the tools that call themselves read-only: a review aid, never a permission, which you confirm here.
 */
export function AgentToolsDialog({ agent, reach, sources, disabled, loadTools, onSave }: AgentToolsDialogProps) {
  const [open, setOpen] = useState(false)
  const [loaded, setLoaded] = useState<Loaded[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const count = (agent.tools ?? []).filter(tool => reach.includes(tool.sourceId)).length

  const load = async () => {
    setLoaded(null)
    setError(null)
    try {
      const results = await Promise.all(reach.map(async (sourceId) => {
        const catalogue = await loadTools(sourceId)
        const allowed = catalogue.allTools ? catalogue.tools : catalogue.tools.filter(tool => catalogue.enabledTools.includes(tool.name))
        const saved = (agent.tools ?? []).filter(tool => tool.sourceId === sourceId).map(tool => tool.name)
        const source = sources.find(entry => entry.id === sourceId)
        return {
          sourceId, label: source?.label ?? sourceId, prefix: source?.agentToolPrefix, tools: allowed,
          selected: saved.length > 0 ? saved.filter(name => allowed.some(tool => tool.name === name))
            : allowed.filter(tool => tool.readOnlyHint === true).map(tool => tool.name),
        }
      }))
      setLoaded(results)
    } catch {
      setError('The connectors’ tools could not be loaded. Close this dialog and try again.')
    }
  }

  const change = (nextOpen: boolean) => {
    setOpen(nextOpen)
    if (nextOpen) void load()
  }

  const save = () => {
    if (!loaded || disabled) return
    const kept = (agent.tools ?? []).filter(tool => !reach.includes(tool.sourceId))
    onSave([...kept, ...loaded.flatMap(entry => entry.selected.map(name => ({ name, sourceId: entry.sourceId })))]
      .sort((left, right) => left.sourceId.localeCompare(right.sourceId) || left.name.localeCompare(right.name)))
    setOpen(false)
  }

  return <Dialog.Root open={open} onOpenChange={change}>
    <Dialog.Trigger disabled={disabled || reach.length === 0} render={<Button variant="secondary" aria-label={`Tools for ${agent.name}`} />}>Tools ({count})</Dialog.Trigger>
    <Dialog.Portal>
      <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/65" />
      <Dialog.Popup className="fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-2xl -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-kumo-line bg-kumo-overlay text-kumo-default shadow-xl">
        <header className="shrink-0 border-b border-kumo-line p-5 sm:p-6">
          <div className="flex items-start justify-between gap-4">
            <Dialog.Title className="text-lg font-semibold text-kumo-strong">Tools for {agent.name}</Dialog.Title>
            <Dialog.Close render={<Button variant="ghost" aria-label="Close agent tools" />}><X size={20} aria-hidden="true" /></Dialog.Close>
          </div>
          <Dialog.Description className="mt-2 text-sm leading-6 text-kumo-subtle">Through the agent entrance, this agent can call only the tools you select here. A connector without a selection starts with the tools that describe themselves as read-only. That hint comes from the connector and is not a permission, so review each one before saving.</Dialog.Description>
        </header>
        <div className="overflow-y-auto overscroll-contain px-5 py-5 sm:px-6">
          {error ? <p role="alert" className="field-error">{error}</p> : null}
          {!loaded && !error ? <p role="status" className="text-sm text-kumo-subtle">Loading the connectors’ tools…</p> : null}
          {loaded?.map(entry => <section key={entry.sourceId} aria-label={entry.label} className="mt-2 border-b border-kumo-line/70 pb-5 last:border-b-0">
            <h3 className="text-sm font-semibold text-kumo-strong">{entry.label}</h3>
            {entry.prefix ? <p className="mt-1 text-xs text-kumo-subtle">The agent sees these as <code className="break-all">{entry.prefix}__tool_name</code>.</p> : null}
            <div className="mt-3">
              <ToolChecklist tools={entry.tools} selected={entry.selected} disabled={disabled} listLabel={`${entry.label} tools`}
                missingDescription="The connector gave no description."
                onChange={(next) => setLoaded(current => current?.map(item => item.sourceId === entry.sourceId ? { ...item, selected: next } : item) ?? current)} />
            </div>
          </section>)}
        </div>
        <footer className="flex shrink-0 justify-end gap-2 border-t border-kumo-line p-5 sm:px-6">
          <Dialog.Close render={<Button type="button" variant="secondary" />}>Cancel</Dialog.Close>
          <Button type="button" variant="primary" disabled={disabled || !loaded} onClick={save}>Use these tools</Button>
        </footer>
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>
}
