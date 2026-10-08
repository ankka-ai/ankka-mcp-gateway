import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

test('connect page runs in workerd and preserves the portal response and POST', async () => {
  const bundle = await build({ entryPoints: [fileURLToPath(new URL('../../connect-page/src/index.js', import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'browser', loader: { '.html': 'text', '.svg': 'text' } });
  const seen = [];
  const directory = await mkdtemp(join(tmpdir(), 'ankka-connect-page-'));
  const runtime = new Miniflare({ host: '127.0.0.1', port: 0, cf: false, unsafeDevRegistryPath: directory,
    workers: [{ config: { type: 'worker', name: 'connect-page-test', compatibilityDate: '2026-08-29',
      manifest: { mainModule: 'worker.mjs', modules: { 'worker.mjs': { type: 'esm', contents: bundle.outputFiles[0].text } } },
      env: { MCP_HOSTNAME: { type: 'text', value: 'connect.example.com' } },
    }, dev: { outboundService: { type: 'fetcher', handler: async (request) => {
      seen.push({ url: request.url, method: request.method, body: await request.text(),
        authorization: request.headers.get('authorization') });
      if (request.method === 'POST') return new Response('data: {"jsonrpc":"2.0","id":1,"result":{}}\n\n', {
        headers: { 'content-type': 'text/event-stream', 'mcp-session-id': 'synthetic' },
      });
      return new Response('{"error":"invalid_token"}', { status: 401, headers: {
        'www-authenticate': 'Bearer resource_metadata="https://connect.example.com/.well-known/oauth-protected-resource"',
      } });
    } } } }],
  });
  try {
    // Miniflare's HTTP transport uses fetch (mode=cors). Its documented
    // passthrough header preserves the browser's original navigation mode.
    const browser = await runtime.dispatchFetch('https://connect.example.com/mcp', { headers: {
      'MF-Sec-Fetch-Mode': 'navigate',
      accept: 'text/html', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document',
    } });
    assert.equal(browser.status, 200);
    assert.match(await browser.text(), /Your tools\. In your AI assistant\./u);
    assert.equal(seen.length, 0);
    const protocol = await runtime.dispatchFetch('https://connect.example.com/mcp', { headers: { accept: 'text/event-stream' } });
    assert.equal(protocol.status, 401);
    assert.match(protocol.headers.get('www-authenticate'), /^Bearer resource_metadata=/u);
    const body = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}';
    const post = await runtime.dispatchFetch('https://connect.example.com/mcp', { method: 'POST', body, headers: {
      accept: 'application/json, text/event-stream', 'content-type': 'application/json', authorization: 'Bearer synthetic',
    } });
    assert.equal(post.headers.get('content-type'), 'text/event-stream');
    assert.equal(post.headers.get('mcp-session-id'), 'synthetic');
    assert.equal(await post.text(), 'data: {"jsonrpc":"2.0","id":1,"result":{}}\n\n');
    assert.deepEqual(seen[1], { url: 'https://connect.example.com/mcp', method: 'POST', body, authorization: 'Bearer synthetic' });
  } finally {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
