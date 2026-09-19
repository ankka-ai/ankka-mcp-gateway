import { CLOUDFLARE_API_ORIGIN } from './constants';
import type { CustomerCloudflareTransport } from './customer-cloudflare-grant';
import {
  CUSTOMER_MANAGEMENT_BINDING,
  parseCustomerManagementCredential,
} from './customer-management-credential';

const ACCOUNT_ID = /^[a-f0-9]{32}$/u;
const WORKER_NAME = /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const WRITE_DEADLINE_MS = 15_000;

/**
 * What one Worker-secret write ended as. `unconfirmed` means Cloudflare gave
 * no answer in time: the secret may or may not exist, and the gateway's own
 * runtime shows which by receiving the binding or not.
 */
export type CustomerManagementSecretWrite =
  | { readonly written: true }
  | { readonly written: false; readonly reason: 'secret_write_refused' | 'secret_write_unconfirmed' | `secret_write_http_${number}` };

/**
 * Writes the pasted management token as the gateway Worker's own
 * `ANKKA_MANAGEMENT_TOKEN` secret, with the one-time grant of the fixed
 * `management-credential` operation.
 *
 * Exactly one provider call, never retried: a repeat after a lost answer
 * could only write the same value again, and the caller's approval is spent
 * either way. Cloudflare answers 201 for a new secret and 200 for a replaced
 * one. The answer's body is cancelled unread, no exception is kept, and the
 * result is a fixed word with at most the HTTP status, so nothing this
 * function returns or throws can carry the value.
 */
export async function writeCustomerManagementCredentialSecret(input: {
  readonly accessToken: string;
  readonly accountId: string;
  readonly workerName: string;
  readonly value: string;
  readonly transport: CustomerCloudflareTransport;
}): Promise<CustomerManagementSecretWrite> {
  if (!ACCOUNT_ID.test(input.accountId) || !WORKER_NAME.test(input.workerName) ||
      parseCustomerManagementCredential(input.value) === null) {
    return { written: false, reason: 'secret_write_refused' };
  }
  const url = new URL(
    `/client/v4/accounts/${input.accountId}/workers/scripts/${encodeURIComponent(input.workerName)}/secrets`,
    CLOUDFLARE_API_ORIGIN,
  );
  let response: Response;
  try {
    response = await input.transport(url, {
      method: 'PUT',
      redirect: 'manual',
      signal: AbortSignal.timeout(WRITE_DEADLINE_MS),
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${input.accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: CUSTOMER_MANAGEMENT_BINDING, text: input.value, type: 'secret_text' }),
    });
  } catch {
    return { written: false, reason: 'secret_write_unconfirmed' };
  }
  try {
    await response.body?.cancel();
  } catch {
    // The status alone decides; an unreadable body changes nothing.
  }
  if (response.status === 200 || response.status === 201) return { written: true };
  return { written: false, reason: `secret_write_http_${response.status}` };
}
