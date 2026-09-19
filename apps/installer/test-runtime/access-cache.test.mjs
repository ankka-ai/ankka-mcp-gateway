import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

test('production Access verification reuses public CryptoKeys across workerd requests', async () => {
  const issuer = 'https://runtime-cache.cloudflareaccess.com';
  const algorithm = { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' };
  const pair = await crypto.subtle.generateKey(algorithm, true, ['sign', 'verify']);
  const jwk = { ...await crypto.subtle.exportKey('jwk', pair.publicKey), kid: 'runtime-key', alg: 'RS256', use: 'sig' };
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encode({ kid: jwk.kid, alg: 'RS256' })}.${encode({
    iss: issuer, aud: ['runtime-audience'], email: 'admin@example.com', exp: Math.floor(Date.now() / 1000) + 300,
  })}`;
  const signature = await crypto.subtle.sign(algorithm, pair.privateKey, new TextEncoder().encode(unsigned));
  const assertion = `${unsigned}.${Buffer.from(signature).toString('base64url')}`;
  const bundle = await build({
    stdin: { contents: `import { verifyAccessActor } from './payload/worker/index.js';
      export default { async fetch(request) {
        const actor = await verifyAccessActor(request, { CF_ACCESS_ISSUER: '${issuer}',
          CF_ACCESS_AUD: 'runtime-audience', ADMIN_EMAILS: 'admin@example.com' });
        return Response.json({ authorized: actor?.kind === 'human' });
      } };`, resolveDir: fileURLToPath(new URL('../../../', import.meta.url)) },
    bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022',
  });
  const registry = await mkdtemp(join(tmpdir(), 'ankka-access-runtime-'));
  let keyReads = 0;
  let unexpectedRequests = 0;
  const runtime = new Miniflare({
    host: '127.0.0.1', port: 0, cf: false, unsafeDevRegistryPath: registry,
    workers: [{
      config: { type: 'worker', name: 'synthetic-access-cache', compatibilityDate: '2026-08-14',
        manifest: { mainModule: 'fixture.mjs', modules: { 'fixture.mjs': { type: 'esm', contents: bundle.outputFiles[0].text } } } },
      dev: { outboundService: { type: 'fetcher', handler: (request) => {
        if (request.method !== 'GET' || request.url !== `${issuer}/cdn-cgi/access/certs`) {
          unexpectedRequests += 1;
          return Response.json({ code: 'outbound_disabled' }, { status: 502 });
        }
        keyReads += 1;
        return Response.json({ keys: [jwk] });
      } } },
    }],
  });
  const verify = async (value) => (await runtime.dispatchFetch('http://localhost/api/team', { headers: {
    'cf-access-authenticated-user-email': 'admin@example.com', 'cf-access-jwt-assertion': value,
  } })).json();
  try {
    await runtime.ready;
    assert.deepEqual(await verify(assertion), { authorized: true });
    assert.deepEqual(await Promise.all([verify(assertion), verify(assertion)]), [{ authorized: true }, { authorized: true }]);
    const forged = `${unsigned}.${Buffer.alloc(256).toString('base64url')}`;
    assert.deepEqual(await verify(forged), { authorized: false });
    assert.equal(keyReads, 1);
    assert.equal(unexpectedRequests, 0);
  } finally {
    try { await runtime.dispose(); }
    finally { await rm(registry, { recursive: true, force: true }); }
  }
});
