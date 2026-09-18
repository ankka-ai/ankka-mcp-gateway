import * as v from 'valibot';
import { bigQueryCredentialPage } from './customer-bigquery-credential-page';
import { readBigQueryText } from './customer-bigquery-contract';
import type { BigQueryOperationInput } from './customer-bigquery-setup';

import { canonicalJson } from './canonical-json';
import type { CustomerCloudflareOperation } from './cloudflare-operation-authority';
import {
  base64UrlDecode,
  constantTimeEqual,
  pkceChallenge,
  randomBase64Url,
  sha256,
} from './crypto';
import {
  type CustomerBootstrapRelayStart,
  validCustomerBootstrapRelayAuthorization,
} from './customer-bootstrap-router';
import {
  CustomerCloudflareGrantError,
  exchangeCustomerCloudflareAuthorizationCode,
  verifyCustomerCloudflareGrantAccountAccess,
  type CustomerCloudflareTransport,
  type EphemeralCustomerCloudflareGrant,
} from './customer-cloudflare-grant';
import {
  CUSTOMER_INSTALL_OAUTH_CALLBACK_PATH,
  CUSTOMER_OPERATION_OAUTH_START_PATH,
  CUSTOMER_OPERATION_ROOT_PATH,
  CUSTOMER_OPERATION_UPDATE_PATH,
  CUSTOMER_OPERATION_UPDATE_PROGRESS_PATH,
} from './customer-install-paths';
import { operationSignature } from './customer-operation-secrets';
import type { CustomerRuntimeUpdateTarget } from './customer-runtime-update';
import {
  CUSTOMER_UPDATE_STAGES,
  customerServingRelease,
  customerUpdateProgressSchema,
  type CustomerUpdateProgress,
  type CustomerUpdateStage,
  type CustomerUpdateView,
} from './customer-update-driver';

/**
 * Gateway-local authorization for a later operation.
 *
 * The dashboard prepares a source installation or a runtime update inside the
 * gateway and hands the browser a same-origin fragment carrying the one-time
 * action key. This router turns that handoff into a fresh Cloudflare consent
 * for exactly the operation's scopes, using the public client and callback
 * the ownership trust certified for the install, then runs the operation with
 * the request-local grant and revokes it. An update instead hands the grant
 * and the key to the management object's memory and answers with the page
 * that follows the upload. Nothing about the grant, the PKCE verifier, or the
 * action key is written to durable storage: the verifier and the key ride in
 * one HttpOnly cookie, the attempt record keeps only hashes, identifiers, and
 * expiries.
 */
export const CUSTOMER_OPERATION_COOKIE = '__Host-ankka_operation';
export const CUSTOMER_OPERATION_ATTEMPT_TTL_MS = 10 * 60 * 1_000;
/** A prepared action lives ten minutes on the gateway's clock; allow a little skew when reading it. */
const MAX_ACTION_LIFETIME_MS = 11 * 60 * 1_000;
const CLOCK_SKEW_MS = 30 * 1_000;

const ATTEMPT_ID = /^attempt_[A-Za-z0-9_-]{24}$/u;
const TOKEN = /^[A-Za-z0-9_-]{43}$/u;
const ACTION_ID = /^action_[A-Za-z0-9_-]{32}$/u;
const ACCOUNT_ID = /^[a-f0-9]{32}$/u;
const AUTHORIZATION_CODE = /^[A-Za-z0-9._~-]{8,4096}$/u;
const RELAY_TICKET = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/u;
const HANDOFF = /^[A-Za-z0-9_-]{40,8192}$/u;
const EMAIL = /^[^\s@]{1,64}@[A-Za-z0-9.-]{1,190}$/u;
const WORKER_NAME = /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const RELEASE = /^gateway-v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const KEY_ID = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u;
const ARTIFACT_SHA256 = /^[a-f0-9]{64}$/u;
const PREFIXED_SHA256 = /^sha256:[a-f0-9]{64}$/u;
const VERSION_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const MAX_COOKIE_BYTES = 8 * 1024;
const MAX_BODY_BYTES = 16 * 1024;
const MAX_APPLY_RESPONSE_BYTES = 64 * 1024;

const configSchema = v.strictObject({
  accountId: v.pipe(v.string(), v.regex(ACCOUNT_ID)),
  installId: v.pipe(v.string(), v.regex(/^acg-[a-f0-9]{24}$/u)),
  publicClientId: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{16,128}$/u)),
  managementOrigin: v.pipe(v.string(), v.url()),
  workerName: v.pipe(v.string(), v.regex(WORKER_NAME)),
  workersSubdomain: v.pipe(v.string(), v.regex(DNS_LABEL)),
  release: v.pipe(v.string(), v.regex(RELEASE)),
  artifactSha256: v.pipe(v.string(), v.regex(ARTIFACT_SHA256)),
});

/** The exact release identity the gateway wrote into a source handoff. */
const releaseIdentitySchema = v.strictObject({
  schemaVersion: v.literal(1),
  channel: v.picklist(['canary', 'stable']),
  controlPlaneOrigin: v.pipe(v.string(), v.url()),
  release: v.pipe(v.string(), v.regex(RELEASE)),
  keyId: v.pipe(v.string(), v.regex(KEY_ID)),
  publicKey: v.pipe(v.string(), v.regex(TOKEN)),
  artifactSha256: v.pipe(v.string(), v.regex(ARTIFACT_SHA256)),
});

const commonClaimEntries = {
  actionId: v.pipe(v.string(), v.regex(ACTION_ID)),
  actionKey: v.pipe(v.string(), v.regex(TOKEN)),
  actorEmail: v.pipe(v.string(), v.maxLength(256), v.regex(EMAIL)),
  accountId: v.pipe(v.string(), v.regex(ACCOUNT_ID)),
  controlPlaneOrigin: v.pipe(v.string(), v.url()),
  workerName: v.pipe(v.string(), v.regex(WORKER_NAME)),
  workersSubdomain: v.pipe(v.string(), v.regex(DNS_LABEL)),
  managementOrigin: v.pipe(v.string(), v.url()),
  expiresAt: v.pipe(v.number(), v.safeInteger()),
};

/** A source installation handoff, exactly as the gateway's prepare route builds it. */
const sourceActionClaimSchema = v.strictObject({
  schemaVersion: v.literal(1),
  ...commonClaimEntries,
  releaseIdentity: releaseIdentitySchema,
});

const bigQueryActionClaimSchema = v.strictObject({
  ...sourceActionClaimSchema.entries, actionType: v.literal('bigquery_setup'),
});
const bigQueryCallbackSchema = v.strictObject({
  code: v.pipe(v.string(), v.regex(AUTHORIZATION_CODE)),
  state: v.pipe(v.string(), v.regex(TOKEN)),
  serviceAccountJson: v.pipe(v.string(), v.minLength(1), v.maxLength(16_384)),
});

const runtimeVersionSchema = v.strictObject({
  release: v.pipe(v.string(), v.regex(RELEASE)),
  artifactSha256: v.pipe(v.string(), v.regex(PREFIXED_SHA256)),
  versionId: v.union([v.pipe(v.string(), v.regex(VERSION_ID)), v.null()]),
});

/** A runtime update handoff, exactly as the gateway's update prepare route builds it. */
const runtimeActionClaimSchema = v.strictObject({
  schemaVersion: v.literal(2),
  actionType: v.literal('runtime_update'),
  ...commonClaimEntries,
  operation: v.picklist(['update', 'rollback']),
  from: runtimeVersionSchema,
  to: runtimeVersionSchema,
});

const startBodySchema = v.strictObject({
  schemaVersion: v.literal(1),
  handoff: v.pipe(v.string(), v.regex(HANDOFF)),
});

const appliedSchema = v.strictObject({
  schemaVersion: v.literal(1),
  actionId: v.pipe(v.string(), v.regex(ACTION_ID)),
  sourceId: v.pipe(v.string(), v.regex(/^source-[a-f0-9]{16}$/u)),
  status: v.literal('succeeded'),
  expiresAt: v.pipe(v.string(), v.isoTimestamp()),
  failureCode: v.null(),
});

const targetSchema = v.strictObject({
  release: v.pipe(v.string(), v.regex(RELEASE)),
  artifactSha256: v.pipe(v.string(), v.regex(PREFIXED_SHA256)),
});

export const customerOperationAttemptSchema = v.strictObject({
  schemaVersion: v.literal(1),
  attemptId: v.pipe(v.string(), v.regex(ATTEMPT_ID)),
  kind: v.picklist(['source', 'bigquery', 'runtime']),
  operation: v.picklist(['source-add', 'bigquery-add', 'upgrade', 'rollback']),
  actionId: v.pipe(v.string(), v.regex(ACTION_ID)),
  actorEmail: v.pipe(v.string(), v.maxLength(256), v.regex(EMAIL)),
  actionExpiresAt: v.pipe(v.number(), v.safeInteger()),
  /** Where a runtime update fetches the signed bundle; as the gateway named it in the handoff. */
  controlPlaneOrigin: v.pipe(v.string(), v.url()),
  /** The runtime release to reach; null for a source installation. */
  target: v.union([targetSchema, v.null()]),
  stateHash: v.pipe(v.string(), v.regex(TOKEN)),
  phase: v.picklist(['authorizing', 'exchanging']),
  expiresAt: v.pipe(v.number(), v.safeInteger()),
});

export type CustomerOperationAttempt = v.InferOutput<typeof customerOperationAttemptSchema>;
type SourceActionClaim = v.InferOutput<typeof sourceActionClaimSchema>;
type RuntimeActionClaim = v.InferOutput<typeof runtimeActionClaimSchema>;
type DecodedClaim =
  | { readonly kind: 'source'; readonly claim: SourceActionClaim }
  | { readonly kind: 'bigquery'; readonly claim: v.InferOutput<typeof bigQueryActionClaimSchema> }
  | { readonly kind: 'runtime'; readonly claim: RuntimeActionClaim };

/** One attempt per gateway, durable so the callback can refuse replays. */
export interface CustomerOperationAttemptPort {
  read(): Promise<CustomerOperationAttempt | null>;
  write(attempt: CustomerOperationAttempt): Promise<void>;
  clear(): Promise<void>;
}

/** What the gateway's own action routes report about a prepared action. */
export interface CustomerOperationActionView {
  readonly status: string;
  readonly expiresAt: number;
}

export type CustomerOperationResult = 'applied' | 'failed' | 'denied' | 'revocation_unconfirmed';

export interface CustomerOperationRuntimeUpdateInput {
  readonly accessToken: string;
  readonly actionId: string;
  readonly actionKey: string;
  readonly actorEmail: string;
  readonly actionExpiresAt: number;
  readonly controlPlaneOrigin: string;
  readonly operation: 'update' | 'rollback';
  readonly target: CustomerRuntimeUpdateTarget;
  /** Told each stage the update reaches, for the page that follows it. */
  readonly onStage?: (stage: CustomerUpdateStage) => void;
}

export interface CustomerOperationRouterConfig {
  readonly accountId: string;
  readonly installId: string;
  readonly publicClientId: string;
  readonly managementOrigin: string;
  readonly workerName: string;
  readonly workersSubdomain: string;
  readonly release: string;
  readonly artifactSha256: string;
}

export interface CustomerOperationRouterDependencies {
  readonly attempts: CustomerOperationAttemptPort;
  readonly transport: CustomerCloudflareTransport;
  /** Throws unless the install is complete and the ownership trust names the callback. */
  readonly assertOperational: () => Promise<void>;
  readonly readSourceAction: (actionId: string) => Promise<CustomerOperationActionView | null>;
  readonly readBigQueryAction?: (actionId: string) => Promise<CustomerOperationActionView | null>;
  readonly runBigQuerySetup?: (input: BigQueryOperationInput) => Promise<Response>;
  readonly readRuntimeAction: (actionId: string) => Promise<CustomerOperationActionView | null>;
  readonly issueRelayTicket: (operation: CustomerCloudflareOperation) => Promise<{
    readonly relayTicket: string;
    readonly expiresAt: number;
  }>;
  readonly beginRelay: (input: {
    readonly operation: CustomerCloudflareOperation;
    readonly gatewayState: string;
    readonly pkceChallenge: string;
    readonly gatewayCallback: string;
    readonly relayTicket: string;
  }) => Promise<CustomerBootstrapRelayStart>;
  /** Submits the signed claim to the gateway's own apply route, in process. */
  readonly applySourceAction: (input: {
    readonly body: string;
    readonly signature: string;
  }) => Promise<Response>;
  /** Takes an update's grant and action key into the management object's memory and arms the pass that uploads. */
  readonly startRuntimeUpdate: (input: {
    readonly attempt: CustomerOperationAttempt;
    readonly grant: EphemeralCustomerCloudflareGrant;
    readonly actionKey: string;
  }) => Promise<'started' | 'failed'>;
  /** The update attempt as the management object knows it; null for an unknown attempt. */
  readonly updateView: (attemptId: string) => Promise<CustomerUpdateView | null>;
  readonly now?: () => number;
}

function headers(contentType = 'application/json; charset=utf-8'): Headers {
  return new Headers({
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    'content-type': contentType,
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  });
}

function json<Value>(value: Value, status = 200, cookies: readonly string[] = []): Response {
  const responseHeaders = headers();
  for (const cookie of cookies) responseHeaders.append('set-cookie', cookie);
  return new Response(JSON.stringify(value), { status, headers: responseHeaders });
}

function notFound(): Response {
  return json({ schemaVersion: 1, error: 'not_found' }, 404);
}

function operationCookie(input: {
  readonly attemptId: string;
  readonly expiresAt: number;
  readonly verifier: string;
  readonly actionKey: string;
  readonly now: number;
}): string {
  const maxAge = Math.max(1, Math.floor((input.expiresAt - input.now) / 1_000));
  return `${CUSTOMER_OPERATION_COOKIE}=${input.attemptId}.${input.expiresAt}.${input.verifier}.${input.actionKey}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Lax`;
}

function clearCookie(): string {
  return `${CUSTOMER_OPERATION_COOKIE}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; HttpOnly; SameSite=Lax`;
}

function oneCookie(request: Request): string | null {
  const raw = request.headers.get('cookie');
  if (raw === null || raw.length > MAX_COOKIE_BYTES) return null;
  const matches = raw.split(';').map((entry) => entry.trim()).filter((entry) =>
    entry.startsWith(`${CUSTOMER_OPERATION_COOKIE}=`));
  return matches.length === 1 ? matches[0]?.slice(CUSTOMER_OPERATION_COOKIE.length + 1) ?? null : null;
}

/** True when the browser carries an operation attempt, which claims the shared callback. */
export function customerOperationCookiePresent(request: Request): boolean {
  return oneCookie(request) !== null;
}

function readOperationCookie(request: Request, now: number): Readonly<{
  attemptId: string;
  expiresAt: number;
  verifier: string;
  actionKey: string;
}> | null {
  const parts = oneCookie(request)?.split('.') ?? [];
  if (parts.length !== 4) return null;
  const [attemptId = '', serializedExpiresAt = '', verifier = '', actionKey = ''] = parts;
  if (!ATTEMPT_ID.test(attemptId) || !/^\d{1,16}$/u.test(serializedExpiresAt) ||
      !TOKEN.test(verifier) || !TOKEN.test(actionKey)) return null;
  const expiresAt = Number(serializedExpiresAt);
  return Number.isSafeInteger(expiresAt) && expiresAt > now
    ? Object.freeze({ attemptId, expiresAt, verifier, actionKey })
    : null;
}

function sameOriginJsonMutation(request: Request, expectedOrigin: string): boolean {
  const url = new URL(request.url);
  const fetchSite = request.headers.get('sec-fetch-site');
  return url.origin === expectedOrigin && request.headers.get('origin') === expectedOrigin &&
    (fetchSite === null || fetchSite === 'same-origin') &&
    request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ===
      'application/json';
}

async function startBody(request: Request): Promise<v.InferOutput<typeof startBodySchema> | null> {
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d{1,6}$/u.test(declared) || Number(declared) > MAX_BODY_BYTES)) return null;
  try {
    const body = await readBigQueryText(request.body, MAX_BODY_BYTES);
    const parsed = v.safeParse(startBodySchema, JSON.parse(body));
    return parsed.success ? parsed.output : null;
  } catch {
    return null;
  }
}

function decodeClaim(handoff: string): DecodedClaim | null {
  let decoded: v.InferInput<typeof startBodySchema> | null;
  try {
    decoded = JSON.parse(new TextDecoder().decode(base64UrlDecode(handoff)));
  } catch {
    return null;
  }
  const source = v.safeParse(sourceActionClaimSchema, decoded);
  if (source.success) return { kind: 'source', claim: source.output };
  const bigquery = v.safeParse(bigQueryActionClaimSchema, decoded);
  if (bigquery.success) return { kind: 'bigquery', claim: bigquery.output };
  const runtime = v.safeParse(runtimeActionClaimSchema, decoded);
  if (runtime.success) return { kind: 'runtime', claim: runtime.output };
  return null;
}

function claimMatches(
  decoded: DecodedClaim,
  config: v.InferOutput<typeof configSchema>,
  now: number,
): boolean {
  const { claim } = decoded;
  const identity = decoded.kind !== 'runtime'
    ? decoded.claim.releaseIdentity.release === config.release &&
      decoded.claim.releaseIdentity.artifactSha256 === config.artifactSha256
    : decoded.claim.from.release === config.release &&
      decoded.claim.from.artifactSha256 === `sha256:${config.artifactSha256}` &&
      decoded.claim.to.release !== decoded.claim.from.release;
  return identity && claim.accountId === config.accountId && claim.managementOrigin === config.managementOrigin &&
    claim.workerName === config.workerName && claim.workersSubdomain === config.workersSubdomain &&
    claim.expiresAt > now && claim.expiresAt <= now + MAX_ACTION_LIFETIME_MS + CLOCK_SKEW_MS;
}

function relayOperation(decoded: DecodedClaim): 'source-add' | 'bigquery-add' | 'upgrade' | 'rollback' {
  if (decoded.kind === 'source') return 'source-add';
  if (decoded.kind === 'bigquery') return 'bigquery-add';
  return decoded.claim.operation === 'rollback' ? 'rollback' : 'upgrade';
}

/** A fixed, bounded word naming why an operation stopped; never provider text. */
export type CustomerOperationReason = string;
const REASON = /^[a-z][a-z0-9_]{0,120}$/u;

interface OperationOutcome {
  readonly result: CustomerOperationResult;
  readonly reason: CustomerOperationReason | null;
}

const rejectionSchema = v.looseObject({
  error: v.pipe(v.string(), v.regex(REASON)),
  /** The provider step that stopped an apply: kind, step, status, HTTP status and numeric code only. */
  detail: v.optional(v.pipe(v.string(), v.regex(/^[a-z][a-z0-9_]{0,100}$/u))),
});

async function appliedOutcome(response: Response, actionId: string): Promise<OperationOutcome> {
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d{1,7}$/u.test(declared) || Number(declared) > MAX_APPLY_RESPONSE_BYTES)) {
    await response.body?.cancel();
    return { result: 'failed', reason: `apply_http_${response.status}` };
  }
  let text: string;
  try {
    text = await response.text();
  } catch {
    return { result: 'failed', reason: `apply_http_${response.status}_unreadable` };
  }
  if (text.length > MAX_APPLY_RESPONSE_BYTES) return { result: 'failed', reason: `apply_http_${response.status}` };
  let body: v.InferInput<typeof appliedSchema> | null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  if (response.status !== 200) {
    const rejection = v.safeParse(rejectionSchema, body);
    return {
      result: 'failed',
      reason: rejection.success
        ? `apply_${rejection.output.error}${rejection.output.detail === undefined ? '' : `_${rejection.output.detail}`}`.slice(0, 121)
        : `apply_http_${response.status}`,
    };
  }
  const parsed = v.safeParse(appliedSchema, body);
  return parsed.success && parsed.output.actionId === actionId
    ? { result: 'applied', reason: null }
    : { result: 'failed', reason: 'apply_response_invalid' };
}

function failureReason<Thrown>(error: Thrown): CustomerOperationReason {
  if (error instanceof CustomerCloudflareGrantError) {
    return error.detail === null ? `grant_${error.code}` : `grant_${error.code}_${error.detail}`;
  }
  return 'unexpected';
}

function operationPage(): Response {
  const nonce = crypto.randomUUID().replaceAll('-', '');
  const pageHeaders = headers('text/html; charset=utf-8');
  pageHeaders.set('content-security-policy', `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`);
  return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="referrer" content="no-referrer"><title>Authorize in Cloudflare</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:42rem;margin:5rem auto;padding:0 1.25rem;color:#171713}button{font:inherit;padding:.75rem 1rem}a{color:inherit}</style><h1>Authorize this change in Cloudflare</h1><p id="message">Preparing a fresh, temporary Cloudflare approval for your gateway…</p><button id="retry" hidden>Try again</button><p><a href="/sources">Back to the dashboard</a></p><script nonce="${nonce}">(()=>{const message=document.querySelector('#message');const retry=document.querySelector('#retry');const handoff=location.hash.slice(1);history.replaceState(null,'',location.pathname);const run=async()=>{retry.hidden=true;try{if(!/^[A-Za-z0-9_-]{40,8192}$/.test(handoff))throw new Error();const response=await fetch('${CUSTOMER_OPERATION_OAUTH_START_PATH}',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({schemaVersion:1,handoff}),credentials:'same-origin',cache:'no-store'});const value=await response.json();if(!response.ok||typeof value.authorizationUrl!=='string')throw new Error();location.replace(value.authorizationUrl)}catch{message.textContent='This authorization link could not be started. Go back to the dashboard, check the action status, and authorize again.';retry.hidden=false}};retry.addEventListener('click',run);run()})();</script></html>`, {
    status: 200,
    headers: pageHeaders,
  });
}

/** Where the dashboard continues after an operation, with its result and reason words. */
function dashboardLocation(
  managementOrigin: string,
  kind: CustomerOperationAttempt['kind'],
  actionId: string,
  outcome: { readonly result: CustomerOperationResult | null; readonly reason: CustomerOperationReason | null },
): URL {
  const location = kind !== 'runtime'
    ? new URL('/sources', managementOrigin)
    : new URL('/settings', managementOrigin);
  const parameter = kind !== 'runtime' ? 'sourceAction' : 'runtimeAction';
  location.searchParams.set(parameter, actionId);
  if (outcome.result !== null) location.searchParams.set(`${parameter}Result`, outcome.result);
  if (outcome.reason !== null && REASON.test(outcome.reason)) {
    location.searchParams.set(`${parameter}Reason`, outcome.reason);
  }
  return location;
}

function redirectTo(location: URL, cookies: readonly string[]): Response {
  const responseHeaders = headers();
  responseHeaders.set('location', location.toString());
  for (const cookie of cookies) responseHeaders.append('set-cookie', cookie);
  return new Response(null, { status: 303, headers: responseHeaders });
}

function redirectToDashboard(
  managementOrigin: string,
  attempt: CustomerOperationAttempt,
  outcome: OperationOutcome,
  cookies: readonly string[],
): Response {
  return redirectTo(dashboardLocation(managementOrigin, attempt.kind, attempt.actionId, outcome), cookies);
}

const ATTEMPT_QUERY = /^attempt_[A-Za-z0-9_-]{24}$/u;

/** Fixed labels for the update's stages, in order; the page marks them from the stage word it is told. */
const UPDATE_STEP_LABELS = Object.freeze([
  'Verify the running version', 'Fetch and verify the signed release', 'Upload the management assets', 'Upload the new Worker version',
] as const);
/** The step after the upload: Cloudflare keeps serving the previous version at an edge location for a while. */
const UPDATE_SERVING_STEP_LABEL = 'Wait for Cloudflare to serve the new version';
/** How many answers in a row must name the target as the serving release, and how long the page waits for that. */
const UPDATE_SERVING_CONFIRMATIONS = 2;
const UPDATE_SERVING_WAIT_MS = 60_000;
/** How long the sentence about a reload stays readable before the handover it announces. */
const UPDATE_SERVING_NOTICE_MS = 5_000;

/**
 * Where an update's consent lands: a loader and the step list, following the
 * upload the management object runs behind it. Once settled, the page hands
 * the browser to the dashboard, which follows the action to its end. After an
 * applied upload it first waits until the release that serves its own polls
 * is the target on consecutive answers: that is the version the dashboard's
 * navigation will receive, and an earlier handover lands on the previous
 * release's dashboard. The wait is bounded; past it the page hands over anyway
 * and says that a reload may be needed.
 */
function updateProgressPage(attemptId: string): Response {
  const nonce = crypto.randomUUID().replaceAll('-', '');
  const pageHeaders = headers('text/html; charset=utf-8');
  pageHeaders.set('content-security-policy', `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`);
  const literal = <Value>(value: Value): string => JSON.stringify(value).replaceAll('<', '\\u003c');
  return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="referrer" content="no-referrer"><title>Updating your Ankka Gateway</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:42rem;margin:5rem auto;padding:0 1.25rem;color:#171713}a{color:inherit}li{margin:.35rem 0}#loader{display:inline-block;width:.9em;height:.9em;border:2px solid #171713;border-right-color:transparent;border-radius:50%;animation:spin 1s linear infinite;vertical-align:-.1em;margin-right:.5rem}@keyframes spin{to{transform:rotate(360deg)}}</style><h1>Updating your Ankka Gateway</h1><p id="message" role="status" aria-live="polite"><span id="loader"></span>Cloudflare approved the update. Your gateway is verifying and uploading the signed release; this page updates itself.</p><ol id="steps"></ol><p><a href="/settings">Back to Settings</a></p><script nonce="${nonce}">(()=>{
const attempt=${literal(attemptId)},labels=${literal(UPDATE_STEP_LABELS)},serving=${literal(UPDATE_SERVING_STEP_LABEL)},stages=${literal(CUSTOMER_UPDATE_STAGES)},steps=document.querySelector('#steps'),message=document.querySelector('#message'),loader=document.querySelector('#loader'),served=document.createElement('li');
let active=true,timer,bound,controller,confirmed=0;const stop=()=>{active=false;clearTimeout(timer);clearTimeout(bound);if(controller)controller.abort()};addEventListener('pagehide',stop);
const reached=(stage)=>{const index=stages.indexOf(stage);return index<0?0:index>=stages.length-1?labels.length-1:Math.min(index,labels.length-1)};
const giveUp=(url)=>{stop();served.textContent=serving+' — Not confirmed';message.textContent='Cloudflare is taking longer than usual to serve the new version. Handing over to your dashboard; if it still shows the previous version, reload the page.';timer=setTimeout(()=>location.replace(url),${UPDATE_SERVING_NOTICE_MS})};
const show=(state)=>{const settled=state.status==='settled',done=settled&&state.applied===true,awaited=done&&typeof state.targetRelease==='string';confirmed=awaited&&state.servingRelease===state.targetRelease?confirmed+1:0;const arrived=confirmed>=${UPDATE_SERVING_CONFIRMATIONS},current=state.status==='running'?reached(state.stage):-1;
served.textContent=serving+(arrived?' — Done':awaited?' — In progress…':'');steps.replaceChildren(...labels.map((label,index)=>{const item=document.createElement('li');item.textContent=label+(done||index<current?' — Done':index===current?' — In progress…':'');return item}),served);
if(!settled)return false;const url=state.redirectUrl||'';if(!url.startsWith(location.origin+'/settings')){stop();message.textContent='The update has ended. Open Settings to see its result.';return true}
if(awaited&&!arrived){if(!bound){message.replaceChildren(loader,'The upload is complete. Waiting for Cloudflare to serve the new version…');bound=setTimeout(()=>giveUp(url),${UPDATE_SERVING_WAIT_MS})}return false}
stop();message.textContent='Handing over to your dashboard, which follows the update to its end.';location.replace(url);return true};
const poll=async()=>{controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),5000);try{const response=await fetch(${literal(CUSTOMER_OPERATION_UPDATE_PROGRESS_PATH)}+'?attempt='+encodeURIComponent(attempt),{credentials:'same-origin',cache:'no-store',redirect:'manual',signal:controller.signal});if(!response.ok)throw new Error();const state=await response.json();if(!active)return;if(show(state))return}catch{if(!active)return;confirmed=0}finally{clearTimeout(timeout)}if(active)timer=setTimeout(poll,2000)};
poll()})();</script></html>`, { status: 200, headers: pageHeaders });
}

export function createCustomerOperationRouter(
  rawConfig: CustomerOperationRouterConfig,
  dependencies: CustomerOperationRouterDependencies,
): Readonly<{ fetch(request: Request): Promise<Response> }> {
  const parsed = v.safeParse(configSchema, rawConfig);
  if (!parsed.success) throw new Error('operation_config_invalid');
  const config = Object.freeze(parsed.output);
  const management = new URL(config.managementOrigin);
  if (management.protocol !== 'https:' || management.username !== '' || management.password !== '' ||
      management.port !== '' || management.pathname !== '/' || management.search !== '' ||
      management.hash !== '' || management.hostname !== management.hostname.toLowerCase() ||
      !management.hostname.includes('.')) throw new Error('operation_config_invalid');
  const now = dependencies.now ?? Date.now;
  const gatewayCallback = `${config.managementOrigin}${CUSTOMER_INSTALL_OAUTH_CALLBACK_PATH}`;

  const start = async (request: Request): Promise<Response> => {
    if (!sameOriginJsonMutation(request, config.managementOrigin)) {
      return json({ schemaVersion: 1, error: 'forbidden' }, 403);
    }
    const body = await startBody(request);
    const decoded = body === null ? null : decodeClaim(body.handoff);
    const startedAt = now();
    if (decoded === null || !claimMatches(decoded, config, startedAt)) {
      return json({ schemaVersion: 1, error: 'operation_invalid' }, 400);
    }
    const { claim } = decoded;
    const action = decoded.kind === 'source'
      ? await dependencies.readSourceAction(claim.actionId)
      : decoded.kind === 'bigquery'
        ? await dependencies.readBigQueryAction?.(claim.actionId) ?? null
        : await dependencies.readRuntimeAction(claim.actionId);
    if (action === null || action.status !== 'authorization_required' || action.expiresAt !== claim.expiresAt) {
      return json({ schemaVersion: 1, error: 'operation_conflict' }, 409);
    }
    const existing = await dependencies.attempts.read();
    if (existing !== null && existing.expiresAt > startedAt && existing.phase === 'exchanging') {
      return json({ schemaVersion: 1, error: 'operation_pending' }, 409);
    }
    if (existing !== null && existing.expiresAt > startedAt && existing.actionId !== claim.actionId) {
      const previousAction = existing.kind === 'runtime'
        ? await dependencies.readRuntimeAction(existing.actionId)
        : await dependencies.readSourceAction(existing.actionId);
      // A cancelled action invalidates its handoff and may be replaced immediately.
      if (previousAction?.status !== 'failed') {
        return json({ schemaVersion: 1, error: 'operation_pending' }, 409);
      }
    }
    const operation = relayOperation(decoded);
    const verifier = randomBase64Url(32);
    const state = randomBase64Url(32);
    const attemptId = `attempt_${randomBase64Url(18)}`;
    const expiresAt = Math.min(claim.expiresAt, startedAt + CUSTOMER_OPERATION_ATTEMPT_TTL_MS);
    await dependencies.attempts.write({
      schemaVersion: 1,
      attemptId,
      kind: decoded.kind,
      operation,
      actionId: claim.actionId,
      actorEmail: claim.actorEmail,
      actionExpiresAt: claim.expiresAt,
      controlPlaneOrigin: new URL(claim.controlPlaneOrigin).origin,
      target: decoded.kind === 'runtime'
        ? { release: decoded.claim.to.release, artifactSha256: decoded.claim.to.artifactSha256 }
        : null,
      stateHash: await sha256(state),
      phase: 'authorizing',
      expiresAt,
    });
    try {
      const ticket = await dependencies.issueRelayTicket(operation);
      if (!Number.isSafeInteger(ticket.expiresAt) || ticket.expiresAt <= startedAt ||
          ticket.relayTicket.length > 4_096 || !RELAY_TICKET.test(ticket.relayTicket)) {
        throw new Error('invalid');
      }
      const challenge = await pkceChallenge(verifier);
      const relay = await dependencies.beginRelay({
        operation,
        relayTicket: ticket.relayTicket,
        gatewayState: state,
        pkceChallenge: challenge,
        gatewayCallback,
      });
      if (!validCustomerBootstrapRelayAuthorization(relay, config.publicClientId, challenge, operation)) {
        throw new Error('invalid');
      }
      return json({ schemaVersion: 1, authorizationUrl: relay.authorizationUrl }, 200, [
        operationCookie({ attemptId, expiresAt, verifier, actionKey: claim.actionKey, now: startedAt }),
      ]);
    } catch {
      await dependencies.attempts.clear();
      return json({ schemaVersion: 1, error: 'authorization_unavailable' }, 503, [clearCookie()]);
    }
  };

  const applySource = async (
    attempt: CustomerOperationAttempt,
    actionKey: string,
    accessToken: string,
    at: number,
  ): Promise<OperationOutcome> => {
    const body = canonicalJson({
      schemaVersion: 1,
      actionId: attempt.actionId,
      actionKey,
      actorEmail: attempt.actorEmail,
      accountId: config.accountId,
      issuedAt: at,
      expiresAt: attempt.actionExpiresAt,
      cloudflareAccessToken: accessToken,
    });
    const response = await dependencies.applySourceAction({
      body,
      signature: await operationSignature(actionKey, body),
    });
    return appliedOutcome(response, attempt.actionId);
  };

  const callback = async (request: Request, url: URL): Promise<Response> => {
    let uploaded: v.InferOutput<typeof bigQueryCallbackSchema> | null = null;
    if (request.method === 'POST') {
      if (!sameOriginJsonMutation(request, config.managementOrigin) || url.search !== '') return json({ error: 'oauth_callback_rejected' }, 400);
      try { uploaded = v.parse(bigQueryCallbackSchema, JSON.parse(await readBigQueryText(request.body))); }
      catch { return json({ error: 'oauth_callback_rejected' }, 400); }
    }
    const callbackAt = now();
    const cookies = [clearCookie()];
    const cookie = readOperationCookie(request, callbackAt);
    const attempt = await dependencies.attempts.read();
    const oauthState = uploaded?.state ?? url.searchParams.get('state') ?? '';
    if (cookie === null || attempt === null || attempt.attemptId !== cookie.attemptId ||
        attempt.expiresAt !== cookie.expiresAt || attempt.expiresAt <= callbackAt ||
        attempt.phase !== 'authorizing' || !TOKEN.test(oauthState) ||
        !constantTimeEqual(await sha256(oauthState), attempt.stateHash)) {
      return json({ schemaVersion: 1, error: 'oauth_callback_rejected' }, 400, cookies);
    }
    if (uploaded !== null && attempt.kind !== 'bigquery') return json({ error: 'oauth_callback_rejected' }, 400, cookies);
    const code = uploaded?.code ?? url.searchParams.get('code') ?? '';
    const oauthError = url.searchParams.get('error');
    if (oauthError === 'authorization_rejected' && code === '' && url.searchParams.size === 2) {
      await dependencies.attempts.clear();
      return redirectToDashboard(config.managementOrigin, attempt, { result: 'denied', reason: null }, cookies);
    }
    if (oauthError !== null || !AUTHORIZATION_CODE.test(code) || (uploaded === null && url.searchParams.size !== 2)) {
      return json({ schemaVersion: 1, error: 'oauth_callback_rejected' }, 400, cookies);
    }
    if (attempt.kind === 'bigquery' && uploaded === null) return bigQueryCredentialPage(code, oauthState);
    // The attempt is spent before the exchange: a replayed callback cannot exchange twice.
    await dependencies.attempts.write({ ...attempt, phase: 'exchanging' });
    let grant: EphemeralCustomerCloudflareGrant | null = null;
    let outcome: OperationOutcome;
    // True once the management object holds the grant: the callback then neither revokes nor waits.
    let handed = false;
    try {
      const exchanged = await exchangeCustomerCloudflareAuthorizationCode({
        clientId: config.publicClientId,
        code,
        verifier: cookie.verifier,
        operation: attempt.operation,
        transport: dependencies.transport,
      });
      grant = exchanged;
      exchanged.assertUsable();
      outcome = await exchanged.withAccessToken(async (accessToken): Promise<OperationOutcome> => {
        await verifyCustomerCloudflareGrantAccountAccess({
          accessToken,
          expectedAccountId: config.accountId,
          operation: attempt.operation,
          workerName: config.workerName,
          transport: dependencies.transport,
        });
        if (attempt.kind === 'source') return applySource(attempt, cookie.actionKey, accessToken, callbackAt);
        if (attempt.kind === 'bigquery') {
          if (uploaded === null || dependencies.runBigQuerySetup === undefined) return { result: 'failed', reason: 'bigquery_setup_unavailable' };
          return appliedOutcome(await dependencies.runBigQuerySetup({ actionId: attempt.actionId, actionKey: cookie.actionKey,
            actorEmail: attempt.actorEmail, accessToken, actionExpiresAt: attempt.actionExpiresAt, serviceAccountJson: uploaded.serviceAccountJson,
          }), attempt.actionId);
        }
        if (attempt.target === null || attempt.operation === 'source-add') {
          return { result: 'failed', reason: 'attempt_invalid' };
        }
        // The update's upload replaces this Worker version, and the version
        // that runs afterwards may refuse this one's storage writes. The
        // attempt is spent already, so it is cleared here rather than left
        // to block every other operation until it expires.
        await dependencies.attempts.clear();
        // From here the management object owns the grant and the key, in memory,
        // and uploads behind the progress page in its own invocation; the
        // existing handover alarm finishes the journal afterwards.
        const started = await dependencies.startRuntimeUpdate({ attempt, grant: exchanged, actionKey: cookie.actionKey });
        handed = started === 'started';
        return handed ? { result: 'applied', reason: null } : { result: 'failed', reason: 'update_start_failed' };
      });
    } catch (error) {
      outcome = { result: 'failed', reason: failureReason(error) };
    }
    if (grant !== null && !handed) {
      try {
        await grant.revoke({ clientId: config.publicClientId, transport: dependencies.transport });
      } catch {
        if (outcome.result === 'applied') outcome = { result: 'revocation_unconfirmed', reason: null };
      }
      grant.discard();
    }
    try {
      await dependencies.attempts.clear();
    } catch {
      // The attempt record expires on its own.
    }
    if (handed) {
      const progress = new URL(CUSTOMER_OPERATION_UPDATE_PATH, config.managementOrigin);
      progress.searchParams.set('attempt', attempt.attemptId);
      return redirectTo(progress, cookies);
    }
    const redirect = redirectToDashboard(config.managementOrigin, attempt, outcome, cookies);
    return uploaded === null ? redirect : json({ redirectUrl: redirect.headers.get('location') }, 200, cookies);
  };

  /**
   * The update page's view of one attempt: its stage while the upload runs here, the dashboard's address once settled,
   * and the two releases the page compares before it hands over: the one the attempt reaches and the one that served
   * this answer where the browser asked.
   */
  const updateProgress = async (request: Request, attemptId: string): Promise<Response> => {
    const view = await dependencies.updateView(attemptId);
    if (view === null) return notFound();
    const settled = view.status === 'settled';
    const redirectUrl = settled
      ? dashboardLocation(config.managementOrigin, 'runtime', view.actionId, { result: view.result, reason: view.reason }).toString()
      : null;
    // This object running the target proves the upload, also for a version replaced before it could record its end.
    const applied = settled && (view.result === 'applied' || view.result === 'revocation_unconfirmed' ||
      view.targetRelease === config.release);
    const progress: CustomerUpdateProgress = {
      schemaVersion: 1, attemptId, status: view.status, stage: view.stage, result: view.result, reason: view.reason, redirectUrl,
      applied, targetRelease: view.targetRelease, servingRelease: customerServingRelease(request),
    };
    return json(v.parse(customerUpdateProgressSchema, progress));
  };

  return Object.freeze({
    async fetch(request: Request): Promise<Response> {
      let url: URL;
      try {
        url = new URL(request.url);
      } catch {
        return notFound();
      }
      if (url.origin !== config.managementOrigin || url.username !== '' || url.password !== '' ||
          url.port !== '' || url.hash !== '') return notFound();
      const isCallback = ['GET', 'POST'].includes(request.method) && url.pathname === CUSTOMER_INSTALL_OAUTH_CALLBACK_PATH;
      try {
        await dependencies.assertOperational();
      } catch {
        return json({ schemaVersion: 1, error: 'operation_unavailable' }, 503, isCallback ? [clearCookie()] : []);
      }
      if (request.method === 'GET' && url.pathname === CUSTOMER_OPERATION_ROOT_PATH && url.search === '') {
        return operationPage();
      }
      if (request.method === 'GET' && (url.pathname === CUSTOMER_OPERATION_UPDATE_PATH || url.pathname === CUSTOMER_OPERATION_UPDATE_PROGRESS_PATH)) {
        const attemptId = url.searchParams.get('attempt');
        if (url.searchParams.size !== 1 || attemptId === null || !ATTEMPT_QUERY.test(attemptId)) return notFound();
        return url.pathname === CUSTOMER_OPERATION_UPDATE_PATH ? updateProgressPage(attemptId) : updateProgress(request, attemptId);
      }
      if (request.method === 'POST' && url.pathname === CUSTOMER_OPERATION_OAUTH_START_PATH && url.search === '') {
        return start(request);
      }
      if (isCallback) return callback(request, url);
      return notFound();
    },
  });
}
