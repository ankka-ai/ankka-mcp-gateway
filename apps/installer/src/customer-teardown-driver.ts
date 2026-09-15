import * as v from 'valibot';
import { canonicalJson } from './canonical-json';
import { base64UrlEncode } from './crypto';
import type { CustomerCloudflareTransport, EphemeralCustomerCloudflareGrant } from './customer-cloudflare-grant';
import { operationSignature } from './customer-operation-secrets';
import type { CustomerTeardownAttempt, CustomerTeardownAttemptPort } from './customer-teardown-attempt';
import {
  customerTeardownCompletionSchema, customerTeardownRemovingSchema, type CustomerTeardownCompletion, type CustomerTeardownOutcomePort,
  type CustomerTeardownPhase, type CustomerTeardownReason, type CustomerTeardownResourceKind,
} from './customer-teardown-progress';
import { readBoundedText } from './http';

/** Bounded apply passes one attempt may take; each pass is its own alarm invocation with its own budget. */
export const CUSTOMER_TEARDOWN_MAX_PASSES = 768;

export type CustomerTeardownCommandKind = 'prove' | 'apply' | 'settle';
export type CustomerTeardownCommand = (command: CustomerTeardownCommandKind, body: string, signature: string) => Promise<Response>;

export interface CustomerTeardownCommandIdentity {
  readonly actionId: string;
  readonly actorEmail: string;
  readonly actionExpiresAt: number;
}

/** One HMAC-signed command to the gateway's own teardown journal; the key never leaves the caller's memory. */
export async function signedCustomerTeardownCommand(input: {
  readonly kind: CustomerTeardownCommandKind;
  readonly identity: CustomerTeardownCommandIdentity;
  readonly actionKey: string;
  readonly accountId: string;
  readonly installId: string;
  readonly now: number;
  readonly extra?: { readonly requestId: string; readonly cloudflareAccessToken: string };
}): Promise<{ readonly body: string; readonly signature: string }> {
  const body = canonicalJson({ schemaVersion: 1, command: input.kind, actionId: input.identity.actionId, actionKey: input.actionKey,
    actorEmail: input.identity.actorEmail, accountId: input.accountId, installationId: input.installId,
    issuedAt: input.now, expiresAt: input.identity.actionExpiresAt, ...input.extra });
  return { body, signature: await operationSignature(input.actionKey, body) };
}

export interface CustomerTeardownRemovalPorts {
  readonly attempts: CustomerTeardownAttemptPort;
  readonly outcomes: CustomerTeardownOutcomePort;
  readonly transport: CustomerCloudflareTransport;
  readonly publicClientId: string;
  readonly accountId: string;
  readonly installId: string;
  /** Where the signed receipt is handed to once the dependencies are gone. */
  readonly controlPlaneOrigin: string;
  readonly command: CustomerTeardownCommand;
  readonly signHandoff: (completion: CustomerTeardownCompletion, priorGrantRevocationUnconfirmed: boolean) => Promise<string>;
  readonly now: () => number;
  /** Arranges for the next pass to run in a fresh invocation after `delayMs`. */
  readonly schedule: (delayMs: number) => Promise<void>;
}

export type CustomerTeardownRemovalStep = 'scheduled' | 'settled' | 'idle';

/** What the latest pass of a live attempt reported, for the removal page. */
export interface CustomerTeardownLiveProgress {
  readonly phase: CustomerTeardownPhase | null;
  readonly removedKinds: readonly CustomerTeardownResourceKind[];
}

interface PendingRemoval {
  readonly attempt: CustomerTeardownAttempt;
  readonly grant: EphemeralCustomerCloudflareGrant;
  readonly actionKey: string;
  readonly requestId: string;
  readonly seen: Set<string>;
  passes: number;
  phase: CustomerTeardownPhase | null;
  removedKinds: readonly CustomerTeardownResourceKind[];
}

const applyResultSchema = v.union([customerTeardownCompletionSchema, customerTeardownRemovingSchema]);

/**
 * Keeps a dependency-removal grant and its one-time action key in the
 * management object's memory between alarm passes, so the consent callback
 * answers at once and no single invocation runs every pass. Storage never
 * receives either: an object restart between passes loses them, and the
 * attempt then settles recovery-required as `interrupted` with the
 * unconfirmed-revocation warning, never resuming from anything durable. The
 * gateway's own journal keeps every deletion boundary, so a fresh consent
 * continues from it. A bounded timer prevents normal idle hibernation between
 * alarms; it carries no credential and performs no work.
 */
export class CustomerTeardownRemovalDriver {
  #pending: PendingRemoval | null = null;
  #retentionTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly ports: CustomerTeardownRemovalPorts) {}

  /**
   * Takes the grant and the action key from a successful callback and
   * schedules the first pass. A pass that cannot be scheduled ends the
   * attempt here, grant revoked and outcome recorded, so the callback can
   * send the browser to the recovery page.
   */
  async start(input: {
    readonly attempt: CustomerTeardownAttempt;
    readonly grant: EphemeralCustomerCloudflareGrant;
    readonly actionKey: string;
    readonly requestId: string;
  }): Promise<'started' | 'failed'> {
    this.forget();
    const pending: PendingRemoval = { attempt: input.attempt, grant: input.grant, actionKey: input.actionKey, requestId: input.requestId,
      seen: new Set(), passes: 0, phase: null, removedKinds: [] };
    this.#pending = pending;
    this.#retentionTimer = setTimeout(() => { this.#retentionTimer = null; },
      Math.max(1, input.attempt.expiresAt - this.ports.now()) + 1_000);
    try {
      await this.ports.schedule(0);
      return 'started';
    } catch {
      await this.end(pending, input.attempt, 'removal', null);
      return 'failed';
    }
  }

  /** What the live attempt last reported, or null when this object holds no such attempt. */
  live(attemptId: string): CustomerTeardownLiveProgress | null {
    const pending = this.#pending;
    if (pending === null || pending.attempt.attemptId !== attemptId) return null;
    return { phase: pending.phase, removedKinds: pending.removedKinds };
  }

  /** Runs one bounded apply pass of the attempt the durable record names. */
  async continue(): Promise<CustomerTeardownRemovalStep> {
    const current = await this.ports.attempts.read();
    if (current === null || current.phase !== 'exchanging') {
      this.forget();
      return 'idle';
    }
    const pending = this.#pending;
    if (pending === null || pending.attempt.attemptId !== current.attemptId) {
      // The object restarted between passes: the grant and the key are gone; only the record can be settled here.
      this.forget();
      await this.ports.attempts.compareAndSet(current.revision, { ...current, revision: current.revision + 1,
        phase: 'settled', priorGrantRevocationUnconfirmed: true });
      await this.ports.outcomes.write({ schemaVersion: 1, attemptId: current.attemptId, result: 'recovery_required', reason: 'interrupted', handoffUrl: null });
      return 'settled';
    }
    if (this.ports.now() >= current.expiresAt) return this.end(pending, current, 'expired', null);
    pending.passes += 1;
    if (pending.passes > CUSTOMER_TEARDOWN_MAX_PASSES) return this.end(pending, current, 'pass_limit', null);
    let result: v.InferOutput<typeof applyResultSchema>;
    try {
      result = await pending.grant.withAccessToken(async (accessToken) => {
        const command = await signedCustomerTeardownCommand({ kind: 'apply', identity: current, actionKey: pending.actionKey,
          accountId: this.ports.accountId, installId: this.ports.installId, now: this.ports.now(),
          extra: { requestId: pending.requestId, cloudflareAccessToken: accessToken } });
        const response = await this.ports.command('apply', command.body, command.signature);
        if (response.status !== 200) { await response.body?.cancel(); throw new Error('teardown_apply_failed'); }
        return v.parse(applyResultSchema, JSON.parse(await readBoundedText(response, 'bad_request', 8192)));
      });
    } catch {
      return this.end(pending, current, 'removal', null);
    }
    if (result.actionId !== current.actionId || result.installationId !== this.ports.installId) return this.end(pending, current, 'removal', null);
    if (result.status === 'gateway_removed') return this.end(pending, current, null, result);
    if (pending.seen.has(result.progress)) return this.end(pending, current, 'no_progress', null);
    pending.seen.add(result.progress);
    if (result.phase !== undefined) pending.phase = result.phase;
    if (result.removedKinds !== undefined) pending.removedKinds = result.removedKinds;
    await this.ports.schedule(0);
    return 'scheduled';
  }

  private async end(
    pending: PendingRemoval, current: CustomerTeardownAttempt, failure: CustomerTeardownReason | null,
    completion: CustomerTeardownCompletion | null,
  ): Promise<CustomerTeardownRemovalStep> {
    let revoked = false;
    try {
      await pending.grant.revoke({ clientId: this.ports.publicClientId, transport: this.ports.transport });
      revoked = true;
    } catch { /* The warning is kept across every later attempt. */ }
    finally { pending.grant.discard(); }
    const settled = await this.settle(current, pending.actionKey, !revoked);
    let handoffUrl: string | null = null;
    let reason: CustomerTeardownReason | null = failure;
    if (completion !== null && revoked && settled) {
      try {
        const handoff = await this.ports.signHandoff(completion, current.priorGrantRevocationUnconfirmed);
        handoffUrl = `${this.ports.controlPlaneOrigin}/teardown#${base64UrlEncode(new TextEncoder().encode(handoff))}`;
      } catch { reason = 'removal'; }
    } else if (completion !== null && !revoked) {
      reason = 'revocation';
    } else if (!settled) {
      reason = 'removal';
    }
    this.forget();
    await this.ports.outcomes.write(handoffUrl !== null
      ? { schemaVersion: 1, attemptId: current.attemptId, result: 'removed', reason: null, handoffUrl }
      : { schemaVersion: 1, attemptId: current.attemptId, result: 'recovery_required', reason: reason ?? 'removal', handoffUrl: null });
    return 'settled';
  }

  /** Ends the attempt in the record and, through the signed command, in the gateway's journal; false when the journal refused. */
  private async settle(current: CustomerTeardownAttempt, actionKey: string, unconfirmed: boolean): Promise<boolean> {
    const settledRecord = await this.ports.attempts.compareAndSet(current.revision, { ...current, revision: current.revision + 1,
      phase: 'settled', priorGrantRevocationUnconfirmed: current.priorGrantRevocationUnconfirmed || unconfirmed });
    if (!settledRecord) return false;
    try {
      const command = await signedCustomerTeardownCommand({ kind: 'settle', identity: current, actionKey,
        accountId: this.ports.accountId, installId: this.ports.installId, now: this.ports.now() });
      const response = await this.ports.command('settle', command.body, command.signature);
      await response.body?.cancel();
      return response.status === 200;
    } catch {
      return false;
    }
  }

  private forget(): void {
    if (this.#retentionTimer !== null) clearTimeout(this.#retentionTimer);
    this.#retentionTimer = null;
    this.#pending?.grant.discard();
    this.#pending = null;
  }
}
