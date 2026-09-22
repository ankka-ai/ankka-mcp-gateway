import { useState } from 'react'
import type { ManagedSource } from '../api'
import ankkaIcon from '../assets/ankka-icon.svg'

export function SourceIcon({ source }: { source: ManagedSource }) {
  const [loaded, setLoaded] = useState(false)
  const [failed, setFailed] = useState(false)
  const url = source.id === 'source-616e6b6b616d6370'
    ? ankkaIcon : `/api/sources/${encodeURIComponent(source.id)}/icon`
  return (
    <span aria-hidden="true" className="relative flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-kumo-line bg-kumo-overlay text-xs font-semibold text-kumo-subtle">
      {!loaded || failed ? source.label.slice(0, 1).toLocaleUpperCase() : null}
      {!failed ? <img src={url} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer"
        onLoad={() => setLoaded(true)} onError={() => setFailed(true)}
        className={`absolute inset-0 size-full object-contain p-1 ${loaded ? '' : 'opacity-0'}`} /> : null}
    </span>
  )
}
