import { spawn } from 'node:child_process'

const previews = [
  {
    label: 'Gateway dashboard',
    command: ['run', 'dev', '--workspace', '@ankka/gateway-admin'],
    env: { VITE_GATEWAY_UI_PREVIEW: '1' },
  },
  {
    label: 'Deployment wizard',
    command: ['run', 'dev:ui', '--workspace', '@ankka/gateway-installer'],
    env: {},
  },
]

console.log(`
Ankka MCP Gateway UI studio

UI library — every current screen and component
  Browse      http://127.0.0.1:5730/preview/index.html

Deployment wizard
  Start       http://127.0.0.1:5731/
  Connected   http://127.0.0.1:5731/?preview=connected
  Gateway     http://127.0.0.1:5731/gateway
  Review      http://127.0.0.1:5731/review
  Planned     http://127.0.0.1:5731/review?preview=planned
  Authorize   http://127.0.0.1:5731/deploy
  Deploying   http://127.0.0.1:5731/result?preview=running
  Success     http://127.0.0.1:5731/result?preview=success
  Failure     http://127.0.0.1:5731/result?preview=failed
  Removal     http://127.0.0.1:5731/result?preview=removal

Gateway dashboard
  Overview    http://127.0.0.1:5730/?preview=ready
  Sources     http://127.0.0.1:5730/sources?preview=ready
  Sign-in     http://127.0.0.1:5730/sources?preview=source-sign-in
  Settings    http://127.0.0.1:5730/settings?preview=ready
  Update      http://127.0.0.1:5730/settings?preview=update
  Empty       http://127.0.0.1:5730/?preview=empty
  Error       http://127.0.0.1:5730/?preview=error
  Removal     http://127.0.0.1:5730/settings?preview=removal-interrupted

All previews use synthetic data without Cloudflare requests. Press Ctrl+C to stop.
`)

const children = previews.map(({ label, command, env }) => {
  const child = spawn('npm', command, {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: 'inherit',
  })
  child.on('error', (error) => {
    console.error(`${label} preview could not start: ${error.message}`)
  })
  return { child, label }
})

let stopping = false

function stop(signal = 'SIGTERM') {
  if (stopping) return
  stopping = true
  for (const { child } of children) {
    if (!child.killed) child.kill(signal)
  }
}

process.on('SIGINT', () => stop('SIGINT'))
process.on('SIGTERM', () => stop('SIGTERM'))

const firstExit = await Promise.race(children.map(({ child, label }) => (
  new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, label, signal })))
)))

const requestedStop = stopping
stop()
if (!requestedStop) {
  console.error(`${firstExit.label} preview stopped unexpectedly.`)
}
process.exitCode = requestedStop ? 0 : Number.isInteger(firstExit.code) ? firstExit.code : 1
