import assert from 'node:assert/strict';
import test from 'node:test';
import worker, { fetchMcpSourceIcon } from '../payload/worker/index.js';

const endpoint = 'https://icons.example.com/mcp';
const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>';
const inline = (value, mimeType = 'image/svg+xml') => ({ src: `data:${mimeType};base64,${Buffer.from(value).toString('base64')}`, mimeType });
const metadata = (icons) => Response.json({ jsonrpc: '2.0', id: 1, result: {
  tools: [], _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'Synthetic MCP', version: '1', icons } },
} });

test('reads modern server icons and prefers dark artwork without fetching embedded data', async (t) => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (request) => { requests.push(request); return metadata([
    { ...inline('<svg></svg>'), theme: 'light' }, { ...inline(svg), theme: 'dark' },
  ]); });
  const icon = await fetchMcpSourceIcon(endpoint);
  assert.equal(icon.type, 'image/svg+xml');
  assert.equal(new TextDecoder().decode(icon.bytes), svg);
  assert.equal(requests.length, 1);
});

test('reads legacy initialize icons and fetches only the same origin without credentials or redirects', async (t) => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (request) => {
    requests.push(request);
    if (requests.length === 1) return new Response(null, { status: 400 });
    if (requests.length === 2) {
      assert.equal((await request.json()).method, 'initialize');
      return Response.json({ jsonrpc: '2.0', id: 1, result: { serverInfo: { icons: [{ src: 'https://icons.example.com/icon.svg' }] } } });
    }
    assert.equal(request.url, 'https://icons.example.com/icon.svg');
    assert.equal(request.credentials, 'omit');
    assert.equal(request.redirect, 'manual');
    assert.equal(request.headers.has('authorization'), false);
    assert.equal(request.headers.has('cookie'), false);
    return new Response(svg, { headers: { 'content-type': 'image/svg+xml' } });
  });
  assert.equal((await fetchMcpSourceIcon(endpoint)).type, 'image/svg+xml');
  assert.equal(requests.length, 3);
});

test('rejects cross-origin, unsafe and credential-bearing icon URLs without fetching them', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return metadata([
    { src: 'https://tracker.example.com/logo.png' }, { src: 'http://icons.example.com/logo.png' },
    { src: 'https://user:secret@icons.example.com/logo.png' }, { src: 'javascript:alert(1)' },
  ]); });
  assert.equal(await fetchMcpSourceIcon(endpoint), null);
  assert.equal(calls, 1);
});

test('rejects redirects, active SVG, mismatched MIME and oversized bodies', async (t) => {
  for (const reply of [
    () => new Response(null, { status: 302, headers: { location: 'https://tracker.example.com/icon.svg' } }),
    () => new Response('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
    () => new Response(svg, { headers: { 'content-type': 'text/html' } }),
    () => new Response('x'.repeat(128 * 1024 + 1)),
  ]) {
    t.mock.method(globalThis, 'fetch', async (request) => request.url === endpoint
      ? metadata([{ src: 'https://icons.example.com/icon.svg' }]) : reply());
    assert.equal(await fetchMcpSourceIcon(endpoint), null);
    t.mock.restoreAll();
  }
});

test('supports PNG and JPEG while rejecting excessive pixel dimensions', async (t) => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  const jpeg = Buffer.from([255, 216, 255, 192, 0, 11, 8, 0, 1, 0, 1, 1, 1, 17, 0, 255, 217]);
  for (const [bytes, type] of [[png, 'image/png'], [jpeg, 'image/jpeg']]) {
    t.mock.method(globalThis, 'fetch', async () => metadata([inline(bytes, type)]));
    assert.equal((await fetchMcpSourceIcon(endpoint)).type, type);
    t.mock.restoreAll();
  }
  png.writeUInt32BE(100000, 16);
  t.mock.method(globalThis, 'fetch', async () => metadata([inline(png, 'image/png')]));
  assert.equal(await fetchMcpSourceIcon(endpoint), null);
});

test('missing metadata and protected servers fall back without an icon', async (t) => {
  for (const reply of [() => metadata([]), () => new Response(null, { status: 401 })]) {
    t.mock.method(globalThis, 'fetch', reply);
    assert.equal(await fetchMcpSourceIcon(endpoint), null);
    t.mock.restoreAll();
  }
});

test('protected metadata uses a public same-origin PNG without forwarding credentials', async (t) => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  for (const status of [401, 403]) {
    const requests = [];
    t.mock.method(globalThis, 'fetch', async (request) => {
      requests.push(request);
      assert.equal(request.headers.has('authorization'), false);
      assert.equal(request.headers.has('cookie'), false);
      assert.equal(request.headers.has('cf-access-jwt-assertion'), false);
      if (request.url === endpoint) return new Response(null, { status, headers: {
        'www-authenticate': 'Bearer resource_metadata="https://icons.example.com/.well-known/oauth-protected-resource"',
      } });
      assert.equal(request.url, 'https://icons.example.com/favicon.png');
      assert.equal(request.method, 'GET');
      assert.equal(request.credentials, 'omit');
      assert.equal(request.redirect, 'manual');
      return new Response(png, { headers: { 'content-type': 'image/png' } });
    });
    const icon = await fetchMcpSourceIcon(endpoint);
    assert.equal(icon.type, 'image/png');
    assert.deepEqual(Buffer.from(icon.bytes), png);
    assert.equal(requests.length, 2);
    t.mock.restoreAll();
  }
});

test('public PNG fallback rejects login redirects, invalid images and oversized responses', async (t) => {
  for (const reply of [
    () => new Response(null, { status: 302, headers: { location: 'https://login.example.com/' } }),
    () => new Response(svg, { headers: { 'content-type': 'image/svg+xml' } }),
    () => new Response('not an image', { headers: { 'content-type': 'image/png' } }),
    () => new Response('x'.repeat(128 * 1024 + 1), { headers: { 'content-type': 'image/png' } }),
  ]) {
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async (request) => {
      calls++;
      return request.url === endpoint ? new Response(null, { status: 401 }) : reply();
    });
    assert.equal(await fetchMcpSourceIcon(endpoint), null);
    assert.equal(calls, 2);
    t.mock.restoreAll();
  }
});

test('the icon route requires gateway access before any upstream fetch', async (t) => {
  let fetched = false;
  t.mock.method(globalThis, 'fetch', async () => { fetched = true; throw new Error('unexpected fetch'); });
  const response = await worker.fetch(new Request('https://gateway.example.com/api/sources/source-1111111111111111/icon'), {});
  assert.equal(response.status, 401);
  assert.equal(fetched, false);
});

test('falls back to initialize when a server accepts tools/list but omits modern metadata', async (t) => {
  t.mock.method(globalThis, 'fetch', async (request) => {
    const message = await request.json();
    return message.method === 'tools/list' ? metadata([]) : Response.json({ jsonrpc: '2.0', id: 1,
      result: { serverInfo: { icons: [inline(svg)] } } });
  });
  assert.equal((await fetchMcpSourceIcon(endpoint)).type, 'image/svg+xml');
});

test('serves only saved-source icons behind administrator access with private caching', async (t) => {
  const issuer = 'https://source-icons.cloudflareaccess.com';
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const jwk = { ...await crypto.subtle.exportKey('jwk', pair.publicKey), kid: 'icon-key', alg: 'RS256', use: 'sig' };
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const body = `${encode({ alg: 'RS256', kid: jwk.kid })}.${encode({ iss: issuer, aud: ['source-icons'], email: 'admin@example.com', exp: Math.floor(Date.now() / 1000) + 300 })}`;
  const signature = Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(body))).toString('base64url');
  let probes = 0;
  t.mock.method(globalThis, 'fetch', async (request) => {
    if (request.url === `${issuer}/cdn-cgi/access/certs`) return Response.json({ keys: [jwk] });
    assert.equal(request.url, endpoint);
    assert.equal(request.headers.has('cf-access-jwt-assertion'), false);
    probes++;
    return metadata([inline(svg)]);
  });
  const env = { CF_ACCESS_ISSUER: issuer, CF_ACCESS_AUD: 'source-icons', ADMIN_EMAILS: 'admin@example.com',
    ADMIN_STATE: { idFromName: (name) => name, get: () => ({ fetch: async () => Response.json({ schemaVersion: 1, revision: 1,
      applyMode: 'oauth_per_action', sources: [{ id: 'source-1111111111111111', label: 'Synthetic source', url: endpoint,
        authMode: 'none', onBehalfOfUser: false, enabledTools: ['search'], status: 'installed' }] }) }) } };
  const request = (id) => new Request(`https://gateway.example.com/api/sources/${id}/icon`, { headers: {
    'cf-access-authenticated-user-email': 'admin@example.com', 'cf-access-jwt-assertion': `${body}.${signature}`,
  } });
  const found = await worker.fetch(request('source-1111111111111111'), env);
  assert.equal(found.status, 200);
  assert.equal(found.headers.get('content-type'), 'image/svg+xml');
  assert.equal(found.headers.get('cache-control'), 'private, max-age=300');
  assert.match(found.headers.get('content-security-policy'), /sandbox/u);
  assert.equal(await found.text(), svg);
  assert.equal((await worker.fetch(request('source-2222222222222222'), env)).status, 404);
  assert.equal(probes, 1);
});

test('supports bounded static WebP and rejects animated or oversized artwork', async (t) => {
  const webp = Buffer.alloc(30);
  webp.write('RIFF', 0); webp.writeUInt32LE(22, 4); webp.write('WEBPVP8X', 8); webp.writeUInt32LE(10, 16);
  t.mock.method(globalThis, 'fetch', async () => metadata([inline(webp, 'image/webp')]));
  assert.equal((await fetchMcpSourceIcon(endpoint)).type, 'image/webp');
  webp[20] = 2;
  assert.equal(await fetchMcpSourceIcon(endpoint), null);
  webp[20] = 0; webp[26] = 1;
  assert.equal(await fetchMcpSourceIcon(endpoint), null);
});
