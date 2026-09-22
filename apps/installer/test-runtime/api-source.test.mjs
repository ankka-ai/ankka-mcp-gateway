import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

const connection = { origin: 'https://api.example.com', upstreamEnforcesReadOnly: true, authHeader: 'authorization', authPrefix: 'Bearer ' };
const credential = 'synthetic-api-source-credential';
const definition = {
  label: 'Synthetic inventory', tools: [{
    name: 'getStock', description: 'Get stock for a SKU.',
    inputSchema: { type: 'object', properties: { sku: { type: 'string' } }, required: ['sku'], additionalProperties: false },
    requests: [{ method: 'GET', path: '/v1.0/inventory/{sku}' }],
    code: 'async (input) => { const result = await api.request({method: "GET", path: "/v1.0/inventory/" + encodeURIComponent(input.sku)}); return {sku: input.sku, available: result.quantity}; }',
  }],
};
async function runtime(directory, changedConnection = connection) {
  const keys = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(keys.publicKey), kid: 'synthetic-api-runtime', use: 'sig', alg: 'RS256' };
  const assertion = await new SignJWT({ email: 'reader@example.com' }).setProtectedHeader({ alg: 'RS256', kid: jwk.kid })
    .setIssuer('https://team.cloudflareaccess.com').setAudience('a'.repeat(64)).setIssuedAt().setExpirationTime('5m').sign(keys.privateKey);
  const bundle = await build({ entryPoints: [fileURLToPath(new URL('./api-source-worker.ts', import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022',
    external: ['cloudflare:workers', 'node:*'] });
  const calls = [];
  const delayedRead = Promise.withResolvers();
  const readStarted = Promise.withResolvers();
  const mf = new Miniflare({ host: '127.0.0.1', port: 0, cf: false,
    unsafeDevRegistryPath: join(directory, 'registry'), resourcePersistencePath: join(directory, 'storage'),
    workers: [{ config: { type: 'worker', name: 'api-source-fixture', compatibilityDate: '2026-08-08', compatibilityFlags: [],
      manifest: { mainModule: 'fixture.mjs', modules: { 'fixture.mjs': { type: 'esm', contents: bundle.outputFiles[0].text } } },
      env: {
        SOURCE: { type: 'durable-object', workerName: 'api-source-fixture', exportName: 'ApiSourceFixture' },
        FIXTURE: { type: 'durable-object', workerName: 'api-source-fixture', exportName: 'ApiSourceFixture' },
        LOADER: { type: 'worker-loader' },
        PUBLIC_ORIGIN: { type: 'text', value: 'https://api-source.example.com' },
        ACCESS_TEAM_DOMAIN: { type: 'text', value: 'team.cloudflareaccess.com' },
        ACCESS_AUD: { type: 'text', value: 'a'.repeat(64) },
        CONNECTION_JSON: { type: 'text', value: JSON.stringify(changedConnection) },
        PROVIDER_TOKEN: { type: 'text', value: credential },
      }, exports: { ApiSourceFixture: { type: 'durable-object', storage: 'sqlite' } },
    }, dev: { outboundService: { type: 'fetcher', handler: (request) => {
      calls.push({ url: request.url, authorization: request.headers.get('authorization') });
      if (request.url === 'https://team.cloudflareaccess.com/cdn-cgi/access/certs') return Response.json({ keys: [jwk] });
      if (request.url === 'https://api.example.com/v1.0/inventory/wait') {
        readStarted.resolve();
        return delayedRead.promise.then(() => Response.json({ quantity: 7 }));
      }
      if (request.url === 'https://api.example.com/v1.0/inventory/echo') return Response.json({ echoed: credential });
      if (request.url === 'https://api.example.com/v1.0/inventory/redirect') return new Response(null, { status: 302, headers: { location: 'https://other.example.com/' } });
      if (request.url.startsWith('https://api.example.com/v1.0/inventory/')) return Response.json({ quantity: 7, privateField: 'synthetic-private-response' });
      return Response.json({ error: 'outbound_disabled' }, { status: 502 });
    } } } }],
  });
  try { await mf.ready; } catch (error) { await mf.dispose(); throw error; }
  const manage = async (body) => {
    const response = await mf.dispatchFetch('http://localhost/manage', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const call = async (name, input) => (await mf.dispatchFetch('http://localhost/call', {
    method: 'POST', body: JSON.stringify({ name, input: JSON.stringify(input) }) })).json();
  const mcp = async (method, params = {}) => {
    const result = await mf.dispatchFetch('http://localhost/mcp', { method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-access-jwt-assertion': assertion },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    return { status: result.status, body: await result.json() };
  };
  return { mf, manage, call, calls, mcp, readStarted: readStarted.promise, releaseRead: () => delayedRead.resolve() };
}

test('agent writes, tests and activates a source in isolated Workers; state survives restart without test data', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ankka-api-source-'));
  let active;
  try {
    active = await runtime(dir);
    const { manage, call } = active;
    assert.equal((await manage({ operation: 'read' })).body.revision, 1);
    assert.equal((await manage({ operation: 'save', revision: 1, definitionJson: JSON.stringify(definition) })).status, 200);
    assert.equal((await manage({ operation: 'activate', revision: 2 })).body.error, 'api_source_test_required');
    const tested = await manage({ operation: 'test', revision: 2, tool: 'getStock', argumentsJson: '{"sku":"item-1"}' });
    assert.equal(tested.body.ok, true, JSON.stringify(tested));
    assert.deepEqual(tested.body.result, { sku: 'item-1', available: 7 });
    assert.equal(active.calls[0].authorization, `Bearer ${credential}`);
    assert.equal((await call('getStock', { sku: 'item-1' })).ok, false);
    assert.equal((await manage({ operation: 'activate', revision: 2 })).status, 200);
    const listed = await active.mcp('tools/list');
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body.result.tools.map((tool) => tool.name), ['getStock']);
    assert.ok(!JSON.stringify(listed).includes(definition.tools[0].code));
    const invoked = await active.mcp('tools/call', { name: 'getStock', arguments: { sku: 'item-1' } });
    assert.equal(invoked.body.result.isError, false);
    assert.deepEqual(JSON.parse(invoked.body.result.content[0].text), { sku: 'item-1', available: 7 });
    const denied = await active.mcp('tools/call', { name: 'save_api_source_draft', arguments: {} });
    assert.equal(denied.body.result.isError, true);
    assert.equal((await call('getStock', { sku: 'item-2' })).ok, true);
    assert.equal((await manage({ operation: 'save', revision: 2, definitionJson: JSON.stringify(definition) })).status, 409);
    const state = await (await active.mf.dispatchFetch('http://localhost/state')).text();
    for (const privateValue of [credential, 'item-1', 'item-2', 'synthetic-private-response']) assert.ok(!state.includes(privateValue));
    await active.mf.dispose();
    active = await runtime(dir);
    assert.equal((await active.call('getStock', { sku: 'item-3' })).ok, true);
    assert.equal((await active.manage({ operation: 'disable', revision: 3 })).status, 200);
    assert.equal((await active.call('getStock', { sku: 'item-3' })).ok, false);
  } finally { await active?.mf.dispose(); await rm(dir, { recursive: true, force: true }); }
});

test('sandbox cannot bypass the API boundary or activate a failed test', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ankka-api-source-'));
  const active = await runtime(dir);
  try {
    let revision = 1;
    for (const [code, expected] of [
      ['async () => fetch("https://other.example.com/")', 'api_source_execution_failed'],
      ['async () => api.request({method:"GET",path:"/admin"})', 'connector_request_not_allowed'],
      ['async () => api.request({method:"GET",path:"/v1X0/inventory/item"})', 'connector_request_not_allowed'],
      ['async () => api.request({method:"GET",path:"/v1.0/inventory/../admin"})', 'connector_request_invalid'],
      ['async () => api.request({method:"DELETE",path:"/v1.0/inventory/item"})', 'api_source_request_invalid'],
      ['async () => api.request({method:"GET",path:"/v1.0/inventory/echo"})', 'api_source_response_rejected'],
      ['async () => api.request({method:"GET",path:"/v1.0/inventory/redirect"})', 'connector_upstream_rejected'],
      ['async () => { for(let i=0;i<13;i++) await api.request({method:"GET",path:"/v1.0/inventory/item"}); }', 'api_source_request_budget'],
      ['async () => { console.log("synthetic-private-log"); throw new Error("synthetic-private-error"); }', 'api_source_execution_failed'],
    ]) {
      const changed = { ...definition, tools: [{ ...definition.tools[0], code }] };
      assert.equal((await active.manage({ operation: 'save', revision, definitionJson: JSON.stringify(changed) })).status, 200);
      revision++;
      const tested = await active.manage({ operation: 'test', revision, tool: 'getStock', argumentsJson: '{"sku":"item"}' });
      assert.equal(tested.body.error, expected, JSON.stringify(tested));
      assert.equal((await active.manage({ operation: 'activate', revision })).status, 409);
      assert.ok(!JSON.stringify(tested).includes('synthetic-private'));
    }
    assert.ok(active.calls.every((call) => call.url.startsWith(connection.origin + '/v1.0/inventory/')));
    const rejected = await active.mf.dispatchFetch('http://localhost/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(rejected.status, 403);
  } finally { await active.mf.dispose(); await rm(dir, { recursive: true, force: true }); }
});

test('sandbox timer tampering fails closed and in-flight tests cannot bless edited code', { timeout: 30_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ankka-api-source-'));
  const active = await runtime(dir);
  try {
    const hanging = { ...definition, tools: [{ ...definition.tools[0],
      code: '(() => { globalThis.setTimeout = () => 0; return async () => await new Promise(() => {}); })()' }] };
    await active.manage({ operation: 'save', revision: 1, definitionJson: JSON.stringify(hanging) });
    const tampered = await active.manage({ operation: 'test', revision: 2, tool: 'getStock', argumentsJson: '{"sku":"item"}' });
    assert.equal(tampered.body.ok, false);
    assert.equal((await active.manage({ operation: 'activate', revision: 2 })).status, 409);
    const waiting = { ...definition, tools: [{ ...definition.tools[0],
      code: 'async () => api.request({method:"GET",path:"/v1.0/inventory/wait"})' }] };
    await active.manage({ operation: 'save', revision: 2, definitionJson: JSON.stringify(waiting) });
    const testing = active.manage({ operation: 'test', revision: 3, tool: 'getStock', argumentsJson: '{"sku":"item"}' });
    await active.readStarted;
    await active.manage({ operation: 'save', revision: 3, definitionJson: JSON.stringify(definition) });
    active.releaseRead();
    const stale = await testing;
    assert.equal(stale.status, 409);
    assert.equal((await active.manage({ operation: 'activate', revision: 4 })).body.error, 'api_source_test_required');
    assert.equal(active.calls.length, 1);
  } finally { active.releaseRead(); await active.mf.dispose(); await rm(dir, { recursive: true, force: true }); }
});

test('draft edits invalidate tests, active code is stable, and a connection change disables old code', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ankka-api-source-'));
  let active;
  try {
    active = await runtime(dir);
    await active.manage({ operation: 'save', revision: 1, definitionJson: JSON.stringify(definition) });
    await active.manage({ operation: 'test', revision: 2, tool: 'getStock', argumentsJson: '{"sku":"item"}' });
    await active.manage({ operation: 'activate', revision: 2 });
    const edited = { ...definition, tools: [{ ...definition.tools[0], code: 'async () => 99' }] };
    await active.manage({ operation: 'save', revision: 3, definitionJson: JSON.stringify(edited) });
    assert.equal((await active.manage({ operation: 'activate', revision: 4 })).status, 409);
    assert.deepEqual((await active.call('getStock', { sku: 'item' })).result, { sku: 'item', available: 7 });
    await active.manage({ operation: 'test', revision: 4, tool: 'getStock', argumentsJson: '{"sku":"item"}' });
    await active.manage({ operation: 'test', revision: 4, tool: 'getStock', argumentsJson: '{}' });
    assert.equal((await active.manage({ operation: 'activate', revision: 4 })).status, 409);
    const racing = await Promise.all([
      active.manage({ operation: 'save', revision: 4, definitionJson: JSON.stringify(definition) }),
      active.manage({ operation: 'discard', revision: 4 }),
    ]);
    assert.deepEqual(racing.map((result) => result.status).sort(), [200, 409]);
    await active.mf.dispose();
    active = await runtime(dir, { ...connection, origin: 'https://changed.example.com' });
    assert.equal((await active.call('getStock', { sku: 'item' })).ok, false);
    assert.equal(active.calls.length, 0);
  } finally { await active?.mf.dispose(); await rm(dir, { recursive: true, force: true }); }
});


test('built-in gateway registry exposes safe configuration and isolates each source in existing SQLite storage', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ankka-api-registry-'));
  const active = await runtime(dir);
  const manage = async (command) => {
    const response = await active.mf.dispatchFetch('http://localhost/gateway/manage', { method: 'POST', body: JSON.stringify(command) });
    return { status: response.status, body: await response.json() };
  };
  try {
    const registry = await manage({ operation: 'read' });
    assert.deepEqual(registry.body.connections.map((entry) => entry.connectionKey), ['inventory', 'billing']);
    assert.equal(JSON.stringify(registry).includes(credential), false);
    assert.equal((await manage({ operation: 'read', connectionKey: 'missing' })).status, 409);
    assert.equal((await manage({ operation: 'save', connectionKey: 'inventory', revision: 1, definitionJson: JSON.stringify(definition) })).status, 200);
    assert.equal((await manage({ operation: 'test', connectionKey: 'inventory', revision: 2, tool: 'getStock', argumentsJson: '{"sku":"one"}' })).body.ok, true);
    const activated = await manage({ operation: 'activate', connectionKey: 'inventory', revision: 2 });
    assert.equal(activated.body.endpoint, 'https://manage.example.com/api/api-sources/inventory/mcp');
    assert.equal((await manage({ operation: 'call', connectionKey: 'inventory', tool: 'getStock', argumentsJson: '{"sku":"one"}' })).body.ok, true);
    assert.equal((await manage({ operation: 'call', connectionKey: 'billing', tool: 'getStock', argumentsJson: '{"sku":"one"}' })).body.ok, false);
    assert.equal((await manage({ operation: 'read', connectionKey: 'billing' })).body.revision, 1);
    assert.equal((await manage({ operation: 'save', connectionKey: 'inventory', revision: 3, origin: 'https://evil.example.com', definitionJson: JSON.stringify(definition) })).status, 400);
    const stored = await (await active.mf.dispatchFetch('http://localhost/state')).text();
    assert.equal(stored.includes(credential), false);
    assert.equal(stored.includes('synthetic-private-response'), false);
  } finally { await active.mf.dispose(); await rm(dir, { recursive: true, force: true }); }
});
