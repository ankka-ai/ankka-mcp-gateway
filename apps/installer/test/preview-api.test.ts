import { createServer } from 'node:http'
import * as v from 'valibot'
import { installerPreviewApi } from '../preview/mock-api'

async function preview() {
  const middleware = installerPreviewApi()
  const server = createServer((request, response) => {
    middleware(request, response, () => {
      response.statusCode = 204
      response.end()
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = v.parse(v.object({ port: v.number() }), server.address())
  const origin = `http://127.0.0.1:${port}`
  return {
    request: (path: string, method = 'GET', referer = '/') => fetch(`${origin}${path}`, {
      method,
      headers: { referer: `${origin}${referer}` },
      redirect: 'error',
    }),
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
      server.closeAllConnections()
    }),
  }
}

describe('synthetic installer preview session', () => {
  it.each([
    ['/review', 'draft'],
    ['/deploy', 'authorizing'],
    ['/result', 'provisioned'],
    ['/result?preview=success', 'handed_off'],
    ['/result?preview=failed', 'failed'],
    ['/result?preview=removal', 'cleanup_required'],
  ])('provides the current installer session contract for %s', async (path, phase) => {
    const api = await preview()
    try {
      const fixture = await (await api.request('/api/session', 'GET', path)).json()
      expect(fixture).toMatchObject({
        schemaVersion: 1,
        csrfToken: 'local-preview-csrf',
        now: expect.any(Number),
        session: {
          schemaVersion: 1,
          phase,
          plan: { releaseId: 'gateway-v0.1.12', expiresAt: expect.any(Number) },
        },
      })
      const times = v.parse(v.object({
        now: v.number(),
        session: v.object({ expiresAt: v.number(), plan: v.object({ expiresAt: v.number() }) }),
      }), fixture)
      expect(times.session.expiresAt).toBeGreaterThan(times.now)
      expect(times.session.plan.expiresAt).toBeGreaterThan(times.now)
      expect(fixture).not.toHaveProperty('authorizationUrl')
      expect(fixture).not.toHaveProperty('handoffUrl')
      if (phase === 'authorizing') {
        expect(fixture).toMatchObject({ session: { attempt: { kind: 'bootstrap', expiresAt: expect.any(Number) } } })
      }
      if (phase === 'failed') expect(fixture).toMatchObject({ session: { failure: { code: 'authorization_rejected' } } })
      if (phase === 'cleanup_required') expect(fixture).toMatchObject({ session: { cleanup: { reason: 'cookie_lost' } } })
    } finally {
      await api.close()
    }
  })

  it('keeps handoff polling inert and allows a new local preview session', async () => {
    const api = await preview()
    try {
      const fixture = await (await api.request('/api/session', 'GET', '/result?preview=running')).json()
      const handoff = await api.request('/api/bootstrap/handoff', 'GET', '/result')
      expect(handoff.status).toBe(409)
      expect(await handoff.json()).toEqual({ schemaVersion: 1, code: 'bootstrap_not_ready', retryAfterMs: 15_000 })
      expect(await (await api.request('/api/session', 'GET', '/result')).json()).toEqual(fixture)
      const restarted = await (await api.request('/api/session/new', 'POST', '/result')).json()
      expect(restarted).toMatchObject({ session: { phase: 'draft', selection: null, plan: null, provision: null } })
      expect(await (await api.request('/api/session')).json()).toEqual(restarted)
    } finally {
      await api.close()
    }
  })

  it('retains configuration and its plan through status refreshes and client-side routes', async () => {
    const api = await preview()
    try {
      expect(await (await api.request('/api/session', 'GET', '/gateway?preview=connected')).json()).toMatchObject({ selection: null, plan: null })
      const configured = await (await api.request('/api/selection', 'PUT', '/gateway?preview=connected')).json()
      expect(configured).toMatchObject({ plan: null, capabilities: { plan: true } })
      expect(await (await api.request('/api/session', 'GET', '/review')).json()).toEqual(configured)
      const planned = await (await api.request('/api/plan', 'POST', '/review')).json()
      expect(planned).toMatchObject({ plan: { planId: 'plan-example-preview', writesPerformed: false } })
      expect(await (await api.request('/api/session', 'GET', '/review')).json()).toEqual(planned)
      expect(await (await api.request('/api/session', 'GET', '/gateway?preview=connected')).json()).toEqual(planned)
      expect(await (await api.request('/api/session', 'GET', '/deploy')).json()).toEqual(planned)
    } finally {
      await api.close()
    }
  })

  it('explicit fixture navigation resets retained state, including a repeated fixture', async () => {
    const api = await preview()
    try {
      await api.request('/gateway?preview=connected')
      await api.request('/api/selection', 'PUT', '/gateway?preview=connected')
      await api.request('/api/plan', 'POST', '/review')
      await api.request('/gateway?preview=connected')
      expect(await (await api.request('/api/session', 'GET', '/gateway?preview=connected')).json()).toMatchObject({ selection: null, plan: null })
      expect(await (await api.request('/api/session', 'GET', '/result?preview=failed')).json()).toMatchObject({ deployment: { status: 'failed' } })
      expect(await (await api.request('/api/session', 'GET', '/?preview=start')).json()).toMatchObject({ selection: null, plan: null, deployment: null })
    } finally {
      await api.close()
    }
  })

  it('retains a synthetic removal review across refreshes without executing it', async () => {
    const api = await preview()
    try {
      await api.request('/api/session', 'GET', '/result?preview=success')
      const planned = await (await api.request('/api/uninstall/plan', 'POST', '/result?preview=success')).json()
      expect(planned).toMatchObject({ removal: { status: 'planned', plan: { writesPerformed: false } } })
      expect(await (await api.request('/api/session', 'GET', '/result')).json()).toEqual(planned)
      expect((await api.request('/api/uninstall', 'POST', '/result')).status).toBe(409)
      expect(await (await api.request('/api/session', 'GET', '/result')).json()).toEqual(planned)
    } finally {
      await api.close()
    }
  })

  it('consent entrypoints stay unavailable and never imply completed discovery or installation', async () => {
    const api = await preview()
    try {
      const before = await (await api.request('/api/session')).json()
      for (const endpoint of ['/api/discovery', '/api/deploy', '/api/uninstall', '/api/bootstrap', '/api/cleanup']) {
        const response = await api.request(endpoint, 'POST')
        expect(response.status).toBe(409)
        expect(await response.json()).toEqual({ schemaVersion: 1, code: 'preview_authorization_unavailable' })
        expect(await (await api.request('/api/session')).json()).toEqual(before)
      }
      expect(await (await api.request('/api/discovery')).json()).toMatchObject({ status: 'not_started', targets: [], grantRevocation: null })
      expect(await (await api.request('/api/discovery', 'GET', '/gateway?preview=connected')).json()).toMatchObject({ status: 'ready', grantRevocation: 'confirmed' })
    } finally {
      await api.close()
    }
  })
})
