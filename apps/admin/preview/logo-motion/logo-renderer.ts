export type LogoVariant = 'relief' | 'echoes' | 'assembly'
type Clip = { x: number; y: number; width: number; height: number }
type Layer = { x?: number; y?: number; z?: number; alpha?: number; outline?: boolean; clip?: Clip }

export interface LogoRenderer {
  setPaused(value: boolean): void
  replay(): void
  setPointer(x: number, y: number): void
  destroy(): void
}

const duration = 16
const glyphs = [
  { x: 0, width: 11.6053 },
  { x: 40.9103, width: 11.6053 },
  { x: 81.8206, width: 11.2607 },
  { x: 122.157, width: 11.26 },
  { x: 162.492, width: 11.6053 },
]
const smooth = (value: number) => {
  const t = Math.max(0, Math.min(1, value))
  return t * t * (3 - 2 * t)
}
const noise = (seed: number) => {
  const value = Math.sin(seed * 127.1 + 311.7) * 43758.5453
  return value - Math.floor(value)
}

export function createLogoRenderer(canvas: HTMLCanvasElement, artwork: string, variant: LogoVariant, pausedInitially: boolean): LogoRenderer {
  const candidate = canvas.getContext('2d')
  if (!candidate) throw new Error('Your browser could not start this canvas preview.')
  const ctx = candidate
  const logo = new Path2D(artwork)
  let width = 1
  let height = 1
  let density = 1
  let elapsed = pausedInitially ? 6 : 0
  let paused = pausedInitially
  let frame = 0
  let last = 0
  let disposed = false
  let pointerX = 0
  let pointerY = 0
  let targetX = 0
  let targetY = 0

  function layer({ x = 0, y = 0, z = 0, alpha = 1, outline = false, clip }: Layer = {}) {
    if (alpha < .001) return
    const yaw = -.13 + pointerX * .2
    const pitch = .24 + pointerY * .16
    const scale = width * .77 / 175 * (1 + z / 300)
    const cy = Math.cos(yaw), sy = Math.sin(yaw)
    const cp = Math.cos(pitch), sp = Math.sin(pitch)
    ctx.save()
    ctx.translate(width / 2 + (x + sy * z) * scale, height * .47 + (y - sp * cy * z) * scale)
    ctx.transform(cy * scale, sp * sy * scale, 0, cp * scale, 0, 0)
    ctx.translate(-87.5, -9.5)
    if (clip) {
      ctx.beginPath()
      ctx.rect(clip.x, clip.y, clip.width, clip.height)
      ctx.clip()
    }
    const ink = ctx.createLinearGradient(0, 0, 0, 19)
    ink.addColorStop(0, '#ededed')
    ink.addColorStop(.28, '#ededed')
    ink.addColorStop(1, '#ededed00')
    ctx.globalAlpha = alpha
    if (outline) {
      ctx.strokeStyle = ink
      ctx.lineWidth = .15
      ctx.stroke(logo)
    } else {
      ctx.fillStyle = ink
      ctx.fill(logo)
    }
    ctx.restore()
  }

  function background(time: number) {
    // Sparse, persistent fragments share the hosted background's slow drift.
    const scale = Math.min(width / 600, 1.3)
    for (let i = 0; i < 100; i += 1) {
      const u = noise(i + 10), v = noise(i + 91)
      const ridge = .78 - u * .42 + Math.sin(u * 7) * .1
      if (Math.abs(v - ridge) > .085) continue
      const band = Math.floor(v * 12)
      const displacement = Math.sin(time * .35 + band) * 5 * scale
      const x = u * width + displacement
      const y = v * height
      ctx.fillStyle = `rgba(214,214,214,${.07 + noise(i + 40) * .09})`
      ctx.fillRect(x, y, (i % 9 === 0 ? 7 : 1.5) * scale, scale)
    }
  }

  function relief(time: number) {
    for (let row = 0; row < 18; row += 1) {
      const travel = (time - 1.6 - row * .12) / 1.15
      const lift = Math.exp(-travel * travel) + Math.exp(-Math.pow((time - 10 - row * .12) / 1.15, 2))
      const clip = { x: -1, y: row * 19 / 18, width: 177, height: 19 / 18 + .012 }
      if (lift > .025) layer({ x: lift * 1.4, y: lift * 1.6, z: lift * 9, alpha: lift * .24, outline: true, clip })
      layer({ x: lift * 2.4, z: lift * 22, clip })
    }
  }

  function echoes(time: number) {
    const spread = smooth((time - .6) / 3) * (1 - smooth((time - 8.5) / 4))
    const interaction = Math.min(1, Math.hypot(pointerX, pointerY)) * .5
    const amount = Math.max(spread, interaction)
    for (let copy = 3; copy >= 1; copy -= 1) {
      layer({
        x: -copy * 1.9 * amount,
        y: copy * 1.35 * amount,
        z: -copy * 8 * amount,
        alpha: amount * (.36 - copy * .065),
        outline: true,
      })
    }
    layer()
  }

  function assembly(time: number) {
    glyphs.forEach((glyph, letter) => {
      for (let strip = 0; strip < 4; strip += 1) {
        const seed = letter * 4 + strip
        const arrival = smooth((time - .1 - letter * .24 - strip * .17) / 2.8)
        const departure = smooth((time - 11.8 - (3 - strip) * .48 - letter * .12) / 2.4)
        const distance = 1 - arrival + departure
        const x = (noise(seed + 30) - .5) * 32 * distance
        const y = (noise(seed + 91) - .5) * 42 * distance
        const z = (noise(seed + 62) - .5) * 90 * distance
        layer({
          x, y, z,
          alpha: Math.max(0, 1 - distance * .95),
          clip: { x: glyph.x - .1, y: strip * 19 / 4, width: glyph.width + .2, height: 19 / 4 + .012 },
        })
      }
    })
    const signal = (1 - smooth((time - 1.2) / 3)) + smooth((time - 12) / 3)
    if (signal < .01) return
    const scale = width * .77 / 175
    for (let i = 0; i < 22; i += 1) {
      const x = width * (.13 + noise(i + 28) * .74)
      const y = height * .47 + (noise(i + 77) - .5) * 52 * scale * signal
      ctx.fillStyle = `rgba(222,222,222,${signal * .25})`
      ctx.fillRect(x, y, (i % 4 === 0 ? 2.6 : .55) * scale, Math.max(.65, scale * .16))
    }
  }

  function draw() {
    ctx.setTransform(density, 0, 0, density, 0, 0)
    ctx.clearRect(0, 0, width, height)
    const time = elapsed % duration
    background(elapsed)
    if (variant === 'relief') relief(time)
    else if (variant === 'echoes') echoes(time)
    else assembly(time)
  }

  function requestDraw() {
    if (!frame && !disposed && !document.hidden) frame = requestAnimationFrame(tick)
  }

  function tick(now: number) {
    frame = 0
    if (disposed || document.hidden) return
    const delta = last ? Math.min((now - last) / 1000, .05) : 0
    last = now
    if (!paused) {
      elapsed += delta
      const follow = 1 - Math.exp(-delta * 9)
      pointerX += (targetX - pointerX) * follow
      pointerY += (targetY - pointerY) * follow
    }
    draw()
    if (!paused) requestDraw()
  }

  function resize() {
    const bounds = canvas.getBoundingClientRect()
    width = Math.max(1, bounds.width)
    height = Math.max(1, bounds.height)
    density = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = Math.round(width * density)
    canvas.height = Math.round(height * density)
    requestDraw()
  }

  function visibilityChanged() {
    cancelAnimationFrame(frame)
    frame = 0
    last = 0
    requestDraw()
  }

  const observer = new ResizeObserver(resize)
  observer.observe(canvas)
  document.addEventListener('visibilitychange', visibilityChanged)
  resize()
  return {
    setPaused(value) { paused = value; last = 0; requestDraw() },
    replay() { elapsed = 0; pointerX = 0; pointerY = 0; last = 0; requestDraw() },
    setPointer(x, y) { targetX = x; targetY = y },
    destroy() {
      disposed = true
      cancelAnimationFrame(frame)
      observer.disconnect()
      document.removeEventListener('visibilitychange', visibilityChanged)
    },
  }
}
