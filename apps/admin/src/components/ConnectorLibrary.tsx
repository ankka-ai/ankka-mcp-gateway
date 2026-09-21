import { Dialog } from '@cloudflare/kumo/primitives/dialog'
import { ArrowRight, GlobeSimple, MagnifyingGlass, Plus, X } from '@phosphor-icons/react'
import { type RefObject, useRef, useState } from 'react'
import bigQueryIcon from '../assets/google-bigquery.svg'
import type { SourceCatalog, SourceCatalogSource } from '../catalog'
import { NATIVE_CONNECTOR_RECIPES, NATIVE_RECIPE_STATUS_LABELS, type NativeConnectorRecipe } from '../connectors/native-recipes'
import { Button } from './Button'
import { PROVIDER_ICONS } from '../connectors/icons'

interface ConnectorLibraryProps {
  open: boolean
  onOpenChange(open: boolean): void
  catalog: SourceCatalog
  bigQueryAvailable: boolean
  bigQueryBlocked: boolean
  disabled: boolean
  onBigQuery(): void
  onCatalogSource(source: SourceCatalogSource): void
  onProvider(recipe: NativeConnectorRecipe): void
  onCustom(): void
  finalFocus?: false | RefObject<HTMLButtonElement | null>
}

export function ConnectorLibrary({ open, onOpenChange, catalog, bigQueryAvailable, bigQueryBlocked, disabled, onBigQuery, onCatalogSource, onProvider, onCustom, finalFocus }: ConnectorLibraryProps) {
  const [query, setQuery] = useState('')
  const search = useRef<HTMLInputElement>(null)
  const matches = (value: string) => value.toLowerCase().includes(query.trim().toLowerCase())
  const showBigQuery = matches('BigQuery Google Cloud SQL data warehouse analytics')
  const entries = catalog.sources.filter(source => matches(`${source.displayName} ${source.description}`))
  const providers = NATIVE_CONNECTOR_RECIPES.filter(recipe => recipe.id !== 'bigquery' &&
    !catalog.sources.some(source => source.displayName === recipe.displayName) &&
    matches(`${recipe.displayName} ${recipe.description}`))
  return <Dialog.Root open={open} onOpenChange={onOpenChange}>
    <Dialog.Portal>
      <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/65" />
      <Dialog.Popup initialFocus={search} finalFocus={finalFocus} className="connector-library fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-3xl -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-kumo-line bg-kumo-overlay text-kumo-default shadow-xl">
        <header className="flex items-start justify-between gap-4 p-5 pb-0 sm:p-8 sm:pb-0">
          <div><Dialog.Title className="text-2xl font-medium tracking-tight text-kumo-strong">Connector library</Dialog.Title>
            <Dialog.Description className="mt-2 text-sm leading-6 text-kumo-subtle">Find your team’s tools and explore their setup options.</Dialog.Description></div>
          <Dialog.Close render={<Button variant="ghost" aria-label="Close connector library" />}><X size={20} /></Dialog.Close>
        </header>
        <div className="px-5 pt-6 sm:px-8">
          <label className="connector-library-search"><MagnifyingGlass size={19} aria-hidden="true" /><input ref={search} type="search" aria-label="Search connectors" placeholder="Search connectors…" value={query} onChange={event => setQuery(event.target.value)} /></label>
        </div>
        <div className="overflow-y-auto p-5 sm:p-8">
          <div className="mb-4 flex items-center gap-2"><h3 className="text-sm font-medium text-kumo-strong">Connectors</h3><span className="text-xs text-kumo-subtle">{Number(showBigQuery) + entries.length + providers.length}</span></div>
          <div className="grid gap-3 sm:grid-cols-2">
            {showBigQuery ? <button type="button" className="connector-library-card" disabled={disabled || !bigQueryAvailable || bigQueryBlocked} onClick={onBigQuery} aria-label="Set up BigQuery">
              <span className="connector-library-icon connector-library-icon-bigquery"><img src={bigQueryIcon} width={28} height={28} alt="" /></span>
              <span className="min-w-0 flex-1"><span className="block text-sm font-medium text-kumo-strong">BigQuery</span><span className="mt-1 block text-sm leading-5 text-kumo-subtle">Query and explore your team’s data with read-only access.</span><span className="mt-3 block text-xs text-kumo-subtle">{!bigQueryAvailable ? 'Unavailable on this gateway' : bigQueryBlocked ? 'Finish the current gateway action first' : 'Google Cloud · Guided setup'}</span></span>
              <Plus size={18} className="shrink-0" aria-hidden="true" />
            </button> : null}
            {entries.map(source => <button key={source.sourceId} type="button" className="connector-library-card" disabled={disabled} onClick={() => onCatalogSource(source)} aria-label={`Select ${source.displayName}`}>
              <span className="connector-library-icon"><GlobeSimple size={25} aria-hidden="true" /></span>
              <span className="min-w-0 flex-1"><span className="block text-sm font-medium text-kumo-strong">{source.displayName}</span><span className="mt-1 block text-sm leading-5 text-kumo-subtle">{source.description}</span><span className="mt-3 block text-xs text-kumo-subtle">{source.implementation.connection.authMode === 'oauth' ? 'Sign-in required' : 'Public endpoint'} · Review tools before adding</span></span>
              <Plus size={18} className="shrink-0" aria-hidden="true" />
            </button>)}
            {providers.map(recipe => <button key={recipe.id} type="button" className="connector-library-card" onClick={() => onProvider(recipe)} aria-label={`View ${recipe.displayName} connector`}>
              <span className="connector-library-icon"><img src={PROVIDER_ICONS[recipe.id]} width={28} height={28} className="object-contain" alt="" /></span>
              <span className="min-w-0 flex-1"><span className="block text-sm font-medium text-kumo-strong">{recipe.displayName}</span><span className="mt-1 block text-sm leading-5 text-kumo-subtle">{recipe.description}</span><span className="mt-3 block text-xs text-kumo-subtle">{NATIVE_RECIPE_STATUS_LABELS[recipe.status]}</span></span>
              <ArrowRight size={18} className="shrink-0" aria-hidden="true" />
            </button>)}
          </div>
          {!showBigQuery && entries.length === 0 && providers.length === 0 ? <div role="status" className="py-10 text-center"><p className="text-sm text-kumo-strong">No connectors found</p><p className="mt-2 text-sm text-kumo-subtle">Try another search or add a custom MCP connector.</p></div> : null}
        </div>
        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-kumo-line px-5 py-4 sm:px-8"><p className="text-sm text-kumo-subtle">Have an MCP server URL?</p><Button variant="ghost" disabled={disabled} onClick={onCustom}>Add custom connector <ArrowRight size={16} aria-hidden="true" /></Button></footer>
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>
}
