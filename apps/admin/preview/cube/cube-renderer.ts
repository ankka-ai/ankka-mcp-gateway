type Vector = readonly [number, number, number]
type Point = { x: number; y: number }
type Face = { normal: Vector; across: Vector; up: Vector; letter: number | null; fill: string }

const faces: readonly Face[] = [
  { normal: [0, 0, 1], across: [1, 0, 0], up: [0, 1, 0], letter: 0, fill: '#202020' },
  { normal: [1, 0, 0], across: [0, 0, -1], up: [0, 1, 0], letter: 40.9103, fill: '#191919' },
  { normal: [0, 0, -1], across: [-1, 0, 0], up: [0, 1, 0], letter: 81.8206, fill: '#202020' },
  { normal: [-1, 0, 0], across: [0, 0, 1], up: [0, 1, 0], letter: 162.492, fill: '#191919' },
  { normal: [0, 1, 0], across: [1, 0, 0], up: [0, 0, -1], letter: 122.157, fill: '#292929' },
  { normal: [0, -1, 0], across: [1, 0, 0], up: [0, 0, 1], letter: null, fill: '#292929' },
]

export interface CubeRenderer {
  setPaused(value: boolean): void
  setGlitch(value: number): void
  turn(horizontal: number, vertical: number): void
  destroy(): void
}

export function createCubeRenderer(canvas: HTMLCanvasElement, path: string, pausedInitially: boolean): CubeRenderer {
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Your browser could not start the canvas preview.')
  const ctx = context
  const letters = new Path2D(path)
  let width = 1
  let height = 1
  let ratio = 1
  let yaw = -.68
  let pitch = .48
  let elapsed = 0
  let glitch = .25
  let paused = pausedInitially
  let frame = 0
  let last = 0
  let destroyed = false

  function rotate([x, y, z]: Vector): Vector {
    const turnedX = Math.cos(yaw) * x + Math.sin(yaw) * z
    const turnedZ = -Math.sin(yaw) * x + Math.cos(yaw) * z
    return [turnedX, Math.cos(pitch) * y - Math.sin(pitch) * turnedZ, Math.sin(pitch) * y + Math.cos(pitch) * turnedZ]
  }

  function project(position: Vector): Point {
    const [x, y] = rotate(position)
    const scale = Math.min(width, height) * .24
    return { x: width / 2 + x * scale, y: height / 2 - y * scale }
  }

  function corner(face: Face, across: number, up: number): Point {
    return project([
      face.normal[0] + across * face.across[0] + up * face.up[0],
      face.normal[1] + across * face.across[1] + up * face.up[1],
      face.normal[2] + across * face.across[2] + up * face.up[2],
    ])
  }

  function drawFace(face: Face) {
    const topLeft = corner(face, -1, 1)
    const topRight = corner(face, 1, 1)
    const bottomRight = corner(face, 1, -1)
    const bottomLeft = corner(face, -1, -1)
    ctx.beginPath()
    ctx.moveTo(topLeft.x, topLeft.y)
    ctx.lineTo(topRight.x, topRight.y)
    ctx.lineTo(bottomRight.x, bottomRight.y)
    ctx.lineTo(bottomLeft.x, bottomLeft.y)
    ctx.closePath()
    ctx.fillStyle = face.fill
    ctx.fill()
    ctx.strokeStyle = '#707070'
    ctx.lineWidth = 1
    ctx.lineJoin = 'round'
    ctx.stroke()
    if (face.letter === null) return

    ctx.save()
    // Orthographic faces are parallelograms, so one affine transform keeps
    // the original vector letter crisp at every angle and display density.
    ctx.transform(
      (topRight.x - topLeft.x) / 2, (topRight.y - topLeft.y) / 2,
      (bottomLeft.x - topLeft.x) / 2, (bottomLeft.y - topLeft.y) / 2,
      topLeft.x, topLeft.y,
    )
    const letterScale = .063
    ctx.translate((2 - 11.6053 * letterScale) / 2, (2 - 18.2697 * letterScale) / 2)
    ctx.scale(letterScale, letterScale)
    ctx.translate(-face.letter, 0)
    ctx.beginPath()
    ctx.rect(face.letter, 0, 12, 19)
    ctx.clip()
    const ink = ctx.createLinearGradient(0, 0, 0, 19)
    ink.addColorStop(0, '#ededed')
    ink.addColorStop(.45, '#ededed')
    ink.addColorStop(1, '#ededed00')
    ctx.fillStyle = ink
    ctx.fill(letters)
    ctx.restore()
  }

  function draw() {
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
    ctx.clearRect(0, 0, width, height)
    const visible = faces.map(face => ({ face, depth: rotate(face.normal)[2] }))
      .filter(({ depth }) => depth > .001)
      .sort((a, b) => a.depth - b.depth)
    for (const { face } of visible) drawFace(face)

    // A single brief displaced slice echoes the installer glitch treatment.
    const phase = elapsed % 6.8
    if (glitch > 0 && phase > 5.9 && phase < 6.08) {
      const sliceY = height / 2 + Math.min(width, height) * .14
      const sliceHeight = 1 + glitch * 3
      ctx.clearRect(0, sliceY, width, sliceHeight)
      ctx.save()
      ctx.beginPath()
      ctx.rect(0, sliceY, width, sliceHeight)
      ctx.clip()
      ctx.translate(3 + glitch * 10, 0)
      for (const { face } of visible) drawFace(face)
      ctx.restore()
    }
  }

  function requestDraw() {
    if (!frame && !destroyed && !document.hidden) frame = requestAnimationFrame(tick)
  }

  function tick(now: number) {
    frame = 0
    if (destroyed || document.hidden) return
    if (!paused) {
      const delta = last ? Math.min((now - last) / 1000, .05) : 0
      elapsed += delta
      yaw -= delta * .16
    }
    last = now
    draw()
    if (!paused) requestDraw()
  }

  function resize() {
    const bounds = canvas.getBoundingClientRect()
    width = Math.max(1, bounds.width)
    height = Math.max(1, bounds.height)
    ratio = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = Math.round(width * ratio)
    canvas.height = Math.round(height * ratio)
    requestDraw()
  }

  function visibilityChanged() {
    if (frame) cancelAnimationFrame(frame)
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
    setGlitch(value) { glitch = Math.min(1, Math.max(0, value)); requestDraw() },
    turn(horizontal, vertical) { yaw += horizontal; pitch += vertical; requestDraw() },
    destroy() {
      destroyed = true
      cancelAnimationFrame(frame)
      observer.disconnect()
      document.removeEventListener('visibilitychange', visibilityChanged)
    },
  }
}
