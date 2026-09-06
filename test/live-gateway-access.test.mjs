import assert from 'node:assert/strict';
import test from 'node:test';
import { accessCookie, createLiveGatewayAccess } from '../tools/live-gateway-access.mjs';

const origin = 'https://installer.example.com';
const email = 'operator@example.com';
const token = (claims = {}) => `synthetic.${Buffer.from(JSON.stringify({ email, exp: Math.floor(Date.now() / 1000) + 3600, ...claims })).toString('base64url')}.synthetic`;

test('cached Access identity is scoped to one secure host and rejected before use if stale or wrong', () => {
  const cookie = accessCookie(token(), origin, email);
  assert.deepEqual({ ...cookie, value: undefined, expires: undefined }, {
    name: 'CF_Authorization', value: undefined, domain: 'installer.example.com', path: '/',
    secure: true, httpOnly: true, sameSite: 'Lax', expires: undefined,
  });
  for (const value of ['invalid', 'a.b.c', token({ email: 'other@example.com' }), token({ exp: 0 }), token({ exp: 'future' })]) {
    assert.throws(() => accessCookie(value, origin, email));
  }
  assert.throws(() => accessCookie(token(), 'http://installer.example.com', email), { code: 'access_origin_invalid' });
});

test('cached authentication excludes operator authority and adds only its cookie once', async () => {
  const calls = [];
  const cookies = [];
  const value = token();
  const install = createLiveGatewayAccess({ origins: [origin], email, run: async (...args) => {
    calls.push(args); return { stdout: value + '\n' };
  } });
  const context = { addCookies: async (items) => cookies.push(...items) };
  await install(context, origin);
  await install(context, origin);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 2), ['cloudflared', ['access', 'token', '--app', origin]]);
  assert.equal(calls[0][2].env.CLOUDFLARE_API_TOKEN, undefined);
  assert.equal(JSON.stringify(calls).includes(value), false);
  assert.equal(cookies.length, 1);
  assert.equal(cookies[0].value, value);
  await assert.rejects(install(context, 'https://foreign.example.com'), { code: 'access_origin_invalid' });
  assert.equal(calls.length, 1);
});

test('child-process errors and output cannot leak credentials; cached preflight never starts login', async () => {
  const value = token();
  const calls = [];
  const install = createLiveGatewayAccess({ origins: [origin], email, run: async (...args) => {
    calls.push(args); throw new Error(value);
  } });
  await assert.rejects(install({ addCookies: assert.fail }, origin), (error) => {
    assert.equal(error.message, 'access_login_required');
    assert.equal(error.cause, undefined);
    assert.equal(error.stack.includes(value), false);
    return true;
  });
  assert.equal(calls.length, 1);
});

test('explicit interactive Access login is quiet and its result is reread from the cache', async () => {
  const calls = [];
  const cookies = [];
  const install = createLiveGatewayAccess({ origins: [origin], email, run: async (file, args) => {
    calls.push(args);
    if (calls.length === 1) throw new Error('No cached session');
    return { stdout: args[1] === 'login' ? '' : token() };
  } });
  await install({ addCookies: async (items) => cookies.push(...items) }, origin, { allowLogin: true });
  assert.deepEqual(calls.map((args) => args[1]), ['token', 'login', 'token']);
  assert.deepEqual(calls[1], ['access', 'login', '--quiet', '--app', origin]);
  assert.equal(cookies.length, 1);
});

test('wrong account never triggers another login or installs a cookie', async () => {
  let calls = 0;
  const install = createLiveGatewayAccess({ origins: [origin], email, run: async () => {
    calls++; return { stdout: token({ email: 'other@example.com' }) };
  } });
  await assert.rejects(install({ addCookies: assert.fail }, origin, { allowLogin: true }), { code: 'access_identity_mismatch' });
  assert.equal(calls, 1);
});

test('cancellation interrupts normal-browser login without installing a token', async () => {
  const controller = new AbortController();
  const install = createLiveGatewayAccess({ origins: [origin], email, signal: controller.signal,
    run: async (file, args, options) => {
      if (args[1] === 'token') throw new Error('No cached session');
      assert.equal(options.signal, controller.signal);
      controller.abort();
      throw new Error('Aborted');
    } });
  await assert.rejects(install({ addCookies: assert.fail }, origin, { allowLogin: true }), { code: 'access_login_cancelled' });
});
