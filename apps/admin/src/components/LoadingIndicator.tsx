import { matrixLoaderFragments } from '../../../installer/src/matrix-loader'

/** Decorative: the surrounding status text or button supplies the accessible name. */
export function LoadingIndicator({ inline = false }: { inline?: boolean }) {
  return <span className={`ankka-loader${inline ? ' ankka-loader-inline' : ''}`} aria-hidden="true">
    {inline ? null : <svg className="ankka-loader-field" viewBox="0 0 72 48" fill="currentColor" aria-hidden="true" focusable="false">
      {matrixLoaderFragments.map(({ grain, signal }) => <g key={grain}><path opacity=".55" d={grain} /><path d={signal} /></g>)}
    </svg>}
  </span>
}
