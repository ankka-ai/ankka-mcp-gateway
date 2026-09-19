import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { AnkkaLogoMotion } from './AnkkaLogoMotion'
import type { LogoVariant } from './logo-renderer'
import './style.css'

const studies = [
  { id: 'relief', number: '01', title: 'Scanline relief', description: 'A slow wave lifts fine slices out of the wordmark, then lets them settle.', detail: 'Thin slices · Shallow depth · Slow wave' },
  { id: 'echoes', number: '02', title: 'Depth echoes', description: 'Faint outlines separate behind the letters and quietly merge back into one.', detail: 'Layered outlines · Gentle parallax · Clean foreground' },
  { id: 'assembly', number: '03', title: 'Signal assembly', description: 'Scattered fragments align into ANKKA, hold, and dissolve from the bottom.', detail: 'Gather · Align · Hold · Dissolve' },
] as const satisfies readonly { id: LogoVariant; number: string; title: string; description: string; detail: string }[]

function Preview() {
  const [selected, setSelected] = useState<LogoVariant>('relief')
  const [paused, setPaused] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches)
  const [replay, setReplay] = useState(0)
  const study = studies.find(item => item.id === selected) ?? studies[0]
  useEffect(() => {
    const motion = matchMedia('(prefers-reduced-motion: reduce)')
    const changed = () => { if (motion.matches) setPaused(true) }
    motion.addEventListener('change', changed)
    return () => motion.removeEventListener('change', changed)
  }, [])
  return <main>
    <header className="page-header">
      <div><p className="eyebrow">ANKKA / MOTION STUDIES</p><h1>A little depth. The same signal.</h1></div>
      <div className="playback">
        <button type="button" onClick={() => { setReplay(value => value + 1); setPaused(false) }}>Replay all</button>
        <button type="button" aria-pressed={paused} onClick={() => setPaused(value => !value)}>{paused ? 'Play motion' : 'Pause motion'}</button>
      </div>
    </header>
    <section className="focus-study" aria-label={`${study.title} large preview`}>
      <div className="focus-label"><span>{study.number} / {study.title}</span><span className="status"><i className={paused ? '' : 'is-playing'} />{paused ? 'Paused' : 'Live canvas'}</span></div>
      <AnkkaLogoMotion key={selected} variant={selected} paused={paused} replay={replay} />
      <div className="focus-footer"><span>{study.detail}</span><span>Move your pointer to explore depth</span></div>
    </section>
    <div className="comparison-label"><h2>Three directions</h2><p>Select a study to see it larger.</p></div>
    <div className="studies">
      {studies.map(item => <button type="button" className={`study-card${selected === item.id ? ' is-selected' : ''}`} key={item.id}
        aria-pressed={selected === item.id} aria-label={`Explore ${item.title}`} onClick={() => setSelected(item.id)}>
        <div className="card-label"><span>{item.number}</span><span>{selected === item.id ? 'Viewing' : 'Explore ↗'}</span></div>
        <AnkkaLogoMotion variant={item.id} paused={paused} replay={replay} compact />
        <div className="card-copy"><h3>{item.title}</h3><p>{item.description}</p></div>
      </button>)}
    </div>
    <footer className="page-footer"><span>Original letterforms. Monochrome. A shared rhythm.</span><span>16 second cycles</span></footer>
  </main>
}

if (!import.meta.env.DEV) throw new Error('These motion studies are only available in development.')
const root = document.getElementById('root')
if (!root) throw new Error('The preview container is missing.')
createRoot(root).render(<Preview />)
