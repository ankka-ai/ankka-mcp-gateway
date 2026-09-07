import assert from 'node:assert/strict';
import test from 'node:test';
import { awaitSystemResolution, hostnameResolvesDirectly } from '../tools/live-gateway-dns.mjs';

test('direct resolution needs every configured server to answer, tries A and AAAA, falls back to 1.1.1.1 only when none is configured, and never throws', async () => {
  const asked = [];
  const answering = new Set();
  const resolver = (server) => async (hostname, type) => {
    asked.push(`${server} ${type} ${hostname}`);
    if (answering.has(server) && type === 'AAAA') return ['2606:4700::1'];
    const error = new Error('queryA ENOTFOUND'); error.code = 'ENOTFOUND'; throw error;
  };
  // A local forwarder that still answers negatively is what the system will ask: not resolved yet, and the public
  // resolver is not consulted in its place.
  answering.add('1.1.1.1');
  assert.equal(await hostnameResolvesDirectly('manage.example.com', { servers: ['100.100.100.100', 'fd7a::53', '1.1.1.1'], resolver }), false);
  assert.deepEqual(asked, ['100.100.100.100 A manage.example.com', '100.100.100.100 AAAA manage.example.com']);
  asked.length = 0; answering.add('100.100.100.100');
  assert.equal(await hostnameResolvesDirectly('manage.example.com', { servers: ['100.100.100.100', 'fd7a::53', '1.1.1.1'], resolver }), true);
  assert.deepEqual(asked, ['100.100.100.100 A manage.example.com', '100.100.100.100 AAAA manage.example.com', '1.1.1.1 A manage.example.com', '1.1.1.1 AAAA manage.example.com']);
  asked.length = 0;
  assert.equal(await hostnameResolvesDirectly('manage.example.com', { servers: [], resolver }), true);
  assert.deepEqual(asked, ['1.1.1.1 A manage.example.com', '1.1.1.1 AAAA manage.example.com']);
  assert.equal(await hostnameResolvesDirectly('missing.example.com', { servers: [], resolver: () => async () => { throw new Error('timeout'); } }), false);
});

test('waiting for system resolution notifies once about a negatively cached name and returns when the system resolves', async () => {
  const notices = [];
  let systemAnswers = false;
  let clock = 0;
  const resolved = await awaitSystemResolution('manage.example.com', {
    notify: (line) => notices.push(line), seconds: 60,
    direct: async () => true, system: async () => systemAnswers,
    sleep: async () => { clock += 5_000; if (clock >= 15_000) systemAnswers = true; }, now: () => clock,
  });
  assert.equal(resolved, true);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /dscacheutil -flushcache/u);
  const expired = await awaitSystemResolution('manage.example.com', { seconds: 10, direct: async () => false, system: async () => false, sleep: async () => { clock += 5_000; }, now: () => clock });
  assert.equal(expired, false);
});
