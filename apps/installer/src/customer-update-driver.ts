import * as v from 'valibot';
import type { CustomerCloudflareTransport, EphemeralCustomerCloudflareGrant } from './customer-cloudflare-grant';
import type {
  CustomerOperationAttempt, CustomerOperationResult, CustomerOperationRuntimeUpdateInput,
} from './customer-operation-router';

const attemptId = v.pipe(v.string(), v.regex(/^attempt_[A-Za-z0-9_-]{24}$/u));
const actionId = v.pipe(v.string(), v.regex(/^action_[A-Za-z0-9_-]{32}$/u));
const release = v.pipe(v.string(), v.regex(/^gateway-v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u));
const REASON = /^[a-z][a-z0-9_]{0,120}$/u;

/** The stages an update reports while it runs, in order; the page names each with a fixed label. */
export const CUSTOMER_UPDATE_STAGES = Object.freeze(['authorized', 'current_verified', 'assets_uploaded', 'candidate_created', 'uploading'] as const);
export type CustomerUpdateStage = (typeof CUSTOMER_UPDATE_STAGES)[number];

/**
 * Names the release of the stateless entrypoint that forwarded a progress
 * request: the Worker version Cloudflare runs at the browser's edge location,
 * and so the version whose dashboard a navigation from there receives. The
 * management object cannot stand in for it: there is one object, it restarts
 * on the new version right after the upload, and that location keeps serving
 * the previous version for a while. An entrypoint that knows the header sets
 * it itself and so replaces what a browser sent; one from before it forwards
 * the request as it arrived, which for the page's own polls names nothing.
 * The header carries no authority either way: it only tells the update page
 * when to hand the browser to its own dashboard.
 */
export const CUSTOMER_SERVING_RELEASE_HEADER = 'x-ankka-serving-release';

/** The request as the management object receives it, naming the release of the entrypoint that forwards it. */
export function withCustomerServingRelease(request: Request, servingRelease: string): Request {
  const forwarded = new Request(request);
  forwarded.headers.set(CUSTOMER_SERVING_RELEASE_HEADER, servingRelease);
  return forwarded;
}

/** The release the forwarding entrypoint named; null when it named none. */
export function customerServingRelease(request: Request): string | null {
  const parsed = v.safeParse(release, request.headers.get(CUSTOMER_SERVING_RELEASE_HEADER));
  return parsed.success ? parsed.output : null;
}

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
  /** The release the attempt reaches; null in a record from before the page waited for it. */
  targetRelease: v.nullable(release),
});
export type CustomerUpdateOutcome = v.InferOutput<typeof customerUpdateOutcomeSchema>;

export interface CustomerUpdateOutcomePort {
  read(): Promise<CustomerUpdateOutcome | null>;
  write(outcome: CustomerUpdateOutcome): Promise<void>;
}

const OUTCOME_KEY = 'ankka-mcp-gateway/customer-update-outcome/v1';
const TARGET_KEY = 'ankka-mcp-gateway/customer-update-target/v1';
/**
 * The record under the outcome key keeps the fields it was introduced with. A
 * rollback puts a release from before the target in charge of it, and that
 * release reads it with a strict schema: one more field there and its progress
 * route no longer knows the attempt, so the page that follows it never hands
 * over. The target lives under its own key, which such a release ignores.
 */
const storedOutcomeSchema = v.omit(customerUpdateOutcomeSchema, ['targetRelease']);
const storedTargetSchema = v.strictObject({ schemaVersion: v.literal(1), attemptId, release });

/** The latest update attempt's state in the management object's own storage; it holds no grant and no action key. */
export class DurableCustomerUpdateOutcomePort implements CustomerUpdateOutcomePort {
  constructor(private readonly storage: DurableObjectStorage) {}
  async read(): Promise<CustomerUpdateOutcome | null> {
    const stored = await this.storage.get([OUTCOME_KEY, TARGET_KEY]);
    const outcome = v.safeParse(storedOutcomeSchema, stored.get(OUTCOME_KEY));
    if (!outcome.success) return null;
    // A target an earlier attempt left behind says nothing about this one.
    const target = v.safeParse(storedTargetSchema, stored.get(TARGET_KEY));
    return { ...outcome.output,
      targetRelease: target.success && target.output.attemptId === outcome.output.attemptId ? target.output.release : null };
  }
  async write(outcome: CustomerUpdateOutcome): Promise<void> {
    const { targetRelease, ...record } = v.parse(customerUpdateOutcomeSchema, outcome);
    // One put, so the record and its target are never stored apart.
    await this.storage.put(targetRelease === null ? { [OUTCOME_KEY]: record } : {
      [OUTCOME_KEY]: record, [TARGET_KEY]: { schemaVersion: 1, attemptId: record.attemptId, release: targetRelease },
    });
  }
}

/** What the update page polls: fixed words only, and where the dashboard continues once settled. */
export const customerUpdateProgressSchema = v.strictObject({
  schemaVersion: v.literal(1), attemptId,
  status: v.picklist(['running', 'settled']), stage: v.nullable(v.picklist(CUSTOMER_UPDATE_STAGES)),
  result: v.nullable(v.picklist(['applied', 'failed', 'revocation_unconfirmed'])),
  reason: v.nullable(v.pipe(v.string(), v.regex(REASON))),
  redirectUrl: v.nullable(v.pipe(v.string(), v.url())),
  /**
   * True once the target is uploaded: the recorded result says so, or the
   * object that answers runs the target itself, which also covers a version
   * replaced before it could record its end. The page then waits for
   * `servingRelease` to become `targetRelease` before it hands over.
   */
  applied: v.boolean(),
  /** The release the attempt reaches; null when its record is from before the page waited for it. */
  targetRelease: v.nullable(release),
  /** The release that served this answer at the browser's edge location; null when the entrypoint named none. */
  servingRelease: v.nullable(release),
});
export type CustomerUpdateProgress = v.InferOutput<typeof customerUpdateProgressSchema>;

/** One attempt as the driver and its record know it. */
export interface CustomerUpdateView {
  readonly status: 'running' | 'settled';
  readonly stage: CustomerUpdateStage | null;
  readonly actionId: string;
  readonly result: 'applied' | 'failed' | 'revocation_unconfirmed' | null;
  readonly reason: string | null;
  readonly targetRelease: string | null;
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
    // The target is recorded before the upload: the version that answers the page afterwards holds no memory of the attempt.
    await this.ports.outcomes.write({ schemaVersion: 1, attemptId: input.attempt.attemptId, actionId: input.attempt.actionId,
      operation: input.attempt.operation === 'rollback' ? 'rollback' : 'update', status: 'running', result: null, reason: null,
      targetRelease: input.attempt.target?.release ?? null });
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
      return { status: 'running', stage: pending.stage, actionId: outcome.actionId, result: null, reason: null, targetRelease: outcome.targetRelease };
    }
    // Settled, or running in a version of this Worker that no longer exists: the dashboard follows the action.
    return { status: 'settled', stage: null, actionId: outcome.actionId, result: outcome.result, reason: outcome.reason, targetRelease: outcome.targetRelease };
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
        operation: pending.attempt.operation === 'rollback' ? 'rollback' : 'update', status: 'settled', result: outcome, reason,
        targetRelease: pending.attempt.target?.release ?? null });
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
