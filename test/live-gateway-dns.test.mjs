import assert from 'node:assert/strict';
import test from 'node:test';
import { hostnameResolvesDirectly } from '../tools/live-gateway-dns.mjs';

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
