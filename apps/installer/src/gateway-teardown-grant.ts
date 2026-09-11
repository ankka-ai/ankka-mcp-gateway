import * as v from 'valibot';
import { boundaryObjectSchema } from './boundary';
import { OAUTH_EXCHANGE_URL } from './constants';
import { readBoundedText } from './http';

import { exactOperationScopes } from './cloudflare-operation-authority';
import { verifyCustomerCloudflareGrantAccountAccess } from './customer-cloudflare-grant';
import type { GatewayTeardownJobPort } from './gateway-teardown-durable-state';
import type { GatewayTeardownTrust } from './gateway-teardown-handoff';
import { settleGatewayTeardownAttempt, verifyGatewayTeardownJobAuthority } from './gateway-teardown-job';
import { executeGatewayRootRemoval, GatewayTeardownProviderError } from './gateway-teardown-provider';
import { exchangeAuthorizationCode, type EphemeralCloudflareGrant, type CloudflareOauthConfig, type FetchTransport } from './oauth';
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
 * hosted grant executor and the external runner share this body.
 */
export async function runGatewayRootRemovalAttempt(
  input: GatewayRootRemovalAttemptInput & { readonly accessToken: string },
): Promise<string | null> {
  const current = await input.port.read();
  if (current?.phase !== 'exchanging' || current.attempt?.id !== input.attemptId || current.attempt.expiresAt <= input.now()) {
    throw new Error('teardown_callback_invalid');
  }
  try {
    const authority = await verifyGatewayTeardownJobAuthority({ job: current, trust: input.trust });
    const accountId = authority.certificate.statement.accountId;
    await verifyCustomerCloudflareGrantAccountAccess({
      accessToken: input.accessToken, expectedAccountId: accountId, workerName: authority.certificate.statement.worker.name,
      operation: 'gateway-root-finalize', transport: input.transport,
    });
    await executeGatewayRootRemoval({ ...input, authorizedAccountId: accountId });
    return null;
  } catch (error) {
    return error instanceof GatewayTeardownProviderError ? `${error.stage}_${error.code}` : 'finalization_failed';
  }
}

/** A distinct fixed hosted operation; neither bootstrap cleanup nor its scopes change. */
export async function executeGatewayTeardownGrant(input: GatewayRootRemovalAttemptInput & {
  readonly code: string; readonly verifier: string; readonly config: CloudflareOauthConfig;
}) {
  const current = await input.port.read();
  if (current?.phase !== 'exchanging' || current.attempt?.id !== input.attemptId || current.attempt.expiresAt <= input.now()) {
    throw new Error('teardown_callback_invalid');
  }
  let grant: EphemeralCloudflareGrant | null = null;
  let revocation: 'confirmed' | 'unconfirmed' = 'unconfirmed';
  let reason: string | null = null;
  let refreshTokenReturned = false;
  const inspectingTransport: FetchTransport = async (request, init) => {
    const response = await input.transport(request, init);
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
    grant = await exchangeAuthorizationCode({ ...input, transport: inspectingTransport });
    grant.assertUsable(exactOperationScopes('gateway-root-finalize'));
    if (refreshTokenReturned) throw new Error('teardown_grant_invalid');
    reason = await grant.withAccessToken((accessToken) => runGatewayRootRemovalAttempt({ ...input, accessToken }));
  } catch {
    reason = 'finalization_failed';
  } finally {
    if (grant !== null) {
      try { await grant.revoke(input.transport, input.config); revocation = 'confirmed'; }
      catch { reason ??= 'revocation_unconfirmed'; }
      finally { grant.discard(); }
    }
  }
  const latest = await input.port.read();
  if (latest === null) throw new Error('teardown_job_missing');
  const job = settleGatewayTeardownAttempt({ job: latest, attemptId: input.attemptId, revocation, reason, now: input.now() });
  if (!await input.port.compareAndSet(latest.revision, job)) throw new Error('teardown_job_conflict');
  return { job, reason };
}
