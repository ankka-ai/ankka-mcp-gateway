import * as v from 'valibot';
import type { CustomerCloudflareTransport, EphemeralCustomerCloudflareGrant } from './customer-cloudflare-grant';
import type {
  CustomerOperationAttempt, CustomerOperationResult, CustomerOperationRuntimeUpdateInput,
} from './customer-operation-router';

const attemptId = v.pipe(v.string(), v.regex(/^attempt_[A-Za-z0-9_-]{24}$/u));
const actionId = v.pipe(v.string(), v.regex(/^action_[A-Za-z0-9_-]{32}$/u));
const REASON = /^[a-z][a-z0-9_]{0,120}$/u;

/** The stages an update reports while it runs, in order; the page names each with a fixed label. */
export const CUSTOMER_UPDATE_STAGES = Object.freeze(['authorized', 'current_verified', 'assets_uploaded', 'candidate_created', 'uploading'] as const);
export type CustomerUpdateStage = (typeof CUSTOMER_UPDATE_STAGES)[number];

/**
 * The state of one update attempt, kept without secrets so the progress page
 * can learn where it stands after the callback has answered: running behind
 * the page, or settled with the result the dashboard is told.
 */
export const customerUpdateOutcomeSchema = v.strictObject({
  schemaVersion: v.literal(1), attemptId, actionId, operation: v.picklist(['update', 'rollback']),
  status: v.picklist(['running', 'settled']),
  result: v.nullable(v.picklist(['applied', 'failed', 'revocation_unconfirmed'])),
  reason: v.nullable(v.pipe(v.string(), v.regex(REASON))),
});
export type CustomerUpdateOutcome = v.InferOutput<typeof customerUpdateOutcomeSchema>;

export interface CustomerUpdateOutcomePort {
  read(): Promise<CustomerUpdateOutcome | null>;
  write(outcome: CustomerUpdateOutcome): Promise<void>;
}

const OUTCOME_KEY = 'ankka-mcp-gateway/customer-update-outcome/v1';

/** The latest update attempt's state in the management object's own storage; it holds no grant and no action key. */
export class DurableCustomerUpdateOutcomePort implements CustomerUpdateOutcomePort {
  constructor(private readonly storage: DurableObjectStorage) {}
  async read(): Promise<CustomerUpdateOutcome | null> {
    const parsed = v.safeParse(customerUpdateOutcomeSchema, await this.storage.get(OUTCOME_KEY));
    return parsed.success ? parsed.output : null;
  }
  async write(outcome: CustomerUpdateOutcome): Promise<void> {
    await this.storage.put(OUTCOME_KEY, v.parse(customerUpdateOutcomeSchema, outcome));
  }
}

/** What the update page polls: fixed words only, and where the dashboard continues once settled. */
export const customerUpdateProgressSchema = v.strictObject({
  schemaVersion: v.literal(1), attemptId,
  status: v.picklist(['running', 'settled']), stage: v.nullable(v.picklist(CUSTOMER_UPDATE_STAGES)),
  result: v.nullable(v.picklist(['applied', 'failed', 'revocation_unconfirmed'])),
  reason: v.nullable(v.pipe(v.string(), v.regex(REASON))),
  redirectUrl: v.nullable(v.pipe(v.string(), v.url())),
});
export type CustomerUpdateProgress = v.InferOutput<typeof customerUpdateProgressSchema>;

/** One attempt as the driver and its record know it. */
export interface CustomerUpdateView {
  readonly status: 'running' | 'settled';
  readonly stage: CustomerUpdateStage | null;
  readonly actionId: string;
  readonly result: 'applied' | 'failed' | 'revocation_unconfirmed' | null;
  readonly reason: string | null;
}

export interface CustomerRuntimeUpdatePorts {
  readonly outcomes: CustomerUpdateOutcomePort;
  readonly transport: CustomerCloudflareTransport;
  readonly publicClientId: string;
  /** Runs the gateway's own update with the grant; it hands over before the upload. */
  readonly runRuntimeUpdate: (input: CustomerOperationRuntimeUpdateInput) => Promise<CustomerOperationResult>;
  readonly now: () => number;
  /** Arranges for the pass to run in a fresh invocation after `delayMs`. */
  readonly schedule: (delayMs: number) => Promise<void>;
}

interface PendingUpdate {
  readonly attempt: CustomerOperationAttempt;
  readonly grant: EphemeralCustomerCloudflareGrant;
  readonly actionKey: string;
  stage: CustomerUpdateStage;
}

/**
 * Keeps an update's grant and action key in the management object's memory
 * so the consent callback answers at once and the upload runs behind the
 * progress page, in one alarm invocation with its own budget. Storage never
 * receives either. The upload replaces this Worker: the version that runs
 * afterwards holds no memory of the attempt, may refuse this version's
 * storage writes, and finishes the journal through the handover alarm that
 * already exists, so the page then hands the browser to the dashboard, which
 * follows the action.
 */
export class CustomerRuntimeUpdateDriver {
  #pending: PendingUpdate | null = null;
  #retentionTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly ports: CustomerRuntimeUpdatePorts) {}

  /** Records the running attempt, takes the grant and the key, and schedules the pass. */
  async start(input: {
    readonly attempt: CustomerOperationAttempt;
    readonly grant: EphemeralCustomerCloudflareGrant;
    readonly actionKey: string;
  }): Promise<'started' | 'failed'> {
    this.forget();
    const pending: PendingUpdate = { attempt: input.attempt, grant: input.grant, actionKey: input.actionKey, stage: 'authorized' };
    await this.ports.outcomes.write({ schemaVersion: 1, attemptId: input.attempt.attemptId, actionId: input.attempt.actionId,
      operation: input.attempt.operation === 'rollback' ? 'rollback' : 'update', status: 'running', result: null, reason: null });
    this.#pending = pending;
    this.#retentionTimer = setTimeout(() => { this.#retentionTimer = null; },
      Math.max(1, input.attempt.expiresAt - this.ports.now()) + 1_000);
    try {
      await this.ports.schedule(0);
      return 'started';
    } catch {
      await this.end(pending, 'failed', 'update_start_failed');
      return 'failed';
    }
  }

  /** The attempt as this object knows it: running with its stage while the grant is held here, else its recorded end. */
  async view(attemptId: string): Promise<CustomerUpdateView | null> {
    const outcome = await this.ports.outcomes.read();
    if (outcome === null || outcome.attemptId !== attemptId) return null;
    const pending = this.#pending;
    if (outcome.status === 'running' && pending !== null && pending.attempt.attemptId === attemptId) {
      return { status: 'running', stage: pending.stage, actionId: outcome.actionId, result: null, reason: null };
    }
    // Settled, or running in a version of this Worker that no longer exists: the dashboard follows the action.
    return { status: 'settled', stage: null, actionId: outcome.actionId, result: outcome.result, reason: outcome.reason };
  }

  /** The one pass: the whole update, whose upload replaces this Worker. */
  async continue(): Promise<'settled' | 'idle'> {
    const pending = this.#pending;
    if (pending === null) return 'idle';
    const target = pending.attempt.target;
    if (target === null || pending.attempt.operation === 'source-add') return this.end(pending, 'failed', 'attempt_invalid');
    let result: CustomerOperationResult;
    try {
      result = await pending.grant.withAccessToken((accessToken) => this.ports.runRuntimeUpdate({
        accessToken, actionId: pending.attempt.actionId, actionKey: pending.actionKey, actorEmail: pending.attempt.actorEmail,
        actionExpiresAt: pending.attempt.actionExpiresAt, controlPlaneOrigin: pending.attempt.controlPlaneOrigin,
        operation: pending.attempt.operation === 'rollback' ? 'rollback' : 'update', target,
        onStage: (stage) => { pending.stage = stage; },
      }));
    } catch {
      result = 'failed';
    }
    return result === 'applied' ? this.end(pending, 'applied', null) : this.end(pending, 'failed', 'update_failed');
  }

  private async end(pending: PendingUpdate, result: 'applied' | 'failed', reason: string | null): Promise<'settled'> {
    let outcome: CustomerUpdateOutcome['result'] = result;
    try {
      await pending.grant.revoke({ clientId: this.ports.publicClientId, transport: this.ports.transport });
    } catch {
      if (result === 'applied') outcome = 'revocation_unconfirmed';
    } finally {
      pending.grant.discard();
    }
    this.forget();
    // The upload may have replaced this Worker by now; a refused write leaves the record running and the dashboard follows the action.
    try {
      await this.ports.outcomes.write({ schemaVersion: 1, attemptId: pending.attempt.attemptId, actionId: pending.attempt.actionId,
        operation: pending.attempt.operation === 'rollback' ? 'rollback' : 'update', status: 'settled', result: outcome, reason });
    } catch { /* Recorded by the new version's handover instead. */ }
    return 'settled';
  }

  private forget(): void {
    if (this.#retentionTimer !== null) clearTimeout(this.#retentionTimer);
    this.#retentionTimer = null;
    this.#pending?.grant.discard();
    this.#pending = null;
  }
}
