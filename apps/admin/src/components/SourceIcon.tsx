import { useState } from 'react'
import type { ManagedSource } from '../api'
import ankkaIcon from '../assets/ankka-icon.svg'
import metaIcon from '../assets/connectors/meta.svg'
import ahrefsIcon from '../assets/connectors/ahrefs.svg'

/** Icons bundled for providers whose own icon cannot be fetched, by the key the connect page receives. */
export const BUNDLED_CONNECTOR_ICONS = {
  ankka: ankkaIcon,
  meta: metaIcon,
  ahrefs: ahrefsIcon,
} as const
export type BundledConnectorIcon = keyof typeof BUNDLED_CONNECTOR_ICONS

const bundledIcons = new Map([
  ['https://mcp.facebook.com/ads', metaIcon],
  ['https://api.ahrefs.com/mcp/mcp', ahrefsIcon],
])

/** A connector's icon, or its first letter until the icon loads or when it cannot. */
export function ConnectorIcon({ label, src, tone = 'dark', className = 'size-8' }: {
  label: string
  src: string
  tone?: 'dark' | 'light'
  className?: string
}) {
  const [loaded, setLoaded] = useState(false)
  const [failed, setFailed] = useState(false)
  const toneClass = tone === 'light'
    ? 'border-black/10 bg-white text-neutral-500'
    : 'border-kumo-line bg-kumo-overlay text-kumo-subtle'
  return (
    <span aria-hidden="true" className={`relative flex shrink-0 items-center justify-center overflow-hidden rounded-lg border text-xs font-semibold ${toneClass} ${className}`}>
      {!loaded || failed ? label.slice(0, 1).toLocaleUpperCase() : null}
      {!failed ? <img src={src} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer"
        onLoad={() => setLoaded(true)} onError={() => setFailed(true)}
        className={`absolute inset-0 size-full object-contain p-1 ${loaded ? '' : 'opacity-0'}`} /> : null}
    </span>
  )
}

export function SourceIcon({ source }: { source: ManagedSource }) {
  const url = source.id === 'source-616e6b6b616d6370'
    ? ankkaIcon : bundledIcons.get(source.url) ?? `/api/sources/${encodeURIComponent(source.id)}/icon`
  return <ConnectorIcon label={source.label} src={url} />
}
