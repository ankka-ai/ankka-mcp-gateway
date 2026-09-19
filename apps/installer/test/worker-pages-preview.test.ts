import { createServer } from 'node:http'
import * as v from 'valibot'
import { workerPagesPreview } from '../preview/worker-pages'
import { customerSetupPage } from '../src/customer-setup-page'
import { catalog } from '../../admin/preview/catalog'

it('serves every Worker gallery entry as an inert local fixture without relaxing production framing', async () => {
  const middleware = workerPagesPreview()
  const server = createServer((request, response) => middleware(request, response, () => { response.writeHead(404); response.end() }))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = v.parse(v.object({ port: v.number() }), server.address())
  try {
    for (const entry of catalog.filter(item => item.group === 'Gateway setup')) {
      const path = new URL(entry.url).pathname
      const response = await fetch(`http://127.0.0.1:${port}${path}`)
      expect(response.status, entry.id).toBe(200)
      expect(response.headers.get('content-security-policy')).toContain("connect-src 'none'")
      expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'self' http://127.0.0.1:5730")
      const html = await response.text()
      expect(html).toContain('window.fetch=async')
      expect(html).toContain('preview_only')
      expect(html.indexOf('window.fetch=async')).toBeLessThan(html.indexOf('</head>'))
      expect(html).toContain('class="ankka-setup"')
    }
    const mutation = await fetch(`http://127.0.0.1:${port}/__ui/worker/setup`, { method: 'POST' })
    expect(mutation.status).toBe(405)
    expect(customerSetupPage().headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
  } finally {
    await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections() })
  }
})
