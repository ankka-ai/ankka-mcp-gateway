import { describe, expect, it } from 'vitest';

import type { BoundaryObject } from '../src/boundary';
import worker from '../src/customer-gateway-entrypoint';
import { CUSTOMER_OPERATION_UPDATE_PATH, CUSTOMER_OPERATION_UPDATE_PROGRESS_PATH } from '../src/customer-install-paths';
import {
  CUSTOMER_SERVING_RELEASE_HEADER,
  DurableCustomerUpdateOutcomePort,
  customerServingRelease,
  withCustomerServingRelease,
  type CustomerUpdateOutcome,
} from '../src/customer-update-driver';

const ORIGIN = 'https://manage.example.com';
const ATTEMPT = `attempt_${'a'.repeat(24)}`;
const TOKEN = 'A'.repeat(43);
const OUTCOME_KEY = 'ankka-mcp-gateway/customer-update-outcome/v1';
const TARGET_KEY = 'ankka-mcp-gateway/customer-update-target/v1';

/** The stateless entrypoint of one release, in front of a management object that records what it is sent. */
function entrypoint(release: string) {
  const forwarded: Request[] = [];
  const namespace: DurableObjectNamespace = Object.create(null);
  Object.defineProperties(namespace, {
    idFromName: { value: (name: string) => name },
    get: { value: () => ({ fetch: async (request: Request) => { forwarded.push(request); return new Response('object'); } }) },
  });
  const context: ExecutionContext = Object.create(null);
  const env: Parameters<typeof worker.fetch>[1] = {
    API_LOADER: { get: () => { throw new Error("unexpected execution"); }, load: () => { throw new Error("unexpected execution"); } },
    ADMIN_STATE: namespace, ADMIN_EMAILS: 'admin@example.com', ANKKA_INSTALL_ID: `acg-${'b'.repeat(24)}`,
    ANKKA_GATEWAY_RELEASE: release, ANKKA_GATEWAY_RELEASE_SHA256: `sha256:${'f'.repeat(64)}`,
    ANKKA_MANAGEMENT_HOSTNAME: 'manage.example.com', ANKKA_UPDATE_CHANNEL: 'canary', ANKKA_UPDATE_KEY_ID: 'synthetic',
    ANKKA_UPDATE_PUBLIC_KEY: TOKEN, ANKKA_WORKERS_SUBDOMAIN: 'customer', ANKKA_WORKER_NAME: 'ankka-gateway',
    CF_ACCESS_AUD: 'c'.repeat(64), CF_ACCESS_ISSUER: 'https://team.cloudflareaccess.com', CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
    CLOUDFLARE_ZONE_ID: 'd'.repeat(32), CLOUDFLARE_ZONE_NAME: 'example.com', ZERO_TRUST_READY: 'true',
    ANKKA_GATEWAY_OWNERSHIP_WRAP_KEY: TOKEN,
  };
  return { forwarded, fetch: (request: Request) => worker.fetch(request, env, context) };
}

describe('the release that serves the update page', () => {
  it('is named by the stateless entrypoint that answers the browser, never by the browser', async () => {
    const edge = entrypoint('gateway-v0.1.34');
    const poll = `${ORIGIN}${CUSTOMER_OPERATION_UPDATE_PROGRESS_PATH}?attempt=${ATTEMPT}`;
    expect(await (await edge.fetch(new Request(poll, { headers: { cookie: 'CF_Authorization=session' } }))).text()).toBe('object');
    // What the browser claims is replaced: the object only ever reads what the entrypoint in front of it runs.
    await edge.fetch(new Request(poll, { headers: { [CUSTOMER_SERVING_RELEASE_HEADER]: 'gateway-v9.9.9' } }));
    expect(edge.forwarded.map((request) => [request.url, customerServingRelease(request)])).toEqual([
      [poll, 'gateway-v0.1.34'], [poll, 'gateway-v0.1.34'],
    ]);
    expect(edge.forwarded[0]?.headers.get('cookie')).toBe('CF_Authorization=session');

    // After the upload the same request reaches the same object through the new version's entrypoint.
    const updated = entrypoint('gateway-v0.1.35');
    await updated.fetch(new Request(poll));
    expect(updated.forwarded.map(customerServingRelease)).toEqual(['gateway-v0.1.35']);
  });

  it('leaves every other request to the management object as it arrived', async () => {
    const edge = entrypoint('gateway-v0.1.34');
    const page = new Request(`${ORIGIN}${CUSTOMER_OPERATION_UPDATE_PATH}?attempt=${ATTEMPT}`);
    const upload = new Request(`${ORIGIN}/__ankka/install/oauth/callback`, { method: 'POST', body: '{}' });
    await edge.fetch(page);
    await edge.fetch(upload);
    expect(edge.forwarded).toEqual([page, upload]);
    expect(edge.forwarded[0]).toBe(page);
    expect(edge.forwarded[1]).toBe(upload);
    // Another origin's progress path never reaches the object.
    expect((await edge.fetch(new Request(`https://other.example.com${CUSTOMER_OPERATION_UPDATE_PROGRESS_PATH}?attempt=${ATTEMPT}`))).status).toBe(404);
    expect(edge.forwarded).toHaveLength(2);
  });

  it('reads only a release from the header', () => {
    const request = new Request(`${ORIGIN}${CUSTOMER_OPERATION_UPDATE_PROGRESS_PATH}?attempt=${ATTEMPT}`);
    expect(customerServingRelease(request)).toBeNull();
    expect(customerServingRelease(withCustomerServingRelease(request, 'gateway-v0.1.35'))).toBe('gateway-v0.1.35');
    // The original request is not touched.
    expect(request.headers.has(CUSTOMER_SERVING_RELEASE_HEADER)).toBe(false);
    for (const value of ['', 'gateway-v0.1', 'gateway-v01.2.3', 'v0.1.35', 'gateway-v0.1.35-rc1', '<script>']) {
      expect(customerServingRelease(new Request(request, { headers: { [CUSTOMER_SERVING_RELEASE_HEADER]: value } }))).toBeNull();
    }
  });
});

/** The two storage calls the port makes, over a map the test can read. */
function storage() {
  const stored = new Map<string, BoundaryObject>();
  const puts: string[][] = [];
  const durable: DurableObjectStorage = Object.create(null);
  Object.defineProperties(durable, {
    get: { value: async (keys: readonly string[]) => new Map(keys.flatMap((key) => {
      const value = stored.get(key);
      return value === undefined ? [] : [[key, value] as const];
    })) },
    put: { value: async (entries: BoundaryObject) => {
      puts.push(Object.keys(entries));
      for (const [key, value] of Object.entries(entries)) stored.set(key, { ...Object(value) });
    } },
  });
  return { stored, puts, port: new DurableCustomerUpdateOutcomePort(durable) };
}

const outcome: CustomerUpdateOutcome = {
  schemaVersion: 1, attemptId: ATTEMPT, actionId: `action_${'k'.repeat(32)}`, operation: 'update',
  status: 'running', result: null, reason: null, targetRelease: 'gateway-v0.1.35',
};

describe('the update record across releases', () => {
  it('keeps the target beside the record, which stays as a release from before the target reads it', async () => {
    const { stored, puts, port } = storage();
    await port.write(outcome);
    // One write for both, so the record is never stored without the target it belongs to.
    expect(puts).toEqual([[OUTCOME_KEY, TARGET_KEY]]);
    const { targetRelease: _target, ...record } = outcome;
    // A rollback leaves an older release reading this key with a strict schema: it must find exactly these fields.
    expect(stored).toEqual(new Map<string, BoundaryObject>([
      [OUTCOME_KEY, record],
      [TARGET_KEY, { schemaVersion: 1, attemptId: ATTEMPT, release: 'gateway-v0.1.35' }],
    ]));
    expect(await port.read()).toEqual(outcome);
    await port.write({ ...outcome, status: 'settled', result: 'applied' });
    expect(await port.read()).toEqual({ ...outcome, status: 'settled', result: 'applied' });
  });

  it('reads a record from before the target, and never another attempt\'s target', async () => {
    const { stored, port } = storage();
    expect(await port.read()).toBeNull();
    const { targetRelease: _target, ...record } = outcome;
    stored.set(OUTCOME_KEY, record);
    expect(await port.read()).toEqual({ ...outcome, targetRelease: null });
    // An older release ran a later attempt and wrote only its record; the target still names the earlier one.
    stored.set(TARGET_KEY, { schemaVersion: 1, attemptId: `attempt_${'z'.repeat(24)}`, release: 'gateway-v0.1.36' });
    expect(await port.read()).toEqual({ ...outcome, targetRelease: null });
    // A record without a target leaves the key alone.
    await port.write({ ...outcome, targetRelease: null });
    expect(stored.get(TARGET_KEY)).toEqual({ schemaVersion: 1, attemptId: `attempt_${'z'.repeat(24)}`, release: 'gateway-v0.1.36' });
    expect(await port.read()).toEqual({ ...outcome, targetRelease: null });
  });
});
