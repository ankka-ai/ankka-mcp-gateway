import * as v from 'valibot';

import type { CustomerBootstrapState } from './customer-bootstrap-state';
import type { CustomerGatewayOwnershipStorage } from './customer-gateway-ownership-state';
import type { CustomerManagementCredentialWord } from './customer-install-status';
import type { CustomerStage2ConvergerResult } from './customer-stage2-converger';

/**
 * The management credential step of setup. Everything the dashboard does day
 * to day writes into the customer's own Cloudflare account, and the install's
 * approvals are discarded minutes later, so the gateway needs one standing
 * credential of its own: an account-owned API token, stored as the Worker
 * secret `ANKKA_MANAGEMENT_TOKEN`.
 *
 * The customer creates the token from a Cloudflare template link and pastes it
 * into their own gateway's setup page. The value travels browser to customer
 * Worker only. It is held in the owning Durable Object's memory, beside the
 * install grant, until the final runtime upload writes it as a secret binding.
 * It is never written to Durable Object storage, the journal, a receipt, a
 * log line, an error, a URL, or any response, and it never passes through
 * anything Ankka hosts. An object restart loses it; setup waits for another
 * paste before the final approval can complete.
 */

/** Where the customer's own setup page sends the pasted value, once, by same-origin POST. */
export const CUSTOMER_INSTALL_MANAGEMENT_STEP_PATH = '/__ankka/install/management-token' as const;

/** The Worker secret binding the signed release contract declares as customer-managed and optional. */
export const CUSTOMER_MANAGEMENT_BINDING = 'ANKKA_MANAGEMENT_TOKEN' as const;

/**
 * The two permissions the template link pre-fills on Cloudflare's account
 * token page: "Access: Apps and Policies Edit" and "MCP Portals Edit". A link
 * built from exactly these keys was verified against the Cloudflare dashboard
 * on 2026-09-19: it pre-filled both permissions.
 */
export const CLOUDFLARE_MANAGEMENT_PERMISSION_GROUP_KEYS = Object.freeze([
  Object.freeze({ key: 'access', type: 'edit' }),
  Object.freeze({ key: 'mcp_portals', type: 'edit' }),
] as const);

/** The pre-filled name carries the management hostname, so the token can be found again in Cloudflare later. */
export function customerManagementCredentialName(managementHostname: string): string {
  return `Ankka gateway ${managementHostname}`;
}

/**
 * Cloudflare's template link for an account-owned token. `to` and its
 * `:account` placeholder stay literal, as Cloudflare documents the link; the
 * dashboard asks which account when there is more than one. The link carries
 * permission keys and a name, never a credential.
 */
export function customerManagementCredentialTemplateLink(managementHostname: string): string {
  const permissions = encodeURIComponent(JSON.stringify(CLOUDFLARE_MANAGEMENT_PERMISSION_GROUP_KEYS));
  const name = encodeURIComponent(customerManagementCredentialName(managementHostname));
  return `https://dash.cloudflare.com/?to=/:account/api-tokens&permissionGroupKeys=${permissions}&name=${name}`;
}

/**
 * The two forms Cloudflare documents for an account API token
 * (developers.cloudflare.com/fundamentals/api/get-started/token-formats):
 * the scannable `cfat_[40 characters][checksum]` and the earlier unprefixed
 * 40-character form, which "continues to work". Cloudflare publishes neither
 * the checksum's length nor its algorithm (the sibling Access service-token
 * secret of the 2026-08-26 changelog uses eight characters), so the scannable
 * form is accepted with 40 to 64 alphanumeric characters after its prefix and
 * the checksum is not recomputed: this check catches a wrong paste, and
 * Cloudflare alone judges the token. Cloudflare calls the earlier form
 * alphanumeric; tokens issued in it also contain `-` and `_`. Nothing else is
 * accepted: a user token (`cfut_`) or a Global API Key (`cfk_`) is not
 * account-owned.
 */
const SCANNABLE_ACCOUNT_FORM = /^cfat_[A-Za-z0-9]{40,64}$/u;
const LEGACY_ACCOUNT_FORM = /^[A-Za-z0-9_-]{40}$/u;
const MAX_LENGTH = 69;

export const customerManagementCredentialSchema = v.pipe(
  v.string(),
  v.maxLength(MAX_LENGTH),
  v.check((value) => SCANNABLE_ACCOUNT_FORM.test(value) || LEGACY_ACCOUNT_FORM.test(value)),
);

/** The value when it has one of the two account token forms, else null. Nothing about a refused value is kept. */
export function parseCustomerManagementCredential(value: string): string | null {
  return v.is(customerManagementCredentialSchema, value) ? value : null;
}

/**
 * Longer than any install: a ten-minute setup session, an approval inside
 * it, and the fifteen-minute convergence deadline. A value older than this
 * is discarded whatever the install is doing.
 */
export const CUSTOMER_MANAGEMENT_CREDENTIAL_HOLD_MS = 30 * 60 * 1_000;

/**
 * Keeps the pasted value in object memory, and nowhere else, from the setup
 * page's POST until the final runtime upload. A bounded timer prevents normal
 * idle hibernation, exactly as the convergence driver's does for the grant;
 * it carries nothing and does no work beyond forgetting the value when the
 * hold runs out. `tendCustomerManagementCredential` keeps the object from
 * being evicted while the customer approves in Cloudflare. An object that is
 * restarted anyway loses the value, and setup waits for another paste.
 */
export class CustomerManagementCredentialHolder {
  #value: string | null = null;
  #heldUntil = 0;
  #installed = false;
  #retention: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly now: () => number) {}

  /** Replaces any earlier value. The caller has already validated the form. */
  hold(value: string): void {
    if (parseCustomerManagementCredential(value) === null) throw new Error('customer_management_credential_invalid');
    this.release();
    this.#value = value;
    this.#heldUntil = this.now() + CUSTOMER_MANAGEMENT_CREDENTIAL_HOLD_MS;
    this.#installed = false;
    this.#retention = setTimeout(() => this.release(), CUSTOMER_MANAGEMENT_CREDENTIAL_HOLD_MS);
  }

  /** The value for the final runtime upload; undefined when none is held or the hold has run out. */
  value(): string | undefined {
    if (this.#value === null) return undefined;
    if (this.now() >= this.#heldUntil) {
      this.release();
      return undefined;
    }
    return this.#value;
  }

  /** The final runtime upload carried the value: nothing keeps it after that. */
  markInstalled(): void {
    this.release();
    this.#installed = true;
  }

  /** Forgets the value and frees the timer. */
  release(): void {
    if (this.#retention !== null) clearTimeout(this.#retention);
    this.#retention = null;
    this.#value = null;
    this.#heldUntil = 0;
  }

  /**
   * One fixed word for the status route. `choice` is the durable, secret-free
   * record of what the customer chose; memory says whether the value is
   * still here. A provided value that memory no longer holds was dropped.
   */
  word(choice: CustomerManagementChoice | null): CustomerManagementCredentialWord | undefined {
    if (this.#installed) return 'installed';
    if (this.value() !== undefined) return 'held';
    if (choice === 'provided') return 'dropped';
    return choice === 'skipped' ? 'skipped' : undefined;
  }
}

/**
 * One converger pass with whatever value memory still holds. Only the pass
 * that uploads the final runtime uses the value; once that pass has ended in
 * the upload, whether it read the result back or handed over to the final
 * runtime, nothing keeps the value. No value held: the pass runs without one
 * and the install completes without the secret. A pass that throws keeps the
 * value for the attempt a fresh approval starts.
 */
export async function runConvergerPassWithManagementCredential(
  holder: CustomerManagementCredentialHolder,
  pass: (managementCredential: string | undefined) => Promise<CustomerStage2ConvergerResult>,
): Promise<CustomerStage2ConvergerResult> {
  const managementCredential = holder.value();
  const result = await pass(managementCredential);
  if (managementCredential !== undefined && (result.verified || 'handedOver' in result)) holder.markInstalled();
  return result;
}

/** How often a holding object wakes itself while it waits for the customer's approval. */
export const CUSTOMER_MANAGEMENT_CREDENTIAL_KEEP_ALIVE_MS = 30 * 1_000;

/** The object's one alarm, as its storage exposes it. */
export interface CustomerManagementCredentialAlarmPort {
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number): Promise<void>;
}

/**
 * True while an approval could still use a held value: an install is
 * running, or the setup session can still start or finish an approval.
 */
export function customerManagementCredentialUsable(state: CustomerBootstrapState | null, now: number): boolean {
  if (state === null) return false;
  if (state.status === 'CONVERGING') return true;
  return state.status === 'INCOMPLETE' && state.session !== null && state.session.expiresAt > now;
}

/**
 * Whether an alarm runs a converger pass. The converger's own alarms always
 * do. A keep-alive tick of this module does only when the driver holds a
 * grant: between the paste and the install a callback may be exchanging its
 * code at this very moment, with the state already CONVERGING and the grant
 * not yet handed over, and a pass would settle that attempt as `grant_lost`.
 * Without keep-alive ticks no alarm can be pending at that moment, so this is
 * the one hazard they add, and the one place that closes it.
 */
export function customerConvergerRunsOnAlarm(keepAliveTick: boolean, driverHoldsGrant: boolean): boolean {
  return !keepAliveTick || driverHoldsGrant;
}

export type CustomerManagementCredentialTending = 'idle' | 'released' | 'kept';

/**
 * Looks after a held value between the paste and the install. A pending
 * timer only prevents hibernation; the platform still evicts an object after
 * one to two minutes without a request or an event, and the customer may
 * spend longer than that approving in Cloudflare. So while a value is held
 * and still usable, the object keeps one alarm ahead of itself. It never
 * replaces an alarm that is already set: the converger's passes and the
 * handover own the alarm whenever they need it. A value no approval can use
 * any more is forgotten at once. Storage sees an alarm time and nothing else.
 */
export async function tendCustomerManagementCredential(
  holder: CustomerManagementCredentialHolder,
  state: CustomerBootstrapState | null,
  alarms: CustomerManagementCredentialAlarmPort,
  now: number,
): Promise<CustomerManagementCredentialTending> {
  if (holder.value() === undefined) return 'idle';
  if (!customerManagementCredentialUsable(state, now)) {
    holder.release();
    return 'released';
  }
  if (await alarms.getAlarm() === null) await alarms.setAlarm(now + CUSTOMER_MANAGEMENT_CREDENTIAL_KEEP_ALIVE_MS);
  return 'kept';
}

/** What the customer chose at the step. A fixed word; the value itself is never stored. */
export type CustomerManagementChoice = 'provided' | 'skipped';

const CHOICE_KEY = 'ankka-mcp-gateway/management-credential-choice/v1';
const choiceSchema = v.strictObject({
  schemaVersion: v.literal(1),
  choice: v.picklist(['provided', 'skipped']),
});

export async function readCustomerManagementChoice(
  storage: CustomerGatewayOwnershipStorage,
): Promise<CustomerManagementChoice | null> {
  const parsed = v.safeParse(choiceSchema, await storage.get(CHOICE_KEY));
  return parsed.success ? parsed.output.choice : null;
}

/** What the setup router needs from the step; the host decides where the value lives. */
export interface CustomerManagementCredentialStep {
  /** Takes a validated value into memory and records only that one was provided. */
  readonly accept: (value: string) => Promise<void>;
  /** One fixed word, or undefined before the customer has chosen. */
  readonly word: () => Promise<CustomerManagementCredentialWord | undefined>;
}

/** Binds the in-memory holder to the object's storage, which only ever receives the fixed choice word. */
export function createCustomerManagementCredentialStep(
  holder: CustomerManagementCredentialHolder,
  storage: CustomerGatewayOwnershipStorage,
): CustomerManagementCredentialStep {
  const record = (choice: CustomerManagementChoice): Promise<void> =>
    storage.put(CHOICE_KEY, { schemaVersion: 1, choice });
  return Object.freeze({
    accept: async (value: string) => {
      // The word is durable before the value is held, so a value lost to a
      // restart is reported as dropped rather than as never provided.
      await record('provided');
      holder.hold(value);
    },
    word: async () => holder.word(await readCustomerManagementChoice(storage)),
  });
}
