import assert from 'node:assert/strict';
import test from 'node:test';

import { agentBearer, agentSourceSlugs, parseAgentBearer } from '../payload/worker/index.js';

const CLIENT_ID = `${'0123456789abcdef'.repeat(2)}.access`;
const SECRET = 'synthetic-secret-0123456789abcdef';

function encode(text) {
  return Buffer.from(text).toString('base64url');
}

test('an agent bearer is the prefix and base64url of client id, colon, secret', () => {
  const bearer = agentBearer(CLIENT_ID, SECRET);
  assert.equal(bearer, `ankka_agent_v1_${encode(`${CLIENT_ID}:${SECRET}`)}`);
  assert.match(bearer, /^[A-Za-z0-9_-]+$/u);
  assert.deepEqual(parseAgentBearer(`Bearer ${bearer}`), { clientId: CLIENT_ID, clientSecret: SECRET });
  assert.deepEqual(parseAgentBearer(`bearer ${bearer}`), { clientId: CLIENT_ID, clientSecret: SECRET });
  // The client id never holds a colon, so a secret may.
  assert.equal(parseAgentBearer(`Bearer ${agentBearer(CLIENT_ID, `${SECRET}:part`)}`).clientSecret, `${SECRET}:part`);
});

test('anything else is not an agent bearer', () => {
  for (const value of [
    undefined, '', 'Bearer', `Basic ${encode(`${CLIENT_ID}:${SECRET}`)}`, `Bearer ${encode(`${CLIENT_ID}:${SECRET}`)}`,
    `Bearer ankka_agent_v2_${encode(`${CLIENT_ID}:${SECRET}`)}`, `Bearer ankka_agent_v1_${encode(`${CLIENT_ID}:${SECRET}`)}=`,
    `Bearer ankka_agent_v1_${encode(`${CLIENT_ID}:${SECRET}`)} extra`, `Bearer ankka_agent_v1_${encode(`${CLIENT_ID}${SECRET}`)}`,
    `Bearer ankka_agent_v1_${encode(`:${SECRET}`)}`, `Bearer ankka_agent_v1_${encode(`${'g'.repeat(32)}.access:${SECRET}`)}`,
    `Bearer ankka_agent_v1_${encode(`${CLIENT_ID}:short`)}`, `Bearer ankka_agent_v1_${encode(`${CLIENT_ID}:${SECRET} with space`)}`,
    `Bearer ankka_agent_v1_${encode(`${CLIENT_ID}:${'s'.repeat(513)}`)}`, `Bearer ankka_agent_v1_${encode(`${CLIENT_ID}:sécret-0123456789abcdef`)}`,
    `Bearer ankka_agent_v1_${'a'.repeat(1100)}`,
  ]) assert.equal(parseAgentBearer(value), null, String(value));
});

test('each connector gets a readable prefix that is unique and never contains a double underscore', () => {
  const slugs = agentSourceSlugs([
    { id: 'source-0000000000000004', label: 'Klaviyo' },
    { id: 'source-0000000000000001', label: 'Klaviyo' },
    { id: 'source-0000000000000002', label: 'Meta Ads' },
    { id: 'source-0000000000000003', label: 'Möller & Söhne — Lagerbestand und Lieferungen' },
    { id: 'source-0000000000000005', label: '!!!' },
    { id: 'source-0000000000000006', label: 'LUNA BLS · Sales' },
  ]);
  assert.deepEqual(Object.fromEntries(slugs), {
    'source-0000000000000001': 'klaviyo',
    'source-0000000000000002': 'meta_ads',
    'source-0000000000000003': 'moller_sohne_lagerbestan',
    'source-0000000000000004': 'klaviyo_2',
    'source-0000000000000005': 'source',
    'source-0000000000000006': 'luna_bls_sales',
  });
  for (const slug of slugs.values()) assert.match(slug, /^[a-z0-9]+(?:_[a-z0-9]+)*$/u);
});
