import { Button } from './Button'
import { DisclosureTrigger } from './Disclosure'
import { SourceIcon } from './SourceIcon'
import { InstalledSourceName, InstalledSourceToolsEditor } from './InstalledSourceTools'
import { SourceRemoval } from './SourceRemoval'
import { Check, Clock, MagnifyingGlass } from '@phosphor-icons/react'
import { Fragment, type ReactNode, useId, useState } from 'react'
import type { InstalledSourceTools, ManagedSource } from '../api'

const filters = [
  { value: 'all', label: 'All' },
  { value: 'installed', label: 'Installed' },
  { value: 'draft', label: 'Drafts' },
] as const

interface SourceListProps {
  sources: ManagedSource[]
  installationEnabled: boolean
  authorizeDisabled?: boolean
  isBusy: boolean
  installationDetails?(sourceId: string): ReactNode
  draftLabel?(sourceId: string): string
  /** One sentence to read before installing, shown directly beside each install control; nothing when null. */
  installNote?: string | null
  removalEnabled?: boolean | undefined
  removalDisabled?: boolean
  removalCredentialConfigured?: boolean | undefined
  pendingRemovalSourceId?: string | undefined
  managedBigQuerySourceIds?: string[] | undefined
  removalNote?: string | null
  onRemove?(sourceId: string): Promise<void>
  onRefresh?(): Promise<void>
  onAuthorize(sourceId: string): void
  canRemove?(sourceId: string): boolean
  removeDisabled?: boolean
  onRemoveDraft?(sourceId: string): void
  onLoadSourceTools?(sourceId: string): Promise<InstalledSourceTools>
  onSaveSourceTools?(sourceId: string, revision: number, enabledTools: string[]): Promise<void>
  onRenameSource?(sourceId: string, label: string): Promise<void>
  sourceToolsDisabled?: boolean
}

export function SourceList({ sources, installationEnabled, authorizeDisabled = false, isBusy, installationDetails, draftLabel, installNote = null, onAuthorize, removalEnabled, removalDisabled, removalCredentialConfigured, pendingRemovalSourceId, managedBigQuerySourceIds = [], removalNote = null, onRemove, onRefresh, canRemove, removeDisabled = false, onRemoveDraft, onLoadSourceTools, onSaveSourceTools, onRenameSource, sourceToolsDisabled = false }: SourceListProps) {
  const [filter, setFilter] = useState<(typeof filters)[number]['value']>('all')
  const [search, setSearch] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const detailsId = useId()
  const query = search.trim().toLocaleLowerCase()
  const visibleSources = sources.filter((source) => (
    (filter === 'all' || source.status === filter)
    && (!query || source.label.toLocaleLowerCase().includes(query) || source.url.toLocaleLowerCase().includes(query))
  ))

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-1" role="group" aria-label="Filter connectors">
          {filters.map(({ value, label }) => (
            <Button
              key={value}
              type="button"
              variant={filter === value ? 'secondary' : 'ghost'}
              className="pressable"
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
            >
              {label}
            </Button>
          ))}
        </div>
        <label className="flex w-full items-center gap-2 rounded-lg bg-kumo-tint/55 px-3 sm:w-56">
          <MagnifyingGlass aria-hidden="true" size={16} className="shrink-0 text-kumo-subtle" />
          <input
            type="search"
            aria-label="Search connectors"
            placeholder="Search connectors"
            className="min-h-10 min-w-0 w-full rounded-sm bg-transparent text-base text-kumo-default placeholder:text-kumo-subtle sm:min-h-9 sm:text-sm"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
      </div>

      <table className="w-full table-fixed border-collapse text-left text-sm" aria-label="Connector list">
        <thead className="text-kumo-subtle">
          <tr className="border-b border-kumo-line">
            <th scope="col" className="w-[55%] px-3 py-3 font-normal sm:w-[45%]">Connector</th>
            <th scope="col" className="hidden w-[25%] px-3 py-3 font-normal sm:table-cell">Connection</th>
            <th scope="col" className="px-3 py-3 font-normal">Status</th>
          </tr>
        </thead>
        <tbody>
          {visibleSources.map((source) => {
            const installation = installationDetails?.(source.id)
            const isExpanded = expanded === source.id || pendingRemovalSourceId === source.id
            const sourceDetailsId = `${detailsId}-${source.id}`
            const connection = source.authMode === 'oauth'
              ? source.onBehalfOfUser ? source.id === 'source-616e6b6b616d6370' ? 'Your own sign-in' : 'Legacy user-bound OAuth' : 'Operator-connected OAuth'
              : 'Public'

            return (
              <Fragment key={source.id}>
                <tr className={`border-b border-kumo-line/70 hover:bg-kumo-tint/40 ${isExpanded ? 'bg-kumo-tint/40' : ''}`}>
                  <th scope="row" className="px-3 py-2 text-left font-medium">
                    <DisclosureTrigger
                      className="min-h-12"
                      aria-expanded={isExpanded}
                      aria-controls={isExpanded ? sourceDetailsId : undefined}
                      onClick={() => setExpanded(isExpanded ? null : source.id)}
                    >
                      <SourceIcon key={`${source.id}:${source.url}`} source={source} />
                      <span className="min-w-0 flex-1 break-words">{source.label}</span>
                    </DisclosureTrigger>
                  </th>
                  <td className="hidden px-3 py-3 text-kumo-subtle sm:table-cell">
                    {source.authMode === 'oauth' ? source.onBehalfOfUser ? source.id === 'source-616e6b6b616d6370' ? 'OAuth' : 'Legacy OAuth' : 'OAuth' : 'Public'}
                  </td>
                  <td className="px-3 py-3">
                    {pendingRemovalSourceId === source.id ? <span className="text-warning-strong">Removal started</span> : source.status === 'installed' ? (
                      <span className="inline-flex items-center gap-2 text-success-strong"><Check aria-hidden="true" size={17} className="shrink-0" />Installed</span>
                    ) : (
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="inline-flex items-center gap-1.5 text-warning-strong"><Clock aria-hidden="true" size={16} />{draftLabel?.(source.id) ?? 'Draft'}</span>
                        <Button
                          type="button"
                          variant="secondary"
                          className="pressable h-auto min-h-9 max-w-full whitespace-normal py-1.5"
                          disabled={!installationEnabled || authorizeDisabled}
                          loading={isBusy}
                          aria-describedby={installationEnabled && installNote ? `${sourceDetailsId}-install-note` : undefined}
                          onClick={() => onAuthorize(source.id)}
                        >
                          {installationEnabled ? 'Install connector' : 'Installation unavailable'}
                        </Button>
                        {installationEnabled && installNote ? (
                          <p id={`${sourceDetailsId}-install-note`} className="basis-full text-xs leading-5 text-kumo-subtle">{installNote}</p>
                        ) : null}
                      </div>
                    )}
                  </td>
                </tr>
                {installation ? (
                  <tr className="border-b border-kumo-line/70">
                    <td colSpan={3} className="px-5 py-4 sm:pl-14">{installation}</td>
                  </tr>
                ) : null}
                {isExpanded ? (
                  <tr id={sourceDetailsId} className="border-b border-kumo-line/70 bg-kumo-tint/40">
                    <td colSpan={3} className="px-5 py-5 sm:pl-14">
                      <p className="text-xs text-kumo-subtle">{connection}</p>
                      <code className="mt-2 block select-all break-all text-xs text-kumo-default">{source.url}</code>
                      <p className="mt-4 text-xs font-medium text-kumo-subtle">{source.enabledTools.length === 0
                        // Only a sign-in source can be saved without tools: its real list exists once it is connected.
                        ? 'No tools chosen yet. Nothing is enabled; you choose from the connector’s real list after connecting it.'
                        : `${source.enabledTools.length} exact tool${source.enabledTools.length === 1 ? '' : 's'}`}</p>
                      <div className="mt-2 flex max-h-52 flex-wrap gap-2 overflow-y-auto pr-1" role="region" aria-label={`${source.label} allowed tools`} tabIndex={0}>
                        {source.enabledTools.map((tool) => <code key={tool} className="tool-chip break-all">{tool}</code>)}
                      </div>
                      {source.status === 'draft' && canRemove?.(source.id) && onRemoveDraft ? (
                        <Button variant="secondary-destructive" className="pressable mt-4" disabled={isBusy || removeDisabled}
                          onClick={() => onRemoveDraft(source.id)}>Remove connector</Button>
                      ) : null}
                      {source.status === 'installed' && onRenameSource ? (
                        <InstalledSourceName source={source} disabled={isBusy || sourceToolsDisabled} onRename={onRenameSource} />
                      ) : null}
                      {source.status === 'installed' && onLoadSourceTools && onSaveSourceTools ? (
                        <InstalledSourceToolsEditor
                          source={source}
                          disabled={isBusy || sourceToolsDisabled}
                          onLoad={onLoadSourceTools}
                          onSave={onSaveSourceTools}
                        />
                      ) : null}
                      {source.status === 'installed' && removalEnabled && onRemove && onRefresh ? <SourceRemoval
                        source={source}
                        pending={pendingRemovalSourceId === source.id}
                        disabled={isBusy || Boolean(removalDisabled) || (pendingRemovalSourceId !== undefined && pendingRemovalSourceId !== source.id)}
                        credentialConfigured={removalCredentialConfigured === true}
                        managedBigQuery={managedBigQuerySourceIds.includes(source.id)}
                        rollbackNote={removalNote}
                        onRemove={onRemove}
                        onRefresh={onRefresh}
                      /> : null}
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            )
          })}
          {visibleSources.length === 0 ? (
            <tr><td colSpan={3} className="px-3 py-10 text-center text-kumo-subtle">{query ? 'No matching connectors.' : filter === 'installed' ? 'No installed connectors.' : filter === 'draft' ? 'No drafts.' : 'No connectors yet.'}</td></tr>
          ) : null}
        </tbody>
      </table>
    </div>
  )
}
