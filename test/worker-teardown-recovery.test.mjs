import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';

import { AdminState } from '../payload/worker/index.js';
import {
  ACCOUNT_ID,
  ZONE_ID,
  canonicalJson,
  cloudflareProvider,
  installReadyGateway,
  prefixedSha256,
  withProviderFetch,
} from './payload-lifecycle.mjs';

// Dependency removal after an interruption, against the real Worker, a fake
// provider and fake Durable Object storage. The compiled gateway runs the
// bounded executor (`managed.bounded === true`, one provider step per callback
// pass); the plain executor removes everything in one pass. Both keep the
// same journal: a removed-key prefix and one pending deletion boundary.
const REMOVAL_ORDER = Object.freeze(['dns_record', 'portal_access_policy', 'portal_access_application', 'portal',
  'source_access_policy', 'source_access_application', 'mcp_server']);
const ACCESS_KINDS = Object.freeze(['portal_access_policy', 'portal_access_application',
  'source_access_policy', 'source_access_application']);
const ADMIN = 'admin@example.com';
const GRANT = 'synthetic-teardown-grant-never-store';
const PROGRESS_KEY = 'ankka-mcp-gateway/root-teardown-progress/v1';
const SOURCES_KEY = 'ankka-mcp-gateway/management-sources/v1';
const PORTALS = `/client/v4/accounts/${ACCOUNT_ID}/access/ai-controls/mcp/portals`;
const FOREIGN_PORTAL = 'foreign-portal';
const EXECUTORS = Object.freeze([['bounded', true], ['plain', false]]);

function envelope(result, status = 200) {
  return Response.json({ success: status >= 200 && status < 300, errors: [], messages: [], result }, { status });
}

function resourcePath(resource) {
  const { id, parentId } = resource.provider;
  if (resource.kind === 'mcp_server') return `/client/v4/accounts/${ACCOUNT_ID}/access/ai-controls/mcp/servers/${id}`;
  if (resource.kind === 'portal') return `${PORTALS}/${id}`;
  if (resource.kind === 'dns_record') return `/client/v4/zones/${ZONE_ID}/dns_records/${id}`;
  if (parentId === undefined) return `/client/v4/zones/${ZONE_ID}/access/apps/${id}`;
  return `/client/v4/zones/${ZONE_ID}/access/apps/${parentId}/policies/${id}`;
}

function providerObject(state, resource) {
  const { id, parentId } = resource.provider;
  if (resource.kind === 'dns_record') return state.dns;
  if (resource.kind === 'portal') return state.portal;
  if (resource.kind === 'mcp_server') return state.servers.get(id) ?? null;
  if (parentId === undefined) return state.apps.get(id) ?? null;
  return state.policies.get(parentId)?.find((policy) => policy.id === id) ?? null;
}

/** Apply a deletion to the fake exactly as its own DELETE handler would. */
function applyDeletion(state, resource) {
  const { id, parentId } = resource.provider;
  if (resource.kind === 'dns_record') state.dns = null;
  else if (resource.kind === 'portal') state.portal = null;
  else if (resource.kind === 'mcp_server') { state.servers.delete(id); state.server = null; }
  else if (parentId === undefined) { state.apps.delete(id); state.policies.delete(id); }
  else state.policies.set(parentId, state.policies.get(parentId).filter((policy) => policy.id !== id));
}

/** The one provider field whose change turns an exact ownership read into a conflict. */
function driftField(kind) {
  if (kind === 'dns_record') return 'comment';
  if (kind === 'portal' || kind === 'mcp_server') return 'description';
  return 'name';
}

async function fixture(run, { bounded = true } = {}) {
  const provider = cloudflareProvider();
  const gateway = await installReadyGateway({ provider });
  const { installationId } = gateway.readyReceipt;
  const resources = REMOVAL_ORDER.map((kind) => gateway.readyReceipt.resources.find((resource) => resource.kind === kind));
  const paths = resources.map(resourcePath);
  const managed = bounded ? { describe: async () => null, bounded: true } : null;
  // Instances keep their operation queue; a restart drops them and keeps only
  // durable storage, as an evicted Worker would.
  const instances = new Map();
  const instance = (name) => {
    if (!instances.has(name)) instances.set(name, new AdminState({ storage: gateway.objects.get(name).storage }, gateway.env, managed));
    return instances.get(name);
  };
  gateway.env.ADMIN_STATE = { idFromName: (name) => name, get: (name) => ({ fetch: (request) => instance(name).fetch(request) }) };
  const management = gateway.env.ADMIN_STATE.get('v1:management');
  const managementStorage = gateway.objects.get('v1:management').storage;
  const post = (path, body, headers = {}) => new Request(`https://admin-state.invalid${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: canonicalJson(body),
  });
  let hook;
  provider.intercept((context) => hook?.(context));
  const network = async (request) => {
    const response = await provider.fetch(request);
    provider.requests.at(-1).status = response.status;
    return response;
  };
  async function consent(seed) {
    const key = Buffer.alloc(32, seed).toString('base64url');
    const issuedAt = Date.now();
    const proposal = { schemaVersion: 1, actionId: `action_${String.fromCharCode(65 + seed).repeat(32)}`,
      actionKeyHash: await prefixedSha256(key), actorEmail: ADMIN, installationId, issuedAt, expiresAt: issuedAt + 600_000 };
    const prepared = await management.fetch(post('/teardown-actions/prepare-current', proposal));
    async function send(command, requestId) {
      const claim = { schemaVersion: 1, command, actionId: proposal.actionId, actionKey: key, actorEmail: ADMIN,
        accountId: ACCOUNT_ID, installationId, issuedAt: Date.now(), expiresAt: proposal.expiresAt };
      if (command === 'apply') Object.assign(claim, { requestId, cloudflareAccessToken: GRANT });
      const body = canonicalJson(claim);
      const signature = `sha256=${createHmac('sha256', Buffer.from(key, 'base64url')).update(body).digest('hex')}`;
      return management.fetch(post(`/teardown-actions/${command}-current`, claim, { 'x-ankka-teardown-action-signature': signature }));
    }
    return {
      actionId: proposal.actionId, prepared, send,
      // One callback: the same request identity until completion, a refusal or the pass budget.
      async apply(requestId, passes = 768) {
        const seen = new Set();
        let last;
        for (let pass = 1; pass <= passes; pass++) {
          const response = await send('apply', requestId);
          const body = await response.json();
          last = { status: response.status, body, passes: pass };
          if (response.status !== 200 || body.status !== 'removing') return last;
          assert.ok(!seen.has(body.progress), 'every pass must advance the recorded progress');
          seen.add(body.progress);
        }
        return { ...last, interrupted: true };
      },
      async status() {
        return (await management.fetch(new Request(`https://admin-state.invalid/teardown-actions/${proposal.actionId}`))).json();
      },
    };
  }
  const requests = (from = 0) => provider.requests.slice(from);
  return withProviderFetch(network, () => run({
    gateway, provider, resources, paths, managementStorage, consent, requests,
    root: () => gateway.storage.snapshot(),
    progress: () => gateway.storage.snapshot(PROGRESS_KEY),
    deletes: (from = 0) => requests(from).filter(({ method }) => method === 'DELETE').map(({ pathname }) => pathname),
    hook(next) { hook = next; },
    restart() { instances.clear(); },
    /** Every request on one resource's exact provider path, in order. */
    touches: (index, from = 0) => requests(from).filter(({ pathname }) => pathname === paths[index]).map(({ method }) => method),
  }));
}

/** A fresh consent: prepared, proven, and applied under a new request identity. */
async function freshConsent(t, seed, requestId = String.fromCharCode(65 + seed).repeat(22)) {
  const consent = await t.consent(seed);
  assert.equal(consent.prepared.status, 200, await consent.prepared.clone().text());
  assert.equal((await consent.send('prove')).status, 200);
  return { consent, result: await consent.apply(requestId) };
}

/** Removal completed: the completion, the provider and the journal agree, and no DELETE hit an absent resource. */
function assertCompleted(t, result) {
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual([result.body.status, result.body.removedResourceCount], ['gateway_removed', 7]);
  assert.equal(result.body.readyReceiptChecksum, t.gateway.readyReceipt.checksum);
  assert.equal(result.body.dependencyResourcesHash, t.root().teardown.resourcesHash);
  assert.equal(t.provider.liveResourceCount(), 0);
  assert.deepEqual([t.root().status, t.root().teardown.status, t.root().teardown.pending], ['removed', 'removed', null]);
  assert.deepEqual(t.root().receipt, t.gateway.readyReceipt, 'the immutable receipt survives removal');
  assert.deepEqual(t.requests().filter(({ method, status }) => method === 'DELETE' && status === 404), [],
    'no DELETE may reach a resource that was already absent');
}

/**
 * An interrupted attempt ends and a fresh consent is possible at once. A removed dependency or a pending DELETE keeps
 * the journal intact and the attempt recovery-required; without either, the root is its ready receipt again and the
 * attempt failed.
 */
async function settleInterrupted(t, consent) {
  const before = t.root();
  const started = before.teardown !== undefined && (before.teardown.removedKeys.length > 0 || before.teardown.pending !== null);
  const settled = await consent.send('settle');
  assert.equal(settled.status, 200, await settled.clone().text());
  assert.equal((await settled.json()).status, started ? 'recovery_required' : 'failed');
  if (started) assert.deepEqual(t.root(), before, 'settling keeps the receipt and the deletion boundary');
  else {
    assert.deepEqual(t.root(), t.gateway.readyReceipt, 'nothing was deleted or armed, so the ready receipt returns');
    assert.equal(t.progress(), undefined, 'no pass progress outlives the attempt');
  }
  assert.equal((await consent.status()).status, started ? 'recovery_required' : 'failed');
  return before;
}

function boundary(t) {
  const { teardown } = t.root();
  return { removed: teardown.removedKeys.length, pending: teardown.pending === null ? null
    : { index: teardown.removedKeys.length, phase: teardown.pending.phase, requestId: teardown.pending.requestId } };
}

/** The n-th request of one method on one exact path answers with `respond`, once. */
function answerOnce(t, index, method, nth, respond) {
  let seen = 0;
  t.hook(({ record, state }) => {
    if (record.method !== method || record.pathname !== t.paths[index] || ++seen !== nth) return undefined;
    t.hook(undefined);
    return respond(state);
  });
}

function foreignPortalHook(t, { mapped, once = false } = {}) {
  const serverId = t.resources[REMOVAL_ORDER.indexOf('mcp_server')].provider.id;
  let listed = false;
  t.hook(({ record, state }) => {
    if (record.method !== 'GET') return undefined;
    if (record.pathname === PORTALS && !(once && listed)) {
      listed = true;
      return envelope([...(state.portal ? [state.portal] : []), { id: FOREIGN_PORTAL }]);
    }
    if (record.pathname === `${PORTALS}/${FOREIGN_PORTAL}`) return envelope({ id: FOREIGN_PORTAL, servers: mapped ? [{ server_id: serverId }] : [] });
    return undefined;
  });
}

test('the bounded executor removes the seven dependencies one provider step per pass and verifies absence', async () => fixture(async (t) => {
  const consent = await t.consent(1);
  assert.equal(consent.prepared.status, 200, await consent.prepared.clone().text());
  assert.equal((await consent.send('prove')).status, 200);
  const phases = [];
  const requestId = 'B'.repeat(22);
  let result;
  for (let pass = 1; pass <= 100; pass++) {
    const response = await consent.send('apply', requestId);
    result = { status: response.status, body: await response.json(), passes: pass };
    phases.push(t.progress().phase);
    if (result.body.status !== 'removing') break;
  }
  assertCompleted(t, result);
  assert.deepEqual([...new Set(phases)], ['sharing_preflight', 'preflight', 'remove', 'sharing_delete', 'delete', 'verify', 'complete']);
  assert.equal(result.passes, 27);
  assert.deepEqual(t.deletes(), t.paths, 'exactly one DELETE per dependency, in dependency order');
  assert.deepEqual(t.progress().requestId, requestId);
}));

test('the plain executor removes every dependency within one pass', async () => fixture(async (t) => {
  const { result } = await freshConsent(t, 1);
  assertCompleted(t, result);
  assert.equal(result.passes, 1);
  assert.deepEqual(t.deletes(), t.paths);
}, { bounded: false }));

// A callback can die at any pass boundary: the grant expires, the Worker is
// evicted, or the browser never follows the redirect. Every boundary of the
// bounded executor must resume under fresh consent without a repeated DELETE.
// Each boundary is settled; the ones that enter a phase are also left to
// expire unsettled, as a callback that died without reaching its settlement.
const EXPIRED_BOUNDARIES = new Set([1, 2, 9, 10, 16, 17, 18, 19, 20, 26]);
for (let interruptedAfter = 1; interruptedAfter < 27; interruptedAfter++) {
  for (const release of EXPIRED_BOUNDARIES.has(interruptedAfter) ? ['settled', 'expired'] : ['settled']) {
    test(`bounded removal interrupted after pass ${interruptedAfter} (${release}) resumes under fresh consent`, async (context) => fixture(async (t) => {
      const first = await t.consent(1);
      assert.equal(first.prepared.status, 200);
      assert.equal((await first.send('prove')).status, 200);
      const interrupted = await first.apply('B'.repeat(22), interruptedAfter);
      assert.equal(interrupted.interrupted, true);
      assert.equal(t.root().status, 'tearing_down');
      const journal = boundary(t);
      assert.equal(journal.pending, null, 'a pass ends at a clean boundary');
      const deletesBefore = t.deletes().length;
      assert.equal(deletesBefore, journal.removed);
      if (release === 'settled') await settleInterrupted(t, first);
      else {
        // The callback never settled: the action lock expires with the grant.
        const later = Date.now() + 600_001;
        context.mock.method(Date, 'now', () => later);
        assert.equal((await first.send('apply', 'B'.repeat(22))).status, 409);
      }
      t.restart();
      const { consent, result } = await freshConsent(t, 2);
      assertCompleted(t, result);
      assert.equal(t.progress().requestId, 'C'.repeat(22), 'progress belongs to the resumed request');
      assert.deepEqual(t.deletes(), t.paths, 'a verified-absent dependency is never deleted twice');
      assert.equal((await consent.status()).status, 'gateway_removed');
      assert.equal((await first.send('apply', 'B'.repeat(22))).status, 409, 'the interrupted action stays closed');
    }));
  }
}

for (const [executor, bounded] of EXECUTORS) {
  // A lost DELETE response (5xx, 429, transport failure) leaves `send_armed`.
  // The provider may or may not have applied the deletion.
  for (let index = 0; index < REMOVAL_ORDER.length; index++) {
    for (const applied of [false, true]) {
      test(`${executor}: unknown DELETE response at ${REMOVAL_ORDER[index]} (${applied ? 'applied' : 'not applied'}) resumes from send_armed`, async () => fixture(async (t) => {
        answerOnce(t, index, 'DELETE', 1, (state) => {
          if (applied) applyDeletion(state, t.resources[index]);
          return envelope(null, 503);
        });
        const first = await t.consent(1);
        assert.equal((await first.send('prove')).status, 200);
        assert.equal((await first.apply('B'.repeat(22))).status, 409);
        assert.deepEqual(boundary(t), { removed: index, pending: { index, phase: 'send_armed', requestId: 'B'.repeat(22) } });
        assert.equal(t.deletes().length, index + 1);
        if (!applied) {
          // The same grant re-reads the armed resource; while it is present it
          // never resends the DELETE whose outcome is unknown.
          const retried = t.requests().length;
          t.restart();
          assert.equal((await first.send('apply', 'B'.repeat(22))).status, 409);
          assert.deepEqual(t.deletes(retried), [], 'no resend under the same grant');
          assert.deepEqual(boundary(t), { removed: index, pending: { index, phase: 'send_armed', requestId: 'B'.repeat(22) } });
        }
        await settleInterrupted(t, first);
        const fresh = t.requests().length;
        const { result } = await freshConsent(t, 2);
        assertCompleted(t, result);
        assert.equal(t.touches(index, fresh)[0], 'GET', 'the boundary is re-read before anything else');
        assert.deepEqual(t.deletes(), applied ? t.paths : [...t.paths.slice(0, index + 1), ...t.paths.slice(index)]);
      }, { bounded }));
    }
  }

  // Access accepts deletions asynchronously with HTTP 202. Acceptance is not
  // absence: the attempt stops at `submitted`; fresh consent re-reads first.
  for (const kind of ACCESS_KINDS) {
    const index = REMOVAL_ORDER.indexOf(kind);
    for (const settledAtProvider of [true, false]) {
      test(`${executor}: 202 at ${kind} still present on re-read stops at submitted; fresh consent finds it ${settledAtProvider ? 'absent' : 'present'}`, async () => fixture(async (t) => {
        answerOnce(t, index, 'DELETE', 1, () => envelope(null, 202));
        const first = await t.consent(1);
        assert.equal((await first.send('prove')).status, 200);
        assert.equal((await first.apply('B'.repeat(22))).status, 409);
        assert.deepEqual(boundary(t), { removed: index, pending: { index, phase: 'submitted', requestId: 'B'.repeat(22) } });
        assert.equal(t.provider.liveResourceCount(), 7 - index);
        const retried = t.requests().length;
        t.restart();
        assert.equal((await first.send('apply', 'B'.repeat(22))).status, 409);
        assert.deepEqual(t.deletes(retried), [], 'restarting the runtime does not resend the submitted deletion under the same grant');
        await settleInterrupted(t, first);
        if (settledAtProvider) applyDeletion(t.provider.state, t.resources[index]);
        const fresh = t.requests().length;
        const { result } = await freshConsent(t, 2);
        assertCompleted(t, result);
        const touches = t.touches(index, fresh);
        assert.equal(touches[0], 'GET', 'a submitted boundary is re-read before any DELETE');
        assert.deepEqual(t.deletes(), settledAtProvider ? t.paths : [...t.paths.slice(0, index + 1), ...t.paths.slice(index)]);
        if (!settledAtProvider) assert.deepEqual(touches.slice(0, 3), ['GET', 'GET', 'DELETE']);
      }, { bounded }));
    }
  }

  test(`${executor}: 202 for a non-Access DELETE is a rejection that leaves not_applied`, async () => fixture(async (t) => {
    answerOnce(t, 0, 'DELETE', 1, () => envelope(null, 202));
    const first = await t.consent(1);
    assert.equal((await first.send('prove')).status, 200);
    assert.equal((await first.apply('B'.repeat(22))).status, 409);
    assert.deepEqual(boundary(t), { removed: 0, pending: { index: 0, phase: 'not_applied', requestId: 'B'.repeat(22) } });
    await settleInterrupted(t, first);
    const { result } = await freshConsent(t, 2);
    assertCompleted(t, result);
    assert.deepEqual(t.deletes(), [t.paths[0], ...t.paths]);
  }, { bounded }));

  // A rejected DELETE (401/403 or 4xx) records `not_applied`: the deletion
  // was not performed, so a fresh grant sends it again after a fresh read.
  for (const [label, status] of [['auth', 403], ['blocked', 400]]) {
    for (const index of [0, 3, 6]) {
      test(`${executor}: ${label} DELETE at ${REMOVAL_ORDER[index]} leaves not_applied and is re-sent under fresh consent`, async () => fixture(async (t) => {
        answerOnce(t, index, 'DELETE', 1, () => envelope(null, status));
        const first = await t.consent(1);
        assert.equal((await first.send('prove')).status, 200);
        assert.equal((await first.apply('B'.repeat(22))).status, 409);
        assert.deepEqual(boundary(t), { removed: index, pending: { index, phase: 'not_applied', requestId: 'B'.repeat(22) } });
        assert.equal(t.provider.liveResourceCount(), 7 - index);
        await settleInterrupted(t, first);
        const fresh = t.requests().length;
        const { result } = await freshConsent(t, 2);
        assertCompleted(t, result);
        assert.deepEqual(t.touches(index, fresh).slice(0, 3), bounded || index === 0 ? ['GET', 'GET', 'DELETE'] : ['GET', 'GET', 'DELETE']);
        assert.deepEqual(t.deletes(), [...t.paths.slice(0, index + 1), ...t.paths.slice(index)]);
      }, { bounded }));
    }
  }

  // A read can fail transiently at three points: the preflight, the read
  // before arming, and the verification after a DELETE. None may be taken as
  // absence; each stops the attempt with the journal still exact.
  for (let index = 0; index < REMOVAL_ORDER.length; index++) {
    for (const [label, nth] of [['preflight read', 1], ['read before arming', 2], ['verification after DELETE', 3]]) {
      test(`${executor}: unknown ${label} at ${REMOVAL_ORDER[index]} stops without inventing absence and resumes`, async () => fixture(async (t) => {
        answerOnce(t, index, 'GET', nth, () => envelope(null, 503));
        const first = await t.consent(1);
        assert.equal((await first.send('prove')).status, 200);
        assert.equal((await first.apply('B'.repeat(22))).status, 409);
        const expected = nth === 1 ? { removed: 0, pending: null } : nth === 2 ? { removed: index, pending: null }
          : { removed: index, pending: { index, phase: 'submitted', requestId: 'B'.repeat(22) } };
        assert.deepEqual(boundary(t), expected);
        assert.equal(t.deletes().length, nth === 1 ? 0 : nth === 2 ? index : index + 1);
        await settleInterrupted(t, first);
        const fresh = t.requests().length;
        const { result } = await freshConsent(t, 2);
        assertCompleted(t, result);
        assert.equal(t.touches(index, fresh)[0], 'GET');
        assert.deepEqual(t.deletes(), t.paths, 'a deletion whose verification was lost is confirmed by reading, not repeated');
      }, { bounded }));
    }
  }

  test(`${executor}: an unknown Portal catalogue read stops the sharing check before any deletion`, async () => fixture(async (t) => {
    let failed = false;
    t.hook(({ record }) => {
      if (failed || record.method !== 'GET' || record.pathname !== PORTALS) return undefined;
      failed = true;
      return envelope(null, 503);
    });
    const first = await t.consent(1);
    assert.equal((await first.send('prove')).status, 200);
    assert.equal((await first.apply('B'.repeat(22))).status, 409);
    assert.deepEqual([t.deletes(), boundary(t)], [[], { removed: 0, pending: null }]);
    await settleInterrupted(t, first);
    const { result } = await freshConsent(t, 2);
    assertCompleted(t, result);
    assert.deepEqual(t.deletes(), t.paths);
  }, { bounded }));

  test(`${executor}: an unknown Access children listing stops before deleting the application`, async () => fixture(async (t) => {
    const index = REMOVAL_ORDER.indexOf('portal_access_application');
    let failed = false;
    t.hook(({ record }) => {
      if (failed || record.method !== 'GET' || record.pathname !== `${t.paths[index]}/policies`) return undefined;
      failed = true;
      return envelope(null, 503);
    });
    const first = await t.consent(1);
    assert.equal((await first.send('prove')).status, 200);
    assert.equal((await first.apply('B'.repeat(22))).status, 409);
    assert.deepEqual([t.deletes(), boundary(t)], [[], { removed: 0, pending: null }]);
    await settleInterrupted(t, first);
    const { result } = await freshConsent(t, 2);
    assertCompleted(t, result);
    assert.deepEqual(t.deletes(), t.paths);
  }, { bounded }));

  // An ownership conflict stops every consent: nothing is deleted while the
  // exact read disagrees with the receipt, before or after earlier deletions,
  // until the resource reads exactly again. Before the first deletion the
  // attempt settles failed and holds no lock; after it, recovery-required.
  for (let index = 0; index < REMOVAL_ORDER.length; index++) {
    for (const when of ['before any deletion', 'after the earlier deletions']) {
      test(`${executor}: ownership conflict at ${REMOVAL_ORDER[index]} ${when} stops every consent until the read is exact again`, async () => fixture(async (t) => {
        const resource = t.resources[index];
        const drift = () => t.hook(({ record, state }) => {
          if (record.method !== 'GET' || record.pathname !== t.paths[index]) return undefined;
          if (when === 'after the earlier deletions' && t.deletes().length < index) return undefined;
          return envelope({ ...providerObject(state, resource), [driftField(resource.kind)]: 'foreign' });
        });
        drift();
        const first = await t.consent(1);
        assert.equal((await first.send('prove')).status, 200);
        assert.equal((await first.apply('B'.repeat(22))).status, 409);
        const deletesBefore = when === 'before any deletion' ? 0 : index;
        assert.deepEqual(boundary(t), { removed: deletesBefore, pending: null });
        assert.equal(t.deletes().length, deletesBefore);
        await settleInterrupted(t, first);
        const { consent: second, result: refused } = await freshConsent(t, 2);
        assert.equal(refused.status, 409, 'a conflicting read is never deleted');
        assert.deepEqual(boundary(t), { removed: deletesBefore, pending: null });
        assert.equal(t.deletes().length, deletesBefore);
        await settleInterrupted(t, second);
        t.hook(undefined);
        const { result } = await freshConsent(t, 3);
        assertCompleted(t, result);
        assert.deepEqual(t.deletes(), t.paths);
      }, { bounded }));
    }
  }

  // A foreign Portal that maps the gateway's server keeps the server (and the
  // rest of the graph) in place until it is unmapped.
  for (const when of ['before any deletion', 'before the server deletion']) {
    test(`${executor}: a foreign Portal mapping the server ${when} stops removal until unmapped`, async () => fixture(async (t) => {
      const serverIndex = REMOVAL_ORDER.indexOf('mcp_server');
      const beforeServer = when === 'before the server deletion';
      const arm = () => {
        if (!beforeServer) return foreignPortalHook(t, { mapped: true });
        t.hook(({ record, state }) => {
          if (record.method !== 'GET' || t.deletes().length < serverIndex) return undefined;
          if (record.pathname === PORTALS) return envelope([...(state.portal ? [state.portal] : []), { id: FOREIGN_PORTAL }]);
          if (record.pathname === `${PORTALS}/${FOREIGN_PORTAL}`) return envelope({ id: FOREIGN_PORTAL, servers: [{ id: t.resources[serverIndex].provider.id }] });
          return undefined;
        });
      };
      arm();
      const first = await t.consent(1);
      assert.equal((await first.send('prove')).status, 200);
      assert.equal((await first.apply('B'.repeat(22))).status, 409);
      const deletesBefore = beforeServer ? serverIndex : 0;
      // The bounded executor rechecks sharing before arming; the plain one
      // arms first, so its unsent DELETE leaves an armed boundary that the
      // next exact read resolves.
      assert.deepEqual(boundary(t), { removed: deletesBefore, pending: beforeServer && !bounded
        ? { index: serverIndex, phase: 'send_armed', requestId: 'B'.repeat(22) } : null });
      assert.equal(t.deletes().length, deletesBefore);
      assert.ok(t.provider.state.servers.size === 1, 'a shared server is never deleted');
      await settleInterrupted(t, first);
      const { consent: second, result: refused } = await freshConsent(t, 2);
      assert.equal(refused.status, 409);
      assert.equal(t.deletes().length, deletesBefore);
      await settleInterrupted(t, second);
      foreignPortalHook(t, { mapped: false });
      const { result } = await freshConsent(t, 3);
      assertCompleted(t, result);
      assert.deepEqual(t.deletes(), t.paths);
    }, { bounded }));
  }

  test(`${executor}: a settled attempt that never reached the root releases the lock without a journal`, async () => fixture(async (t) => {
    const first = await t.consent(1);
    assert.equal((await first.send('prove')).status, 200);
    await settleInterrupted(t, first);
    assert.deepEqual(t.root(), t.gateway.readyReceipt, 'the untouched root is still the bare ready receipt');
    const { result } = await freshConsent(t, 2);
    assertCompleted(t, result);
  }, { bounded }));

  // The journal binds to one exact dependency graph. A journal recorded under
  // another graph identity is never resumed: fresh consent stops cleanly.
  test(`${executor}: a journal recorded for another dependency graph is not resumed`, async () => fixture(async (t) => {
    answerOnce(t, 3, 'DELETE', 1, () => envelope(null, 503));
    const first = await t.consent(1);
    assert.equal((await first.send('prove')).status, 200);
    assert.equal((await first.apply('B'.repeat(22))).status, 409);
    await settleInterrupted(t, first);
    const root = t.root();
    await t.gateway.storage.put('ankka-mcp-gateway/uninstall-state/v1', { ...root,
      teardown: { ...root.teardown, resourcesHash: `sha256:${'0'.repeat(64)}` } });
    const deletesBefore = t.deletes().length;
    const { result } = await freshConsent(t, 2);
    assert.equal(result.status, 409);
    assert.equal(t.deletes().length, deletesBefore);
    assert.equal(t.provider.liveResourceCount(), 7 - 3);
  }, { bounded }));

  test(`${executor}: a source draft saved between consents does not strand the recorded removal`, async () => fixture(async (t) => {
    answerOnce(t, 3, 'DELETE', 1, () => envelope(null, 503));
    const first = await t.consent(1);
    assert.equal((await first.send('prove')).status, 200);
    assert.equal((await first.apply('B'.repeat(22))).status, 409);
    await settleInterrupted(t, first);
    const sources = t.managementStorage.snapshot(SOURCES_KEY);
    const saved = await t.gateway.env.ADMIN_STATE.get('v1:management').fetch(new Request('https://admin-state.invalid/sources', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: canonicalJson({ schemaVersion: 1, revision: sources.revision,
        source: { label: 'Draft catalogue', url: 'https://catalog.example.net/mcp', authMode: 'none', enabledTools: ['company_lookup'] } }),
    }));
    assert.equal(saved.status, 200, await saved.clone().text());
    assert.notEqual(t.managementStorage.snapshot(SOURCES_KEY).revision, sources.revision);
    const { result } = await freshConsent(t, 2);
    assertCompleted(t, result);
    // The lost Portal DELETE was never applied, so the exact re-read sends it once more.
    assert.deepEqual(t.deletes(), [...t.paths.slice(0, 4), ...t.paths.slice(3)]);
  }, { bounded }));
}
