import { verifyCustomerCloudflareGrantAccountAccess } from './customer-cloudflare-grant';
import type { GatewayTeardownJobPort } from './gateway-teardown-durable-state';
import type { GatewayTeardownTrust } from './gateway-teardown-handoff';
import { verifyGatewayTeardownJobAuthority, type GatewayTeardownJob } from './gateway-teardown-job';
import {
  executeGatewayRootRemoval, gatewayTeardownFailureReason, GatewayTeardownCallBudget, GatewayTeardownProviderError,
} from './gateway-teardown-provider';
import type { FetchTransport } from './oauth';
import type { VerifiedReleaseBundle } from './release';

export interface GatewayRootRemovalAttemptInput {
  readonly port: GatewayTeardownJobPort;
  readonly attemptId: string;
  readonly trust: GatewayTeardownTrust;
  readonly bundle: VerifiedReleaseBundle;
  readonly transport: FetchTransport;
  readonly now: () => number;
  readonly wait?: (milliseconds: number) => Promise<void>;
}

/**
 * One root-removal attempt with a credential already in hand: bind it to the
 * installed account, then run the fixed removal against the durable job.
 * Returns the secret-free failure reason, or null when every step verified.
 * The caller owns the credential's lifecycle and settles the attempt; the
 * hosted grant executor and the external runner share this body. A budget,
 * when given, counts every provider and journal call of the attempt and
 * stops it with the resumable `budget_exhausted` reason before the cap.
 */
export async function runGatewayRootRemovalAttempt(
  input: GatewayRootRemovalAttemptInput & {
    readonly accessToken: string;
    readonly budget?: GatewayTeardownCallBudget;
    /** The job as the caller just read it from the same port, so the attempt reads it once. */
    readonly current?: GatewayTeardownJob;
  },
): Promise<string | null> {
  const port = input.budget === undefined ? input.port : input.budget.port(input.port);
  const current = input.current ?? await port.read();
  if (current?.phase !== 'exchanging' || current.attempt?.id !== input.attemptId || current.attempt.expiresAt <= input.now()) {
    throw new Error('teardown_callback_invalid');
  }
  try {
    const authority = await verifyGatewayTeardownJobAuthority({ job: current, trust: input.trust });
    const accountId = authority.certificate.statement.accountId;
    input.budget?.charge('account');
    await verifyCustomerCloudflareGrantAccountAccess({
      accessToken: input.accessToken, expectedAccountId: accountId, workerName: authority.certificate.statement.worker.name,
      operation: 'gateway-root-finalize', transport: input.transport,
    });
    await executeGatewayRootRemoval({ ...input, port, current, authorizedAccountId: accountId });
    return null;
  } catch (error) {
    return error instanceof GatewayTeardownProviderError ? gatewayTeardownFailureReason(error) : 'finalization_failed';
  }
}
