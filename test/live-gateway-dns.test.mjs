import assert from 'node:assert/strict';
import test from 'node:test';
import { awaitSystemResolution, hostnameResolvesDirectly } from '../tools/live-gateway-dns.mjs';

test('direct resolution asks the configured servers then 1.1.1.1, tries A and AAAA, and never throws', async () => {
  const asked = [];
  const resolver = (server) => async (hostname, type) => {
    asked.push(`${server} ${type} ${hostname}`);
    if (server === '1.1.1.1' && type === 'AAAA') return ['2606:4700::1'];
    const error = new Error('queryA ENOTFOUND'); error.code = 'ENOTFOUND'; throw error;
  };
  assert.equal(await hostnameResolvesDirectly('manage.example.com', { servers: ['100.100.100.100', 'fd7a::53'], resolver }), true);
  assert.deepEqual(asked, ['100.100.100.100 A manage.example.com', '100.100.100.100 AAAA manage.example.com', '1.1.1.1 A manage.example.com', '1.1.1.1 AAAA manage.example.com']);
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
