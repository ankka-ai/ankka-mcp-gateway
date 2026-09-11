import assert from 'node:assert/strict';
import test from 'node:test';
import { awaitSystemResolution, hostnameResolvesDirectly } from '../tools/live-gateway-dns.mjs';

test('direct resolution asks only the zone\'s authoritative servers: a negative answer from any of them is not served, an unreachable one is skipped', async () => {
  const asked = [];
  const behaviour = new Map();
  const resolver = (server) => async (hostname, type) => {
    asked.push(`${server} ${type}`);
    const mode = behaviour.get(server) ?? 'negative';
    if (mode === 'records') return type === 'AAAA' ? ['2606:4700::1'] : ['104.16.0.1'];
    const error = new Error(mode === 'negative' ? 'queryA ENOTFOUND' : 'queryA ETIMEOUT'); error.code = mode === 'negative' ? 'ENOTFOUND' : 'ETIMEOUT'; throw error;
  };
  const nameservers = async (zone) => { asked.push(`ns ${zone}`); return ['173.245.58.1', '173.245.59.1']; };
  behaviour.set('173.245.58.1', 'records');
  // One authoritative server still denies the name: not served yet, and the second server is not even asked.
  assert.equal(await hostnameResolvesDirectly('manage.example.com', { zone: 'example.com', resolver, nameservers, servers: ['173.245.59.1', '173.245.58.1'] }), false);
  assert.deepEqual(asked, ['173.245.59.1 A', '173.245.59.1 AAAA']);
  asked.length = 0; behaviour.set('173.245.59.1', 'records');
  assert.equal(await hostnameResolvesDirectly('manage.example.com', { zone: 'example.com', resolver, nameservers }), true);
  assert.deepEqual(asked, ['ns example.com', '173.245.58.1 A', '173.245.59.1 A']);
  // An unreachable server is skipped; a served answer from the other suffices, but no answer at all does not.
  asked.length = 0; behaviour.set('173.245.59.1', 'unreachable');
  assert.equal(await hostnameResolvesDirectly('manage.example.com', { zone: 'example.com', resolver, nameservers }), true);
  behaviour.set('173.245.58.1', 'unreachable');
  assert.equal(await hostnameResolvesDirectly('manage.example.com', { zone: 'example.com', resolver, nameservers }), false);
  assert.equal(await hostnameResolvesDirectly('manage.example.com', { zone: 'example.com', resolver, nameservers: async () => [] }), false);
});

test('the authoritative servers come from the zone\'s NS records, skipping a nameserver without an address', async () => {
  const { authoritativeServers } = await import('../tools/live-gateway-dns.mjs');
  const servers = await authoritativeServers('example.com', {
    resolveNs: async (zone) => { assert.equal(zone, 'example.com'); return ['a.ns.example.net', 'b.ns.example.net', 'c.ns.example.net']; },
    resolve4: async (name) => { if (name === 'c.ns.example.net') throw new Error('ENOTFOUND'); return name === 'a.ns.example.net' ? ['173.245.58.1'] : ['173.245.59.1', '173.245.58.1']; },
  });
  assert.deepEqual(servers, ['173.245.58.1', '173.245.59.1']);
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

test('the default resolver factory is wired: a server that refuses the query counts as unreachable, never as served', async () => {
  const { createResolver } = await import('../tools/live-gateway-dns.mjs');
  // The factory's resolver asks the given server; 127.0.0.1:53 refuses or times out on a developer machine, so the
  // name is not served and nothing throws, through the default factory as well as an explicit one.
  await assert.rejects(createResolver('127.0.0.1')('never.example.invalid', 'A'));
  assert.equal(await hostnameResolvesDirectly('never.example.invalid', { zone: 'example.invalid', servers: ['127.0.0.1'] }), false);
});
