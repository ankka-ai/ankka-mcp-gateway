import { useEffect, useRef, useState } from 'react'
import { BrandMark } from '../../src/components/BrandMark'
import { createCubeRenderer, type CubeRenderer } from './cube-renderer'

export function AnkkaCube({ paused, glitch, onPause }: { paused: boolean; glitch: number; onPause: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const artwork = useRef<HTMLSpanElement>(null)
  const renderer = useRef<CubeRenderer | null>(null)
  const drag = useRef<{ id: number; x: number; y: number } | null>(null)
  const [error, setError] = useState('')
  const initiallyPaused = useRef(paused)
  useEffect(() => {
    const path = artwork.current?.querySelector('path')?.getAttribute('d')
    if (!canvas.current || !path) return
    try { renderer.current = createCubeRenderer(canvas.current, path, initiallyPaused.current) }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'The cube could not start.') }
    return () => { renderer.current?.destroy(); renderer.current = null }
  }, [])
  useEffect(() => { renderer.current?.setPaused(paused) }, [paused])
  useEffect(() => { renderer.current?.setGlitch(glitch) }, [glitch])
  return <div className="cube-stage">
    <span hidden ref={artwork}><BrandMark /></span>
    <canvas ref={canvas} tabIndex={0} role="img" aria-label="Interactive Ankka cube. Five faces carry A, N, K, K, A. Drag or use the arrow keys to rotate."
      onPointerDown={event => {
        if (drag.current) return
        onPause()
        drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY }
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={event => {
        const previous = drag.current
        if (!previous || previous.id !== event.pointerId) return
        renderer.current?.turn((event.clientX - previous.x) * .008, (event.clientY - previous.y) * .008)
        drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY }
      }}
      onPointerUp={event => { if (drag.current?.id === event.pointerId) drag.current = null }}
      onPointerCancel={event => { if (drag.current?.id === event.pointerId) drag.current = null }}
      onLostPointerCapture={event => { if (drag.current?.id === event.pointerId) drag.current = null }}
      onKeyDown={event => {
        const key = event.key
        const direction = key === 'ArrowLeft' ? [-.2, 0] as const : key === 'ArrowRight' ? [.2, 0] as const : key === 'ArrowUp' ? [0, -.2] as const : key === 'ArrowDown' ? [0, .2] as const : null
        if (!direction) return
        event.preventDefault()
        onPause()
        renderer.current?.turn(direction[0], direction[1])
      }}
    >A simple rotating cube drawn with flat faces and the original Ankka letters on five sides.</canvas>
    {error ? <p className="cube-error" role="alert">{error}</p> : null}
  </div>
}
