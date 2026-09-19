import { canonicalJson } from './canonical-json';
import { operationSignature } from './customer-operation-secrets';

/** One signed command to the gateway's own record of a management token change. */
export interface CustomerManagementCredentialControl {
  readonly actionId: string;
  readonly actionKey: string;
  readonly actionExpiresAt: number;
  /** `begin` right before the one write; `complete` or `fail` as its end, which releases the lifecycle lock. */
  readonly command: 'begin' | 'complete' | 'fail';
  /** A fixed word, only with `fail`. */
  readonly failureCode?: string;
}

/**
 * The command as the payload's internal route accepts it: canonical JSON,
 * signed with the action's one-time key. It names the action and its end.
 * The pasted token is never part of it, and the route refuses any other key.
 */
export async function customerManagementCredentialControlRequest(
  input: CustomerManagementCredentialControl,
  issuedAt: number,
): Promise<Request> {
  const command = {
    schemaVersion: 1,
    actionId: input.actionId,
    actionKey: input.actionKey,
    command: input.command,
    issuedAt,
    expiresAt: input.actionExpiresAt,
  };
  const body = canonicalJson(input.command === 'fail'
    ? { ...command, failureCode: input.failureCode ?? 'unexpected' }
    : command);
  return new Request('https://admin-state.invalid/management-credential-actions/control', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-ankka-management-credential-signature': await operationSignature(input.actionKey, body),
    },
    body,
  });
}
