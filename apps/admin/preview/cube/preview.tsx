import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { BrandMark } from '../../src/components/BrandMark'
import { AnkkaCube } from './AnkkaCube'
import './style.css'

function Preview() {
  const [paused, setPaused] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches)
  const [glitch, setGlitch] = useState(.25)
  useEffect(() => {
    const motion = matchMedia('(prefers-reduced-motion: reduce)')
    const changed = () => { if (motion.matches) setPaused(true) }
    motion.addEventListener('change', changed)
    return () => motion.removeEventListener('change', changed)
  }, [])
  return <main>
    <header><BrandMark className="cube-wordmark" /><span>FORM STUDY / 03</span></header>
    <AnkkaCube paused={paused} glitch={glitch} onPause={() => setPaused(true)} />
    <footer>
      <div className="cube-caption"><h1>Ankka cube</h1><p>One form. Five letters.</p></div>
      <div className="cube-controls">
        <button type="button" onClick={() => setPaused(value => !value)} aria-pressed={!paused}>{paused ? 'Resume rotation' : 'Pause rotation'}</button>
        <label>Glitch <input type="range" min="0" max="100" value={Math.round(glitch * 100)} onChange={event => setGlitch(Number(event.target.value) / 100)} /></label>
      </div>
      <p className="cube-hint">Drag to turn · Arrow keys also work</p>
    </footer>
  </main>
}

if (!import.meta.env.DEV) throw new Error('This design study is only available in development.')
const root = document.getElementById('root')
if (!root) throw new Error('The preview container is missing.')
createRoot(root).render(<Preview />)
