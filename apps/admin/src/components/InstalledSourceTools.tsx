import { useEffect, useId, useState } from 'react'
import { GatewayApiError, type InstalledSourceTools, type ManagedSource } from '../api'
import { Button } from './Button'
import { syncedHintSummary } from './SourceToolChoice'
import { ToolChecklist } from './ToolChecklist'

interface InstalledSourceToolsProps {
  source: ManagedSource
  disabled: boolean
  onLoad(sourceId: string): Promise<InstalledSourceTools>
  onSave(sourceId: string, revision: number, enabledTools: string[]): Promise<void>
}

const WAITING = {
  connection_required: 'This connector needs authorization before its tools can be listed. After connecting it in Cloudflare, check again. Nothing changes until you save.',
  sync_required: 'Cloudflare has not finished syncing the tools of this connector. In Cloudflare, use Sync capabilities, then check again. Nothing changes until you save.',
  unsupported: 'Cloudflare’s synced list for this connector cannot be offered here. Nothing was changed.',
} satisfies Record<Exclude<InstalledSourceTools['state'], 'ready'>, string>

function selectedFrom(catalogue: InstalledSourceTools): string[] {
  const names = new Set(catalogue.tools.map((tool) => tool.name))
  return (catalogue.pendingTools ?? catalogue.enabledTools).filter((name) => names.has(name)).sort()
}

/**
 * Review an installed connector’s available tools and save an explicit allowlist.
 * Opening the editor fetches that list. Tools that were not already allowed start unselected.
 */
export function InstalledSourceToolsEditor({ source, disabled, onLoad, onSave }: InstalledSourceToolsProps) {
  const [open, setOpen] = useState(false)
  const [catalogue, setCatalogue] = useState<InstalledSourceTools | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const next = await onLoad(source.id)
      setCatalogue(next)
      setSelected(selectedFrom(next))
      setOpen(true)
    } catch (cause) {
      setError(cause instanceof GatewayApiError ? cause.message : 'The gateway request failed. Refresh and try again.')
      setOpen(true)
    } finally {
      setLoading(false)
    }
  }

  async function save() {
    if (!catalogue) return
    const choice = catalogue.pendingTools ?? [...selected].sort()
    setSaving(true)
    setError(null)
    try {
      await onSave(source.id, catalogue.revision, choice)
      setOpen(false)
      setCatalogue(null)
    } catch (cause) {
      setError(cause instanceof GatewayApiError ? cause.message : 'The gateway request failed. Refresh and try again.')
    } finally {
      setSaving(false)
    }
  }

  const busy = disabled || loading || saving
  const pending = catalogue?.pendingTools ?? null
  const missing = catalogue === null ? [] : (pending ?? catalogue.enabledTools).filter((name) => (
    !catalogue.tools.some((tool) => tool.name === name)
  ))
  const builtin = catalogue?.catalogueSource === 'gateway'
  const ready = catalogue?.state === 'ready'
  const canSave = ready === true && selected.length > 0 && (pending === null || missing.length === 0)

  return (
    <div className="mt-4">
      <Button type="button" variant="secondary" className="pressable" disabled={busy} loading={loading} onClick={() => void load()}>
        {open ? 'Check again' : 'Edit tools'}
      </Button>
      {open ? (
        <div className="mt-4">
          {loading ? <p className="text-sm text-kumo-subtle">Reading this connector’s available tools…</p> : null}
          {error ? <p role="alert" className="text-sm text-kumo-danger">{error}</p> : null}
          {catalogue && !loading ? (
            <>
              {catalogue.state === 'ready' ? (
                <p className="text-sm leading-6 text-kumo-subtle">
                  {catalogue.tools.length} tools {builtin ? 'in your installed gateway release' : 'in Cloudflare’s synced list'}. The tools already allowed are selected. New tools stay off until you select them.
                </p>
              ) : <p className="text-sm leading-6 text-kumo-subtle">{WAITING[catalogue.state]}</p>}
              {ready && catalogue.tools.length > 0 ? <p className="mt-2 text-xs leading-5 text-kumo-subtle">{builtin ? 'This list comes from your gateway. Saving your selection automatically syncs Gateway Management with Cloudflare when needed.' : syncedHintSummary(catalogue.tools)}</p> : null}
              {missing.length > 0 ? (
                <p className="mt-3 text-sm leading-6 text-kumo-subtle">
                  {builtin ? 'These previously allowed tools are not in the installed gateway release. Review your selection before saving.' : pending
                    ? 'This tool update is still in progress, and some of its tools are no longer in Cloudflare’s synced list. Sync capabilities in Cloudflare, then check again.'
                    : 'These allowed tools are not in Cloudflare’s synced list. Saving removes them from the allowlist.'}
                  <span className="mt-2 flex flex-wrap gap-2">{missing.map((name) => <code key={name} className="tool-chip break-all">{name}</code>)}</span>
                </p>
              ) : null}
              {ready ? (
                <div className="mt-4">
                  <ToolChecklist
                    tools={catalogue.tools}
                    selected={pending ?? selected}
                    onChange={setSelected}
                    listLabel={`${source.label} ${builtin ? 'available' : 'synced'} tools`}
                    missingDescription={builtin ? 'This tool has no description in the installed gateway release.' : 'This tool has no description in Cloudflare’s synced list.'}
                    disabled={busy || pending !== null}
                  />
                </div>
              ) : null}
              <p className="mt-4 text-xs leading-5 text-kumo-subtle">This updates the gateway’s allowlist and the Portal configuration for this connector. Who can use it does not change.</p>
              <Button type="button" variant="primary" className="pressable mt-3" disabled={busy || !canSave} loading={saving} onClick={() => void save()}>
                {pending ? 'Finish tool update' : 'Save tools'}
              </Button>
            </>
          ) : null}
        </div>
      ) : error ? <p role="alert" className="mt-3 text-sm text-kumo-danger">{error}</p> : null}
    </div>
  )
}

function nameIsValid(value: string): boolean {
  if (value.length < 2 || value.length > 80 || value.trim() !== value) return false
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 31 || code === 127) return false
  }
  return true
}

/** Rename an installed connector. The URL, tools, and who can use it stay as they are. */
export function InstalledSourceName({ source, disabled, onRename }: {
  source: ManagedSource
  disabled: boolean
  onRename(sourceId: string, label: string): Promise<void>
}) {
  const inputId = useId()
  const [name, setName] = useState(source.label)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  useEffect(() => { setName(source.label) }, [source.label])
  const unchanged = name === source.label
  const busy = disabled || saving

  async function save() {
    if (!nameIsValid(name) || unchanged) return
    setSaving(true)
    setError(null)
    try {
      await onRename(source.id, name)
    } catch (cause) {
      setError(cause instanceof GatewayApiError ? cause.message : 'The gateway request failed. Refresh and try again.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mt-4">
      <label className="block text-xs font-medium text-kumo-subtle" htmlFor={inputId}>Name
        <input id={inputId} className="text-input mt-2 w-full max-w-md" value={name} maxLength={80} disabled={busy}
          onChange={(event) => { setName(event.target.value); setError(null) }} />
      </label>
      <p className="mt-2 text-xs leading-5 text-kumo-subtle">This changes the name in your gateway, in Team, and on this connector’s Access policy. Who can use it does not change.</p>
      {error ? <p role="alert" className="mt-2 text-sm text-kumo-danger">{error}</p> : null}
      <Button type="button" variant="secondary" className="pressable mt-3" disabled={busy || unchanged || !nameIsValid(name)} loading={saving} onClick={() => void save()}>Save name</Button>
    </div>
  )
}
