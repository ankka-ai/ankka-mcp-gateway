import { useEffect, useRef, useState } from 'react'
import { BrandMark } from '../../src/components/BrandMark'
import { createLogoRenderer, type LogoRenderer, type LogoVariant } from './logo-renderer'

type Props = { variant: LogoVariant; paused: boolean; replay: number; compact?: boolean }

export function AnkkaLogoMotion({ variant, paused, replay, compact = false }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const artwork = useRef<HTMLSpanElement>(null)
  const renderer = useRef<LogoRenderer | null>(null)
  const [error, setError] = useState('')
  const initialPause = useRef(paused)
  const previousReplay = useRef(replay)
  useEffect(() => {
    const path = artwork.current?.querySelector('path')?.getAttribute('d')
    if (!canvas.current || !path) return
    try { renderer.current = createLogoRenderer(canvas.current, path, variant, initialPause.current) }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'The logo preview could not start.') }
    return () => { renderer.current?.destroy(); renderer.current = null }
  }, [variant])
  useEffect(() => { renderer.current?.setPaused(paused) }, [paused, variant])
  useEffect(() => {
    if (replay !== previousReplay.current) renderer.current?.replay()
    previousReplay.current = replay
  }, [replay])
  return <div className={`logo-motion${compact ? ' logo-motion--compact' : ''}`}>
    <span hidden ref={artwork}><BrandMark /></span>
    <canvas ref={canvas} role="img" aria-label={`Ankka wordmark: ${variant === 'relief' ? 'scanline relief' : variant === 'echoes' ? 'depth echoes' : 'signal assembly'} animation`}
      onPointerMove={event => {
        if (compact || event.pointerType === 'touch') return
        const bounds = event.currentTarget.getBoundingClientRect()
        renderer.current?.setPointer((event.clientX - bounds.left) / bounds.width * 2 - 1, (event.clientY - bounds.top) / bounds.height * 2 - 1)
      }}
      onPointerLeave={() => renderer.current?.setPointer(0, 0)}
    >The original Ankka wordmark with a subtle animated depth effect.</canvas>
    {error ? <p className="motion-error" role="alert">{error}</p> : null}
  </div>
}
