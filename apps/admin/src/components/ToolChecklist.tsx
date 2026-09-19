import { useId, useMemo, useState } from 'react'
import type { DiscoveredTool } from '../api'
import { Button } from './Button'

interface ToolChecklistProps {
  tools: DiscoveredTool[]
  selected: string[]
  onChange(next: string[]): void
  /** Names the scrollable list for assistive technology, by where the tools came from. */
  listLabel: string
  /** Shown for a tool whose origin supplied no description. */
  missingDescription: string
  disabled?: boolean
}

function annotation(tool: DiscoveredTool): string {
  const flags = []
  if (tool.readOnlyHint === true) flags.push('read-only hint')
  if (tool.destructiveHint === true) flags.push('destructive hint')
  if (tool.openWorldHint === true) flags.push('open-world hint')
  return flags.length ? flags.join(' · ') : 'No safety annotations'
}

/**
 * The exact-tool checkbox list with its filter. A public source fills it from live discovery before saving; a sign-in
 * source fills it from Cloudflare's synced list after the operator has connected it. Names, descriptions and hints are
 * source-authored either way: review aids, never an authorization boundary.
 */
export function ToolChecklist({ tools, selected, onChange, listLabel, missingDescription, disabled = false }: ToolChecklistProps) {
  const [filter, setFilter] = useState('')
  const filterId = useId()
  const selectedNames = useMemo(() => new Set(selected), [selected])
  const visibleTools = useMemo(() => {
    const query = filter.trim().toLocaleLowerCase()
    if (!query) return tools
    return tools.filter((tool) => (
      tool.name.toLocaleLowerCase().includes(query) ||
      tool.title?.toLocaleLowerCase().includes(query) === true ||
      tool.description?.toLocaleLowerCase().includes(query) === true
    ))
  }, [filter, tools])

  return (
    <div>
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
        <label className="block" htmlFor={filterId}>
          <span className="mb-1.5 block text-sm font-medium text-kumo-default">Filter tools</span>
          <input
            id={filterId}
            className="text-input w-full"
            type="search"
            placeholder="Name, title, or description"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
        </label>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="secondary"
            className="pressable"
            disabled={disabled || visibleTools.length === 0}
            onClick={() => onChange([...new Set([...selected, ...visibleTools.map((tool) => tool.name)])])}
          >Select shown</Button>
          <Button
            type="button"
            variant="secondary"
            className="pressable"
            disabled={disabled || visibleTools.every((tool) => !selectedNames.has(tool.name))}
            onClick={() => {
              const visibleNames = new Set(visibleTools.map((tool) => tool.name))
              onChange(selected.filter((name) => !visibleNames.has(name)))
            }}
          >Clear shown</Button>
        </div>
      </div>
      <p className="mt-2 text-xs text-kumo-subtle">
        Showing {visibleTools.length} of {tools.length} tools; {selected.length} selected.
      </p>
      <div className="mt-4 grid max-h-[38rem] gap-3 overflow-y-auto pr-1" tabIndex={0} aria-label={listLabel}>
        {visibleTools.map((tool) => (
          <label key={tool.name} className="tool-option-card">
            <input
              type="checkbox"
              checked={selectedNames.has(tool.name)}
              disabled={disabled}
              onChange={(event) => onChange(event.target.checked
                ? [...new Set([...selected, tool.name])]
                : selected.filter((name) => name !== tool.name))}
            />
            <span className="min-w-0">
              <span className="flex flex-wrap items-baseline gap-x-2"><strong className="text-sm text-kumo-strong">{tool.title || tool.name}</strong><code className="text-xs text-kumo-subtle">{tool.name}</code></span>
              <span className="mt-1 block text-xs leading-5 text-kumo-subtle">{tool.description || missingDescription}</span>
              <small className="mt-1 block text-[0.6875rem] text-kumo-inactive">{annotation(tool)}</small>
            </span>
          </label>
        ))}
        {visibleTools.length === 0 ? (
          <p className="rounded-lg border border-dashed border-kumo-line p-5 text-center text-sm text-kumo-subtle">No tools match this filter.</p>
        ) : null}
      </div>
    </div>
  )
}
