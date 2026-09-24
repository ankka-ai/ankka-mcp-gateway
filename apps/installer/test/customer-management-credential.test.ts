import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  consumeCustomerBootstrapCapability,
  createCustomerBootstrapCapability,
  initialCustomerBootstrapState,
} from '../src/customer-bootstrap-state';
import type { CustomerGatewayOwnershipStorage } from '../src/customer-gateway-ownership-state';
import {
  CLOUDFLARE_MANAGEMENT_PERMISSION_GROUP_KEYS,
  CUSTOMER_MANAGEMENT_CREDENTIAL_HOLD_MS,
  CUSTOMER_MANAGEMENT_CREDENTIAL_KEEP_ALIVE_MS,
  CustomerManagementCredentialHolder,
  createCustomerManagementCredentialStep,
  customerManagementCredentialName,
  customerManagementCredentialTemplateLink,
  customerManagementCredentialUsable,
  parseCustomerManagementCredential,
  readCustomerManagementChoice,
  tendCustomerManagementCredential,
} from '../src/customer-management-credential';

const NOW = 1_800_000_000_000;
// Synthetic values in Cloudflare's two account token forms, assembled at run
// time so no literal in this file has the form of a real credential.
const SCANNABLE_VALUE = `cfat_${'Mg7t'.repeat(10)}${'0f'.repeat(4)}`;
const LEGACY_VALUE = `${'Lg-_'.repeat(10)}`;

class MemoryStorage implements CustomerGatewayOwnershipStorage {
  readonly values = new Map<string, unknown>();

  async get<Value = unknown>(key: string): Promise<Value | undefined> {
    // SAFETY: the storage contract lets the caller name the stored type; the map holds exactly what put() stored.
    return structuredClone(this.values.get(key)) as Value | undefined;
  }

  async put<Value>(key: string, value: Value): Promise<void> {
    this.values.set(key, structuredClone(value));
  }

  serialized(): string {
    return JSON.stringify([...this.values]);
  }
}

describe('management token template link', () => {
  it('pre-fills exactly the two verified permissions and a name that carries the management hostname', () => {
    const link = customerManagementCredentialTemplateLink('manage.example.com');
    expect(link).toBe('https://dash.cloudflare.com/?to=/:account/api-tokens' +
      '&permissionGroupKeys=%5B%7B%22key%22%3A%22access%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22mcp_portals%22%2C%22type%22%3A%22edit%22%7D%5D' +
      '&name=Ankka%20gateway%20manage.example.com');
    const url = new URL(link);
    expect(url.origin).toBe('https://dash.cloudflare.com');
    expect(url.pathname).toBe('/');
    expect(url.hash).toBe('');
    expect([...url.searchParams.keys()]).toEqual(['to', 'permissionGroupKeys', 'name']);
    expect(url.searchParams.get('to')).toBe('/:account/api-tokens');
    // The URL-decoded JSON is the one exported constant, nothing more.
    expect(JSON.parse(url.searchParams.get('permissionGroupKeys') ?? '')).toEqual(CLOUDFLARE_MANAGEMENT_PERMISSION_GROUP_KEYS);
    expect(CLOUDFLARE_MANAGEMENT_PERMISSION_GROUP_KEYS).toEqual([
      { key: 'access', type: 'edit' },
      { key: 'mcp_portals', type: 'edit' },
    ]);
    expect(url.searchParams.get('name')).toBe(customerManagementCredentialName('manage.example.com'));
    expect(url.searchParams.get('name')).toContain('manage.example.com');
  });

});

describe('management token form', () => {
  it('does not depend on the length of the scannable checksum, which Cloudflare does not publish', () => {
    for (const length of [40, 48, 64]) {
      const value = `cfat_${'a'.repeat(length)}`;
      expect(parseCustomerManagementCredential(value)).toBe(value);
    }
  });

  it.each([
    ['a user token', `cfut_${'a'.repeat(48)}`],
    ['a Global API Key', `cfk_${'a'.repeat(48)}`],
    ['a short scannable value', `cfat_${'a'.repeat(39)}`],
    ['a long scannable value', `cfat_${'a'.repeat(65)}`],
    ['punctuation in a scannable value', `cfat_${'a'.repeat(47)}-`],
    ['a 39-character value', 'a'.repeat(39)],
    ['a 41-character value', 'a'.repeat(41)],
    ['surrounding space', ` ${'a'.repeat(40)}`],
    ['a trailing newline', `${'a'.repeat(40)}\n`],
    ['a non-ASCII letter', `${'a'.repeat(39)}é`],
  ])('refuses %s', (_label, value) => {
    expect(parseCustomerManagementCredential(value)).toBeNull();
  });
});

describe('management token holder', () => {
  beforeEach(() => vi.useFakeTimers({ now: NOW }));
  afterEach(() => vi.useRealTimers());

  it('holds the value in memory only, for a bounded time, and reports fixed words', () => {
    const holder = new CustomerManagementCredentialHolder(Date.now);
    expect(holder.value()).toBeUndefined();
    expect(holder.word(null)).toBeUndefined();
    expect(holder.word('skipped')).toBe('skipped');
    holder.hold(SCANNABLE_VALUE);
    expect(holder.value()).toBe(SCANNABLE_VALUE);
    expect(holder.word('provided')).toBe('held');
    // One bounded timer keeps the object from ordinary idle hibernation while it holds a value.
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(CUSTOMER_MANAGEMENT_CREDENTIAL_HOLD_MS - 1);
    expect(holder.value()).toBe(SCANNABLE_VALUE);
    vi.advanceTimersByTime(1);
    expect(holder.value()).toBeUndefined();
    expect(holder.word('provided')).toBe('dropped');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('replaces an earlier value, refuses a malformed one without losing it, and forgets on release', () => {
    const holder = new CustomerManagementCredentialHolder(Date.now);
    holder.hold(LEGACY_VALUE);
    expect(() => holder.hold('not a token')).toThrow();
    expect(holder.value()).toBe(LEGACY_VALUE);
    holder.hold(SCANNABLE_VALUE);
    expect(holder.value()).toBe(SCANNABLE_VALUE);
    expect(vi.getTimerCount()).toBe(1);
    holder.release();
    expect(holder.value()).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps nothing once the final upload carried the value', () => {
    const holder = new CustomerManagementCredentialHolder(Date.now);
    holder.hold(SCANNABLE_VALUE);
    holder.markInstalled();
    expect(holder.value()).toBeUndefined();
    expect(holder.word('provided')).toBe('installed');
    expect(vi.getTimerCount()).toBe(0);
    expect(JSON.stringify(holder)).not.toContain(SCANNABLE_VALUE);
  });
});

describe('management token step', () => {
  beforeEach(() => vi.useFakeTimers({ now: NOW }));
  afterEach(() => vi.useRealTimers());

  it('stores one fixed word about the choice and never the value', async () => {
    const storage = new MemoryStorage();
    const holder = new CustomerManagementCredentialHolder(Date.now);
    const step = createCustomerManagementCredentialStep(holder, storage);
    expect(await step.word()).toBeUndefined();
    expect(storage.values.size).toBe(0);

    await step.accept(SCANNABLE_VALUE);
    expect(await step.word()).toBe('held');
    expect(holder.value()).toBe(SCANNABLE_VALUE);
    expect(await readCustomerManagementChoice(storage)).toBe('provided');
    expect([...storage.values]).toEqual([
      ['ankka-mcp-gateway/management-credential-choice/v1', { schemaVersion: 1, choice: 'provided' }],
    ]);
    expect(storage.serialized()).not.toContain(SCANNABLE_VALUE);

    await step.skip();
    expect(holder.value()).toBeUndefined();
    expect(await step.word()).toBe('skipped');
    expect(storage.serialized()).not.toContain(SCANNABLE_VALUE);
    holder.release();
  });

  it('reports a provided value as dropped once a restarted object no longer holds it', async () => {
    const storage = new MemoryStorage();
    const before = new CustomerManagementCredentialHolder(Date.now);
    await createCustomerManagementCredentialStep(before, storage).accept(LEGACY_VALUE);
    before.release();
    // A restart constructs the object again over the same storage: memory is empty, the word is not.
    const after = new CustomerManagementCredentialHolder(Date.now);
    const restarted = createCustomerManagementCredentialStep(after, storage);
    expect(after.value()).toBeUndefined();
    expect(await restarted.word()).toBe('dropped');
    // Pasting again is all it takes to hold a value once more.
    await restarted.accept(LEGACY_VALUE);
    expect(await restarted.word()).toBe('held');
    after.release();
  });

  it('keeps the holding object awake while an approval can still use the value, and never takes the alarm from anyone', async () => {
    const holder = new CustomerManagementCredentialHolder(Date.now);
    const set: number[] = [];
    let pending: number | null = null;
    const alarms = {
      getAlarm: async () => pending,
      setAlarm: async (time: number) => { pending = time; set.push(time); },
    };
    const capability = await createCustomerBootstrapCapability({ now: NOW });
    const initial = initialCustomerBootstrapState({
      installId: `acg-${'b'.repeat(24)}`, bootstrapId: capability.bootstrapId,
      secretCommitment: capability.secretCommitment, expiresAt: capability.expiresAt,
    });
    const session = (await consumeCustomerBootstrapCapability({
      current: initial, bootstrapId: capability.bootstrapId, secret: capability.secret, now: NOW,
    })).state;
    // Nothing held: no alarm, whatever the state.
    expect(await tendCustomerManagementCredential(holder, session, alarms, NOW)).toBe('idle');
    expect(set).toEqual([]);

    holder.hold(SCANNABLE_VALUE);
    expect(await tendCustomerManagementCredential(holder, session, alarms, NOW)).toBe('kept');
    expect(set).toEqual([NOW + CUSTOMER_MANAGEMENT_CREDENTIAL_KEEP_ALIVE_MS]);
    // An alarm that is already set, the converger's or the handover's, is left alone.
    pending = NOW + 1;
    expect(await tendCustomerManagementCredential(holder, session, alarms, NOW + 5)).toBe('kept');
    expect(set).toHaveLength(1);
    // A running install keeps the value usable even though its setup session has ended.
    pending = null;
    const late = capability.expiresAt + 1;
    vi.setSystemTime(NOW + 1);
    expect(await tendCustomerManagementCredential(holder, { ...session, status: 'CONVERGING' }, alarms, late)).toBe('kept');
    expect(set.at(-1)).toBe(late + CUSTOMER_MANAGEMENT_CREDENTIAL_KEEP_ALIVE_MS);
    expect(holder.value()).toBe(SCANNABLE_VALUE);
    // Once no approval can use it any more, it is forgotten at once and nothing is scheduled.
    pending = null;
    const before = set.length;
    expect(await tendCustomerManagementCredential(holder, session, alarms, late)).toBe('released');
    expect(holder.value()).toBeUndefined();
    expect(set).toHaveLength(before);
    expect(vi.getTimerCount()).toBe(0);
    for (const state of [null, { ...session, status: 'READY' as const }, { ...session, session: null }]) {
      holder.hold(LEGACY_VALUE);
      expect(customerManagementCredentialUsable(state, NOW)).toBe(false);
      expect(await tendCustomerManagementCredential(holder, state, alarms, NOW)).toBe('released');
      expect(holder.value()).toBeUndefined();
    }
    expect(customerManagementCredentialUsable(session, NOW)).toBe(true);
    expect(JSON.stringify(set)).not.toContain(SCANNABLE_VALUE);
  });

  it('reads a malformed or foreign choice record as no choice', async () => {
    const storage = new MemoryStorage();
    await storage.put('ankka-mcp-gateway/management-credential-choice/v1', { schemaVersion: 1, choice: 'provided', value: 'x' });
    expect(await readCustomerManagementChoice(storage)).toBeNull();
    const step = createCustomerManagementCredentialStep(new CustomerManagementCredentialHolder(Date.now), storage);
    expect(await step.word()).toBeUndefined();
  });
});
