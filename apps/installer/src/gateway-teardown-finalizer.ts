import * as v from 'valibot';
import { boundaryObjectSchema } from './boundary';
import { OAUTH_EXCHANGE_URL } from './constants';
import { exactOperationScopes } from './cloudflare-operation-authority';
import { verifyCustomerCloudflareGrantAccountAccess } from './customer-cloudflare-grant';
import type { ExactReleaseBundleIdentity } from './exact-release-bundle';
import type { GatewayTeardownJobPort } from './gateway-teardown-durable-state';
import type { GatewayTeardownTrust } from './gateway-teardown-handoff';
import { settleGatewayTeardownAttempt, verifyGatewayTeardownJobAuthority, type GatewayTeardownJob } from './gateway-teardown-job';
import {
  createGatewayRootRemovalAttemptMemory, executeGatewayRootRemoval, gatewayTeardownFailureReason,
  GatewayTeardownCallBudget, GatewayTeardownProviderError, type GatewayRootRemovalAttemptMemory,
} from './gateway-teardown-provider';
import { readBoundedText } from './http';
import { exchangeAuthorizationCode, type CloudflareOauthConfig, type EphemeralCloudflareGrant, type FetchTransport } from './oauth';
import type { VerifiedReleaseBundle } from './release';

/** A hosted attempt lives ten minutes; the retention timer outlives it by a moment so the alarm settles it first. */
export const GATEWAY_TEARDOWN_ATTEMPT_WINDOW_MS = 10 * 60 * 1_000;
/** Passes one attempt may take; each pass has its own call budget in its own invocation. */
export const GATEWAY_TEARDOWN_MAX_PASSES = 64;

export interface GatewayTeardownFinalizerPorts {
  readonly port: GatewayTeardownJobPort;
  readonly trust: GatewayTeardownTrust;
  readonly oauth: CloudflareOauthConfig;
  readonly transport: FetchTransport;
  readonly loadBundle: (identity: ExactReleaseBundleIdentity) => Promise<VerifiedReleaseBundle>;
  readonly now: () => number;
  /** Arranges for the next pass to run in a fresh invocation after `delayMs`. */
  readonly schedule: (delayMs: number) => Promise<void>;
  readonly wait?: (milliseconds: number) => Promise<void>;
}

export type GatewayTeardownFinalizerStep = 'scheduled' | 'settled' | 'idle';

interface PendingAttempt {
  readonly attemptId: string;
  readonly grant: EphemeralCloudflareGrant;
  readonly accountId: string;
  readonly memory: GatewayRootRemovalAttemptMemory;
  bundle: VerifiedReleaseBundle | null;
  passes: number;
}

/**
 * Keeps the hosted root-removal grant in the job object's memory between
 * alarm passes so no single invocation has to make every provider call.
 * Storage never receives the grant: an object restart between passes loses
 * it, and the attempt then settles recovery-required with `grant_lost` and an
 * unconfirmed revocation rather than resuming from anything durable. The
 * durable step receipts make a repeated pass harmless, and a fresh consent
 * resumes from them. A bounded timer prevents normal idle hibernation between
 * alarms; it carries no credential and performs no work.
 */
export class GatewayTeardownFinalizerDriver {
  #pending: PendingAttempt | null = null;
  #retentionTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly ports: GatewayTeardownFinalizerPorts) {}

  /**
   * Exchanges the callback's code, binds the grant to the installed account
   * and arms the first pass. A grant that cannot be used is revoked and the
   * attempt settled at once, so the callback answers either way.
   */
  async begin(input: { readonly attemptId: string; readonly code: string; readonly verifier: string }): Promise<{ readonly started: boolean }> {
    const current = await this.ports.port.read();
    if (current?.phase !== 'exchanging' || current.attempt?.id !== input.attemptId || current.attempt.expiresAt <= this.ports.now()) {
      throw new Error('teardown_callback_invalid');
    }
    let grant: EphemeralCloudflareGrant | null = null;
    let refreshTokenReturned = false;
    const inspectingTransport: FetchTransport = async (request, init) => {
      const response = await this.ports.transport(request, init);
      const url = request instanceof Request ? request.url : request.toString();
      if (url === OAUTH_EXCHANGE_URL && response.ok) {
        try {
          const body = v.parse(boundaryObjectSchema, JSON.parse(await readBoundedText(response.clone(), 'oauth_exchange_failed', 128 * 1024)));
          refreshTokenReturned = v.is(v.pipe(v.string(), v.minLength(1)), body.refresh_token);
        } catch { /* The exchange parser owns malformed-response handling. */ }
      }
      return response;
    };
    try {
      grant = await exchangeAuthorizationCode({ code: input.code, verifier: input.verifier, config: this.ports.oauth, transport: inspectingTransport });
      grant.assertUsable(exactOperationScopes('gateway-root-finalize'));
      if (refreshTokenReturned) throw new Error('teardown_grant_invalid');
      const authority = await verifyGatewayTeardownJobAuthority({ job: current, trust: this.ports.trust });
      const accountId = authority.certificate.statement.accountId;
      await grant.withAccessToken((accessToken) => verifyCustomerCloudflareGrantAccountAccess({
        accessToken, expectedAccountId: accountId, workerName: authority.certificate.statement.worker.name,
        operation: 'gateway-root-finalize', transport: this.ports.transport,
      }));
      this.forget();
      this.#pending = { attemptId: input.attemptId, grant, accountId, memory: createGatewayRootRemovalAttemptMemory(), bundle: null, passes: 0 };
      this.#retentionTimer = setTimeout(() => { this.#retentionTimer = null; }, GATEWAY_TEARDOWN_ATTEMPT_WINDOW_MS + 1);
      await this.ports.schedule(0);
      return { started: true };
    } catch {
      // An exchange that answered nothing usable may still have issued a token: only a revoked grant is confirmed.
      const revocation = grant === null ? 'unconfirmed' : await this.revoke(grant);
      this.forget();
      await this.settle(input.attemptId, revocation, 'finalization_failed');
      return { started: false };
    }
  }

  /** Runs one pass of the attempt the durable job names. */
  async continue(): Promise<GatewayTeardownFinalizerStep> {
    const job = await this.ports.port.read();
    if (job === null || job.phase !== 'exchanging' || job.attempt === null) {
      this.forget();
      return 'idle';
    }
    const pending = this.#pending;
    if (pending === null || pending.attemptId !== job.attempt.id) {
      // The object restarted between passes: the grant is gone and cannot be revoked here.
      this.forget();
      await this.settle(job.attempt.id, 'unconfirmed', 'grant_lost');
      return 'settled';
    }
    if (job.attempt.expiresAt <= this.ports.now()) return this.end(pending, 'attempt_expired');
    pending.passes += 1;
    if (pending.passes > GATEWAY_TEARDOWN_MAX_PASSES) return this.end(pending, 'passes_exhausted');
    const budget = new GatewayTeardownCallBudget();
    try {
      pending.bundle ??= await this.ports.loadBundle(job.release);
      const bundle = pending.bundle;
      const wait = this.ports.wait ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
      await pending.grant.withAccessToken((accessToken) => executeGatewayRootRemoval({
        port: this.ports.port, trust: this.ports.trust, bundle, attemptId: pending.attemptId, accessToken,
        authorizedAccountId: pending.accountId, transport: this.ports.transport,
        now: this.ports.now, wait, current: job, memory: pending.memory, budget,
      }));
    } catch (error) {
      if (error instanceof GatewayTeardownProviderError && error.code === 'budget_exhausted') {
        // This pass spent its budget; the next one continues from the durable receipts and the attempt memory.
        await this.ports.schedule(0);
        return 'scheduled';
      }
      return this.end(pending, error instanceof GatewayTeardownProviderError ? gatewayTeardownFailureReason(error) : 'finalization_failed');
    }
    return this.end(pending, null);
  }

  /** Whether the attempt's grant is held here; secret-free, for the progress view. */
  holds(attemptId: string): boolean {
    return this.#pending?.attemptId === attemptId;
  }

  private async end(pending: PendingAttempt, reason: string | null): Promise<GatewayTeardownFinalizerStep> {
    const revocation = await this.revoke(pending.grant);
    this.forget();
    await this.settle(pending.attemptId, revocation, revocation === 'unconfirmed' ? reason ?? 'revocation_unconfirmed' : reason);
    return 'settled';
  }

  private async revoke(grant: EphemeralCloudflareGrant): Promise<'confirmed' | 'unconfirmed'> {
    try {
      await grant.revoke(this.ports.transport, this.ports.oauth);
      return 'confirmed';
    } catch {
      return 'unconfirmed';
    } finally {
      grant.discard();
    }
  }

  private async settle(attemptId: string, revocation: 'confirmed' | 'unconfirmed', reason: string | null): Promise<void> {
    const latest = await this.ports.port.read();
    if (latest === null || latest.attempt?.id !== attemptId) return;
    let settled: GatewayTeardownJob;
    try {
      settled = settleGatewayTeardownAttempt({ job: latest, attemptId, revocation, reason, now: this.ports.now() });
    } catch {
      return;
    }
    await this.ports.port.compareAndSet(latest.revision, settled);
  }

  private forget(): void {
    if (this.#retentionTimer !== null) clearTimeout(this.#retentionTimer);
    this.#retentionTimer = null;
    this.#pending?.grant.discard();
    this.#pending = null;
  }
}
