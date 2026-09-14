import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:net';
import { awaitSystemResolution, createTcpResolver, decodeDnsAnswer, encodeDnsQuery, hostnameResolvesDirectly } from '../tools/live-gateway-dns.mjs';

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
  assert.equal(await hostnameResolvesDirectly('manage.example.com', { zone: 'example.com', resolver, tcpResolver: resolver, nameservers, servers: ['173.245.59.1', '173.245.58.1'] }), false);
  assert.deepEqual(asked, ['173.245.59.1 A', '173.245.59.1 AAAA']);
  asked.length = 0; behaviour.set('173.245.59.1', 'records');
  assert.equal(await hostnameResolvesDirectly('manage.example.com', { zone: 'example.com', resolver, tcpResolver: resolver, nameservers }), true);
  assert.deepEqual(asked, ['ns example.com', '173.245.58.1 A', '173.245.59.1 A']);
  // An unreachable server is skipped; a served answer from the other suffices, but no answer at all does not.
  asked.length = 0; behaviour.set('173.245.59.1', 'unreachable');
  assert.equal(await hostnameResolvesDirectly('manage.example.com', { zone: 'example.com', resolver, tcpResolver: resolver, nameservers }), true);
  behaviour.set('173.245.58.1', 'unreachable');
  assert.equal(await hostnameResolvesDirectly('manage.example.com', { zone: 'example.com', resolver, tcpResolver: resolver, nameservers }), false);
  assert.equal(await hostnameResolvesDirectly('manage.example.com', { zone: 'example.com', resolver, tcpResolver: resolver, nameservers: async () => [] }), false);
});

test('the authoritative servers come from the zone\'s NS records, skipping a nameserver without an address, cached per zone, and a failed NS lookup means not known', async () => {
  const { authoritativeServers } = await import('../tools/live-gateway-dns.mjs');
  let lookups = 0; const cache = new Map(); let clock = 1_000;
  const options = {
    cache, now: () => clock,
    resolveNs: async (zone) => { lookups += 1; assert.equal(zone, 'example.com'); return ['a.ns.example.net', 'b.ns.example.net', 'c.ns.example.net']; },
    resolve4: async (name) => { if (name === 'c.ns.example.net') throw new Error('ENOTFOUND'); return name === 'a.ns.example.net' ? ['173.245.58.1'] : ['173.245.59.1', '173.245.58.1']; },
  };
  assert.deepEqual(await authoritativeServers('example.com', options), ['173.245.58.1', '173.245.59.1']);
  assert.deepEqual(await authoritativeServers('example.com', options), ['173.245.58.1', '173.245.59.1']);
  assert.equal(lookups, 1);
  clock += 11 * 60_000;
  await authoritativeServers('example.com', options); assert.equal(lookups, 2);
  // A transient failure of the NS lookup itself is "not known yet", not an error thrown out of a wait loop.
  assert.deepEqual(await authoritativeServers('other.example', { cache: new Map(), resolveNs: async () => { throw new Error('ETIMEOUT'); }, resolve4: async () => [] }), []);
  assert.equal(await hostnameResolvesDirectly('manage.other.example', { zone: 'other.example', nameservers: async () => { throw new Error('ETIMEOUT'); } }).catch((error) => error.message), 'ETIMEOUT');
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

test('a server unreachable over UDP is asked the same question over TCP, and only then counts as unreachable', async () => {
  const udp = () => async () => { const error = new Error('queryA ETIMEOUT'); error.code = 'ETIMEOUT'; throw error; };
  const asked = [];
  const tcp = (mode) => (server) => async (hostname, type) => {
    asked.push(`tcp ${server} ${type}`);
    if (mode === 'records') return [type];
    const error = new Error(mode); error.code = mode === 'negative' ? 'ENOTFOUND' : 'ECONNREFUSED'; throw error;
  };
  const servers = ['173.245.58.1'];
  assert.equal(await hostnameResolvesDirectly('manage.example.com', { zone: 'example.com', servers, resolver: udp, tcpResolver: tcp('records') }), true);
  assert.deepEqual(asked, ['tcp 173.245.58.1 A']);
  assert.equal(await hostnameResolvesDirectly('manage.example.com', { zone: 'example.com', servers, resolver: udp, tcpResolver: tcp('negative') }), false);
  assert.equal(await hostnameResolvesDirectly('manage.example.com', { zone: 'example.com', servers, resolver: udp, tcpResolver: tcp('unreachable') }), false);
});

test('the TCP question and answer follow the wire format: framed query, and the resolver\'s own codes for a denied or empty name', () => {
  const query = encodeDnsQuery('a.example.com', 'AAAA', 0x1234);
  assert.equal(query.readUInt16BE(0), query.length - 2);
  assert.deepEqual([...query.subarray(2, 14)], [0x12, 0x34, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual([...query.subarray(14)], [1, 0x61, 7, ...Buffer.from('example'), 3, ...Buffer.from('com'), 0, 0, 28, 0, 1]);
  for (const [hostname, type, id] of [['', 'A', 1], ['-bad.example.com', 'A', 1], ['a.example.com', 'TXT', 1], ['a.example.com', 'A', 70000], [`${'a'.repeat(64)}.example.com`, 'A', 1]]) {
    assert.throws(() => encodeDnsQuery(hostname, type, id), { code: 'EBADQUERY' });
  }
  const response = (id, flags, answers) => { const b = Buffer.alloc(12); b.writeUInt16BE(id, 0); b.writeUInt16BE(flags, 2); b.writeUInt16BE(1, 4); b.writeUInt16BE(answers, 6); return b; };
  assert.equal(decodeDnsAnswer(response(7, 0x8180, 2), 7), 2);
  assert.throws(() => decodeDnsAnswer(response(7, 0x8183, 0), 7), { code: 'ENOTFOUND' });
  assert.throws(() => decodeDnsAnswer(response(7, 0x8180, 0), 7), { code: 'ENODATA' });
  assert.throws(() => decodeDnsAnswer(response(7, 0x8182, 0), 7), { code: 'ESERVFAIL' });
  assert.throws(() => decodeDnsAnswer(response(8, 0x8180, 1), 7), { code: 'EBADRESP' });
  assert.throws(() => decodeDnsAnswer(response(7, 0x0180, 1), 7), { code: 'EBADRESP' });
  assert.throws(() => decodeDnsAnswer(Buffer.alloc(4), 7), { code: 'EBADRESP' });
});

test('the TCP resolver talks to a nameserver over a length-framed stream and reports its outcome like the UDP resolver', async () => {
  let mode = 'records';
  const server = createServer((socket) => {
    socket.once('data', (chunk) => {
      if (mode === 'silent') return;
      if (mode === 'close') { socket.destroy(); return; }
      const id = chunk.readUInt16BE(2);
      const body = Buffer.alloc(12); body.writeUInt16BE(id, 0); body.writeUInt16BE(mode === 'nxdomain' ? 0x8183 : 0x8180, 2); body.writeUInt16BE(1, 4); body.writeUInt16BE(mode === 'records' ? 2 : 0, 6);
      const framed = Buffer.alloc(2 + body.length); framed.writeUInt16BE(body.length, 0); body.copy(framed, 2);
      // Two writes prove the reader waits for the whole frame.
      socket.write(framed.subarray(0, 5)); setTimeout(() => socket.write(framed.subarray(5)), 10);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const { connect } = await import('node:net');
  const resolve = createTcpResolver('127.0.0.1', { connect: () => connect({ host: '127.0.0.1', port }), timeoutMs: 300 });
  try {
    assert.deepEqual(await resolve('a.example.com', 'AAAA'), ['AAAA', 'AAAA']);
    mode = 'nxdomain'; await assert.rejects(resolve('a.example.com', 'A'), { code: 'ENOTFOUND' });
    mode = 'nodata'; await assert.rejects(resolve('a.example.com', 'A'), { code: 'ENODATA' });
    mode = 'close'; await assert.rejects(resolve('a.example.com', 'A'), { code: 'ECONNRESET' });
    mode = 'silent'; await assert.rejects(resolve('a.example.com', 'A'), { code: 'ETIMEOUT' });
    await assert.rejects(resolve('-bad', 'A'), { code: 'EBADQUERY' });
  } finally { server.close(); }
});
