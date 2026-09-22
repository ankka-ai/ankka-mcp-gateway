import {
  CUSTOMER_BOOTSTRAP_CONVERGENCE_MAX_PASSES,
  continueCustomerBootstrapConvergence,
  type CustomerBootstrapConverge,
} from './customer-bootstrap-callback';
import type { CustomerBootstrapStatePort } from './customer-bootstrap-router';
import {
  markCustomerBootstrapCleanupPending,
  markCustomerBootstrapIncomplete,
  parseCustomerBootstrapState,
  type CustomerBootstrapCleanupPhase,
  type CustomerBootstrapState,
} from './customer-bootstrap-state';
import type {
  CustomerCloudflareTransport,
  EphemeralCustomerCloudflareGrant,
} from './customer-cloudflare-grant';
import { CustomerStage2ConvergerError } from './customer-stage2-converger';

/** An attempt older than this settles INCOMPLETE on its next pass instead of running on. */
export const CUSTOMER_BOOTSTRAP_CONVERGENCE_DEADLINE_MS = 15 * 60 * 1_000;
/** How long after arming the handover the final runtime is expected to run its first pass. */
export const CUSTOMER_BOOTSTRAP_HANDOVER_ALARM_DELAY_MS = 8_000;
/**
 * Backup alarm for a bootstrap-only cleanup. The progress page normally
 * finishes it first so it can show the result; this still runs if the page is gone.
 */
export const CUSTOMER_BOOTSTRAP_CLEANUP_ALARM_DELAY_MS = 15_000;

export interface CustomerBootstrapConvergenceDriverPorts {
  readonly state: CustomerBootstrapStatePort;
  readonly transport: CustomerCloudflareTransport;
  readonly publicClientId: string;
  readonly converge: CustomerBootstrapConverge;
  readonly now: () => number;
  /** Arranges for the next pass to run in a fresh invocation after `delayMs`. */
  readonly schedule: (delayMs: number) => Promise<void>;
  /**
   * Present on the customer Worker. `bootstrap_only` means the installation
   * record proves no final resource was sent. Anything uncertain, including
   * a thrown read, is `recovery_required`.
   */
  readonly classifyTerminalFailure?: (input: {
    readonly attemptId: string;
    readonly failureReason: string | null;
  }) => Promise<'bootstrap_only' | 'recovery_required'>;
  /**
   * Retires the recorded namespace and deletes the recorded Worker, then
   * reads both back. Uses only the in-memory install grant.
   */
  readonly removeOwnedBootstrap?: (input: {
    readonly grant: EphemeralCustomerCloudflareGrant;
    readonly attemptId: string;
  }) => Promise<'removed' | 'recovery_required'>;
}

export type CustomerBootstrapConvergenceStep = 'scheduled' | 'settled' | 'idle';

interface PendingConvergence {
  readonly attemptId: string;
  readonly grant: EphemeralCustomerCloudflareGrant;
  readonly startedAt: number;
  passes: number;
}

/**
 * Keeps the Stage 2 grant in object memory between converger passes so no
 * single invocation has to make every provider call. Storage never receives
 * the grant: an object restart between passes loses it, and the attempt then
 * settles INCOMPLETE with `grant_lost` rather than resuming from anything
 * durable. The journal and its lease make a repeated pass harmless.
 * A bounded timer prevents normal idle hibernation between alarms, including
 * when the browser is closed. It carries no credential and performs no work;
 * the alarm remains responsible for the next pass and deadline revocation.
 */
export class CustomerBootstrapConvergenceDriver {
  #pending: PendingConvergence | null = null;
  #retentionTimer: ReturnType<typeof setTimeout> | null = null;
  /** When this runtime handed the attempt over to the final runtime, if it did. */
  #handedOverAt: number | null = null;

  constructor(private readonly ports: CustomerBootstrapConvergenceDriverPorts) {}

  /**
   * True from the moment a callback handed its grant over until the attempt
   * settles. A host that wakes itself for another reason asks this before it
   * runs a pass: while a callback is still exchanging its code the state
   * already says CONVERGING, and a pass would settle that attempt as one
   * whose grant was lost.
   */
  get holdsGrant(): boolean {
    return this.#pending !== null;
  }

  /** Takes the grant from a successful callback and schedules the first pass. */
  async start(input: {
    readonly attemptId: string;
    readonly grant: EphemeralCustomerCloudflareGrant;
  }): Promise<void> {
    this.forget();
    this.#pending = {
      attemptId: input.attemptId,
      grant: input.grant,
      startedAt: this.ports.now(),
      passes: 0,
    };
    this.#handedOverAt = null;
    this.#retentionTimer = setTimeout(() => {
      this.#retentionTimer = null;
    }, CUSTOMER_BOOTSTRAP_CONVERGENCE_DEADLINE_MS + 1);
    try {
      await this.ports.schedule(0);
    } catch (error) {
      this.releaseRetention();
      throw error;
    }
  }

  /** Runs one pass of the attempt the durable state names. */
  async continue(): Promise<CustomerBootstrapConvergenceStep> {
    const current = await this.readConverging();
    if (current === null) {
      this.forget();
      return 'idle';
    }
    const attemptId = current.oauth?.attemptId ?? null;
    if (current.oauth?.phase === 'finalizing') {
      // Handed over: the final runtime marks READY once the object restarts on
      // it. Until then this code only keeps a later look scheduled.
      this.forget();
      const handedOverAt = this.#handedOverAt ?? this.ports.now();
      this.#handedOverAt = handedOverAt;
      if (this.ports.now() - handedOverAt > CUSTOMER_BOOTSTRAP_CONVERGENCE_DEADLINE_MS) {
        await this.settle(current, attemptId, 'handover_timeout');
        return 'settled';
      }
      await this.ports.schedule(CUSTOMER_BOOTSTRAP_HANDOVER_ALARM_DELAY_MS);
      return 'scheduled';
    }
    if (current.cleanup?.phase === 'removing') {
      const outcome = await this.finishOwnedCleanup();
      if (outcome === 'removing') {
        await this.ports.schedule(CUSTOMER_BOOTSTRAP_CLEANUP_ALARM_DELAY_MS);
        return 'scheduled';
      }
      return 'settled';
    }
    const pending = this.#pending;
    if (pending === null || attemptId === null || pending.attemptId !== attemptId) {
      this.forget();
      await this.settle(current, attemptId, 'grant_lost');
      return 'settled';
    }
    pending.passes += 1;
    const overdue = this.ports.now() - pending.startedAt > CUSTOMER_BOOTSTRAP_CONVERGENCE_DEADLINE_MS;
    const exhausted = pending.passes > CUSTOMER_BOOTSTRAP_CONVERGENCE_MAX_PASSES;
    const converge: CustomerBootstrapConverge = overdue || exhausted
      ? async () => {
        throw new CustomerStage2ConvergerError(
          'provider_mismatch',
          overdue ? 'convergence_deadline' : 'convergence_passes_exhausted',
        );
      }
      : this.ports.converge;
    let outcome: Awaited<ReturnType<typeof continueCustomerBootstrapConvergence>>;
    try {
      outcome = await continueCustomerBootstrapConvergence({
        current,
        attemptId,
        grant: pending.grant,
        publicClientId: this.ports.publicClientId,
        now: this.ports.now(),
        transport: this.ports.transport,
        persist: (expected, next) => this.persist(expected, next),
        converge,
        armHandover: () => this.ports.schedule(CUSTOMER_BOOTSTRAP_HANDOVER_ALARM_DELAY_MS),
        onTerminalFailure: this.ports.classifyTerminalFailure === undefined
          ? undefined
          : async ({ failureReason }) => {
            try {
              const decision = await this.ports.classifyTerminalFailure?.({
                attemptId: pending.attemptId,
                failureReason,
              });
              return decision === 'bootstrap_only' ? 'keep' : 'recovery';
            } catch {
              return 'recovery';
            }
          },
      });
    } catch {
      // A durable conflict or a thrown port: the grant is dropped so nothing
      // keeps it alive, and the attempt is named as stopped for a fresh start.
      this.forget();
      await this.settle(current, attemptId, 'unexpected', this.ports.classifyTerminalFailure === undefined ? null : 'recovery_required');
      return 'settled';
    }
    if (outcome.status === 'CLEANUP_PENDING') {
      const removing = markCustomerBootstrapCleanupPending({
        current: outcome.state,
        attemptId: pending.attemptId,
        failureCode: outcome.failureCode,
        failureReason: outcome.failureReason,
      });
      await this.persist(outcome.state, removing);
      await this.ports.schedule(CUSTOMER_BOOTSTRAP_CLEANUP_ALARM_DELAY_MS);
      return 'scheduled';
    }
    if (outcome.status === 'CONVERGING') {
      await this.ports.schedule(0);
      return 'scheduled';
    }
    if (outcome.status === 'HANDED_OVER') this.#handedOverAt = this.ports.now();
    this.forget();
    return 'settled';
  }

  /**
   * Finishes a bootstrap-only cleanup while the grant is still in memory.
   * The progress page calls this so its response can report the result; the
   * backup alarm calls it when the page does not.
   */
  async finishOwnedCleanup(): Promise<'removed' | 'recovery_required' | 'removing' | 'idle'> {
    const current = await this.readConverging();
    if (current === null || current.cleanup?.phase !== 'removing') {
      const stored = await this.ports.state.read();
      const parsed = stored === undefined || stored === null ? null : parseCustomerBootstrapState(stored);
      if (parsed?.cleanup?.phase === 'removed') return 'removed';
      if (parsed?.cleanup?.phase === 'recovery_required') return 'recovery_required';
      return 'idle';
    }
    const pending = this.#pending;
    const attemptId = current.oauth?.attemptId ?? null;
    if (pending === null || attemptId === null || pending.attemptId !== attemptId ||
        this.ports.removeOwnedBootstrap === undefined) {
      this.forget();
      await this.settle(current, attemptId, current.failureReason ?? 'grant_lost', 'recovery_required');
      return 'recovery_required';
    }
    let outcome: 'removed' | 'recovery_required' | 'removing' = 'recovery_required';
    try {
      outcome = await this.ports.removeOwnedBootstrap({ grant: pending.grant, attemptId });
    } catch {
      // An interrupted or uncertain deletion stays retryable while this grant
      // is still in memory. The next call reads the provider back first.
      if (this.ports.now() - pending.startedAt <= CUSTOMER_BOOTSTRAP_CONVERGENCE_DEADLINE_MS) return 'removing';
      outcome = 'recovery_required';
    }
    let failureCode: 'provider_recovery_required' | 'revocation_unconfirmed' = 'provider_recovery_required';
    try {
      await pending.grant.revoke({ clientId: this.ports.publicClientId, transport: this.ports.transport });
    } catch {
      failureCode = 'revocation_unconfirmed';
    } finally {
      this.forget();
    }
    try {
      await this.settle(current, attemptId, current.failureReason ?? 'unexpected', outcome, failureCode);
    } catch {
      // The namespace may already be gone, so the result cannot be stored.
      // The caller still reports the read-back outcome.
    }
    return outcome;
  }

  private releaseRetention(): void {
    if (this.#retentionTimer !== null) clearTimeout(this.#retentionTimer);
    this.#retentionTimer = null;
  }

  private forget(): void {
    this.releaseRetention();
    this.#pending?.grant.discard();
    this.#pending = null;
  }

  private async readConverging(): Promise<CustomerBootstrapState | null> {
    const stored = await this.ports.state.read();
    const current = stored === undefined || stored === null ? null : parseCustomerBootstrapState(stored);
    return current !== null && current.status === 'CONVERGING' ? current : null;
  }

  private async persist(expected: CustomerBootstrapState, next: CustomerBootstrapState): Promise<void> {
    if (next.revision !== expected.revision + 1 ||
        !await this.ports.state.compareAndSet(expected.revision, next)) {
      throw new Error('customer_bootstrap_state_conflict');
    }
  }

  private async settle(
    current: CustomerBootstrapState,
    attemptId: string | null,
    reason: string,
    cleanup: CustomerBootstrapCleanupPhase | null = null,
    failureCode: 'provider_recovery_required' | 'revocation_unconfirmed' = 'revocation_unconfirmed',
  ): Promise<void> {
    if (attemptId === null) return;
    try {
      const incomplete = markCustomerBootstrapIncomplete({
        current,
        attemptId,
        failureCode,
        failureReason: reason,
        cleanup,
      });
      await this.persist(current, incomplete);
    } catch {
      // A concurrent writer already moved the attempt on; its record stands.
    }
  }
}
