import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { BrandMark } from '../src/components/BrandMark'
import { catalog } from './catalog'
import './gallery.css'

const groups = [...new Set(catalog.map(entry => entry.group))]
const widths = [{ value: 1280, label: 'Desktop' }, { value: 768, label: 'Tablet' }, { value: 390, label: 'Mobile' }]

function Gallery() {
  const [selected, setSelected] = useState(() => location.hash.slice(1) || 'setup')
  const [query, setQuery] = useState('')
  const [width, setWidth] = useState(1280)
  const [availableWidth, setAvailableWidth] = useState(1280)
  const stage = useRef<HTMLDivElement>(null)
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    const update = () => setSelected(location.hash.slice(1) || 'setup')
    addEventListener('hashchange', update)
    return () => removeEventListener('hashchange', update)
  }, [])
  useEffect(() => {
    if (!stage.current) return
    const observer = new ResizeObserver(entries => {
      const size = entries[0]?.contentRect.width
      if (size) setAvailableWidth(size)
    })
    observer.observe(stage.current)
    return () => observer.disconnect()
  }, [])
  const scale = Math.min(1, availableWidth / width)
  const active = catalog.find(entry => entry.id === selected) ?? catalog.find(entry => entry.id === 'setup')
  if (!active) return <p>No preview is available.</p>
  const visible = catalog.filter(entry => `${entry.group} ${entry.label} ${entry.description}`.toLowerCase().includes(query.toLowerCase()))
  return (
    <div className="gallery">
      <a className="gallery-skip" href="#preview" onClick={event => { event.preventDefault(); document.getElementById('preview')?.focus() }}>Skip to preview</a>
      <aside className="gallery-sidebar">
        <header className="gallery-brand">
          <div role="img" aria-label="Ankka"><BrandMark /></div>
          <div className="gallery-title"><h1>UI library</h1><span>{catalog.length} views</span></div>
          <p>Current interfaces & components</p>
        </header>
        <label className="gallery-search"><span className="gallery-sr-only">Find a screen or component</span><input type="search" placeholder="Find a screen or component…" value={query} onChange={event => setQuery(event.target.value)} /></label>
        <nav aria-label="Interface catalogue">
          {groups.map(group => {
            const entries = visible.filter(entry => entry.group === group)
            return entries.length ? <section key={group}><h2>{group}<span>{entries.length}</span></h2>{entries.map(entry => <a key={entry.id} href={`#${entry.id}`} aria-current={active.id === entry.id ? 'page' : undefined}>{entry.label}</a>)}</section> : null
          })}
          {!visible.length ? <p className="gallery-empty">No matching views. Try “update” or “buttons”.</p> : null}
        </nav>
        <footer>Local preview · Synthetic data<br />Changes here do not deploy anything.</footer>
      </aside>
      <main className="gallery-workspace" id="preview" tabIndex={-1}>
        <header className="gallery-toolbar">
          <div><p>{active.group}</p><h2>{active.label}</h2></div>
          <div className="gallery-tools">
            <div className="gallery-sizes" role="group" aria-label="Preview width">
              {widths.map(({ value, label }) => <button key={value} type="button" title={`${value}px viewport`} aria-pressed={width === value} onClick={() => setWidth(value)}>{label}</button>)}
            </div>
            <button type="button" onClick={() => setRevision(value => value + 1)}>Reset view</button>
            <a href={active.url} target="_blank" rel="noreferrer">Open screen ↗</a>
          </div>
        </header>
        <div className="gallery-description"><p>{active.description}</p><details><summary>Source</summary><code>{active.source}</code></details></div>
        <div className="gallery-stage" ref={stage}>
          <div className="gallery-frame" style={{ width: width * scale }}>
            <iframe key={`${active.id}-${revision}`} title={`${active.label} preview`} src={active.url} style={{ width, height: `${100 / scale}%`, transform: `scale(${scale})` }} allow="clipboard-write" sandbox="allow-scripts allow-same-origin allow-forms allow-popups" />
          </div>
        </div>
      </main>
    </div>
  )
}

const root = document.getElementById('root')
if (root) createRoot(root).render(import.meta.env.DEV && import.meta.env.VITE_GATEWAY_UI_PREVIEW === '1'
  ? <Gallery /> : <p>Start the local library with <code>npm run dev:ui</code>.</p>)
