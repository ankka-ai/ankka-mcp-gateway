import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyAccessActor } from '../payload/worker/index.js';

const algorithm = { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' };
const now = Date.now();
const admin = 'admin@example.com';
const serviceClient = `${'c'.repeat(32)}.access`;
let fixtureId = 0;

async function signingKey(kid) {
  const pair = await crypto.subtle.generateKey(algorithm, true, ['sign', 'verify']);
  return { kid, privateKey: pair.privateKey,
    jwk: { ...await crypto.subtle.exportKey('jwk', pair.publicKey), kid, alg: 'RS256', use: 'sig' } };
}

async function fixture(run) {
  const env = { CF_ACCESS_ISSUER: `https://synthetic-cache-${++fixtureId}.cloudflareaccess.com`,
    CF_ACCESS_AUD: 'synthetic-audience', ADMIN_EMAILS: admin, ANKKA_SERVICE_CLIENT_ID: serviceClient };
  const first = await signingKey('first');
  let published = [first.jwk];
  let status = 200;
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (request) => {
    calls.push(request.url);
    assert.equal(request.headers.get('authorization'), null);
    assert.equal(request.headers.get('cookie'), null);
    assert.equal(request.redirect, 'manual');
    return Response.json({ keys: published }, { status });
  };
  async function request(key = first, claims = {}, identity = admin, issuer = env.CF_ACCESS_ISSUER) {
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = `${encode({ alg: 'RS256', kid: key.kid })}.${encode({
      iss: issuer, aud: [env.CF_ACCESS_AUD], email: identity,
      exp: Math.floor(now / 1000) + 3600, nbf: Math.floor(now / 1000) - 1, ...claims,
    })}`;
    const signature = await crypto.subtle.sign(algorithm, key.privateKey, new TextEncoder().encode(unsigned));
    const headers = { 'cf-access-jwt-assertion': `${unsigned}.${Buffer.from(signature).toString('base64url')}` };
    if (identity) headers['cf-access-authenticated-user-email'] = identity;
    return new Request('https://manage.example.com/api/team', { headers });
  }
  try { await run({ env, first, calls, request, publish(keys) { published = keys; }, status(value) { status = value; } }); }
  finally { globalThis.fetch = original; }
}

test('warm signing keys skip fetch while every assertion, identity and validity check still runs', async () => fixture(async ({ env, first, calls, request }) => {
  const valid = await request();
  assert.deepEqual(await verifyAccessActor(valid, env, now), { kind: 'human', email: admin });
  assert.deepEqual(await verifyAccessActor(valid, { ...env }, now + 1), { kind: 'human', email: admin });
  const impostor = await signingKey(first.kid);
  assert.equal(await verifyAccessActor(await request(impostor), env, now), null, 'same kid does not bypass the signature');
  for (const claims of [
    { exp: Math.floor(now / 1000) }, { nbf: Math.floor(now / 1000) + 60 },
    { aud: ['other-audience'] }, { iss: 'https://other.cloudflareaccess.com' }, { email: 'other@example.com' },
  ]) assert.equal(await verifyAccessActor(await request(first, claims), env, now), null);
  assert.equal(await verifyAccessActor(valid, { ...env, ADMIN_EMAILS: 'other@example.com' }, now), null);
  const service = await request(first, { email: '', common_name: serviceClient, type: 'app' }, '');
  assert.deepEqual(await verifyAccessActor(service, env, now), { kind: 'service', clientId: serviceClient });
  assert.equal(await verifyAccessActor(service, { ...env, ANKKA_SERVICE_CLIENT_ID: `${'d'.repeat(32)}.access` }, now), null);
  assert.equal(calls.length, 1);
}));

test('unknown signing key refreshes the entire issuer set and follows rotation', async () => fixture(async ({ env, first, calls, request, publish }) => {
  const old = await request();
  assert.ok(await verifyAccessActor(old, env, now));
  const second = await signingKey('second');
  publish([first.jwk, second.jwk]);
  assert.ok(await verifyAccessActor(await request(second), env, now + 1));
  assert.ok(await verifyAccessActor(old, env, now + 2));
  assert.equal(calls.length, 2, 'both keys from the refreshed set are cached');
  publish([second.jwk]);
  assert.ok(await verifyAccessActor(await request(second), env, now + 300_001));
  assert.equal(await verifyAccessActor(old, env, now + 300_002), null, 'removed keys are not retained after refresh');
  assert.equal(calls.length, 4);
}));

test('expired signing keys fail closed on provider failure and recover on a successful read', async () => fixture(async ({ env, calls, request, status }) => {
  const valid = await request();
  assert.ok(await verifyAccessActor(valid, env, now));
  status(503);
  assert.ok(await verifyAccessActor(valid, env, now + 299_999));
  assert.equal(await verifyAccessActor(valid, env, now + 300_000), null);
  assert.equal(await verifyAccessActor(valid, env, now + 300_001), null, 'no stale fallback');
  status(200);
  assert.ok(await verifyAccessActor(valid, env, now + 300_002));
  assert.equal(calls.length, 4);
}));

test('signing key cache is scoped to the configured issuer and bounds retained issuers', async () => fixture(async ({ env, calls, request, status }) => {
  const valid = await request();
  assert.ok(await verifyAccessActor(valid, env, now));
  const otherIssuer = env.CF_ACCESS_ISSUER.replace('synthetic-cache-', 'other-cache-');
  status(503);
  assert.equal(await verifyAccessActor(await request(undefined, {}, admin, otherIssuer),
    { ...env, CF_ACCESS_ISSUER: otherIssuer }, now), null, 'a matching kid from another issuer is not trusted');
  assert.equal(calls[1], `${otherIssuer}/cdn-cgi/access/certs`);
  status(200);
  for (let index = 0; index < 8; index += 1) {
    const issuer = `https://bounded-${index}.cloudflareaccess.com`;
    assert.ok(await verifyAccessActor(await request(undefined, {}, admin, issuer), { ...env, CF_ACCESS_ISSUER: issuer }, now));
  }
  const before = calls.length;
  assert.ok(await verifyAccessActor(valid, env, now + 1));
  assert.equal(calls.length, before + 1, 'the ninth issuer evicts the oldest entry');
}));

test('duplicate, malformed and oversized key sets cannot populate the cache', async () => fixture(async ({ env, first, calls, request, publish }) => {
  const valid = await request();
  for (const keys of [[first.jwk, first.jwk], [{ ...first.jwk, n: '' }],
    Array.from({ length: 33 }, (_, index) => ({ ...first.jwk, kid: `key-${index}` }))]) {
    publish(keys);
    assert.equal(await verifyAccessActor(valid, env, now), null);
  }
  publish([first.jwk]);
  assert.ok(await verifyAccessActor(valid, env, now));
  assert.equal(calls.length, 4);
}));
