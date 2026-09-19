import { customerPageEnd, customerPageStart } from './customer-page-shell';
import { customerLoadingIndicator } from './customer-page-theme';
import * as v from 'valibot';

import { base64UrlDecode, constantTimeEqual, openCustomerTeardownCookie, pkceChallenge, randomBase64Url, sealCustomerTeardownCookie, sha256 } from './crypto';
import { validCustomerBootstrapRelayAuthorization } from './customer-bootstrap-router';
import { beginCustomerBootstrapRelay } from './customer-bootstrap-relay-client';
import { exchangeCustomerCloudflareAuthorizationCode, verifyCustomerCloudflareGrantAccountAccess, type CustomerCloudflareTransport, type EphemeralCustomerCloudflareGrant } from './customer-cloudflare-grant';
import { CUSTOMER_INSTALL_OAUTH_CALLBACK_PATH } from './customer-install-paths';
import { customerTeardownKindsSchema, type CustomerTeardownAttempt, type CustomerTeardownAttemptPort } from './customer-teardown-attempt';
import { signedCustomerTeardownCommand, type CustomerTeardownCommand, type CustomerTeardownLiveProgress } from './customer-teardown-driver';
import {
  CUSTOMER_TEARDOWN_REASONS, customerTeardownProgressSchema, customerTeardownProgressSteps,
  type CustomerTeardownOutcomePort, type CustomerTeardownProgress, type CustomerTeardownReason,
} from './customer-teardown-progress';
import type { ReceiptOwnedCloudflareResourceKind } from './cloudflare-operation-authority';
import { readBoundedText } from './http';

export const CUSTOMER_TEARDOWN_PATH = '/__ankka/operation/teardown';
export const CUSTOMER_TEARDOWN_START_PATH = `${CUSTOMER_TEARDOWN_PATH}/start`;
export const CUSTOMER_TEARDOWN_PROGRESS_PATH = `${CUSTOMER_TEARDOWN_PATH}/progress`;
export const CUSTOMER_TEARDOWN_COOKIE = '__Host-ankka_customer_teardown';
const token = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{43}$/u));
const actionId = v.pipe(v.string(), v.regex(/^action_[A-Za-z0-9_-]{32}$/u));
const attemptIdSchema = v.pipe(v.string(), v.regex(/^attempt_[A-Za-z0-9_-]{24}$/u));
const time = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const claimSchema = v.strictObject({
  schemaVersion: v.literal(3), actionType: v.literal('gateway_teardown'),
  actionId, actionKey: token, actorEmail: v.pipe(v.string(), v.email(), v.maxLength(256)),
  accountId: v.pipe(v.string(), v.regex(/^[a-f0-9]{32}$/u)),
  installationId: v.pipe(v.string(), v.regex(/^acg-[a-f0-9]{24}$/u)),
  controlPlaneOrigin: v.pipe(v.string(), v.url()), managementOrigin: v.pipe(v.string(), v.url()),
  workerName: v.pipe(v.string(), v.minLength(1), v.maxLength(63)),
  workersSubdomain: v.pipe(v.string(), v.minLength(1), v.maxLength(63)),
  gatewayName: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
  portalHostname: v.pipe(v.string(), v.minLength(3), v.maxLength(253)), expiresAt: time,
});
const proofSchema = v.looseObject({
  schemaVersion: v.literal(1), actionId, status: v.literal('authorized'), receiptResourceKinds: customerTeardownKindsSchema,
});
export interface CustomerTeardownConfig {
  readonly accountId: string; readonly installId: string; readonly managementOrigin: string;
  readonly controlPlaneOrigin: string; readonly workerName: string; readonly workersSubdomain: string;
  readonly publicClientId: string; readonly encryptionKey: string;
}
export interface CustomerTeardownDependencies {
  readonly attempts: CustomerTeardownAttemptPort;
  readonly outcomes: CustomerTeardownOutcomePort;
  readonly transport: CustomerCloudflareTransport;
  readonly now?: () => number;
  readonly assertOperational: () => Promise<void>;
  readonly command: CustomerTeardownCommand;
  readonly issueRelayTicket: (kinds: readonly ReceiptOwnedCloudflareResourceKind[]) => Promise<{ readonly relayTicket: string; readonly expiresAt: number }>;
  /** Takes the consented grant and the action key into the management object's memory and arms the first pass. */
  readonly startRemoval: (input: {
    readonly attempt: CustomerTeardownAttempt; readonly grant: EphemeralCustomerCloudflareGrant;
    readonly actionKey: string; readonly requestId: string;
  }) => Promise<'started' | 'failed'>;
  /** What the live attempt last reported, when this object holds it. */
  readonly liveProgress: (attemptId: string) => CustomerTeardownLiveProgress | null;
}
function headers(type = 'application/json; charset=utf-8'): Headers {
  return new Headers({ 'content-type': type, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    'x-content-type-options': 'nosniff', 'cross-origin-opener-policy': 'same-origin' });
}
function json(status: number, body: { readonly error?: string; readonly authorizationUrl?: string }, cookie?: string): Response {
  const responseHeaders = headers();
  if (cookie !== undefined) responseHeaders.set('set-cookie', cookie);
  return new Response(JSON.stringify({ schemaVersion: 1, ...body }), { status, headers: responseHeaders });
}
function clearCookie(): string { return `${CUSTOMER_TEARDOWN_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`; }
function cookieValue(request: Request): string | null {
  const matches = (request.headers.get('cookie') ?? '').split(';').map((part) => part.trim()).filter((part) => part.startsWith(`${CUSTOMER_TEARDOWN_COOKIE}=`));
  return matches.length === 1 ? (matches[0]?.slice(CUSTOMER_TEARDOWN_COOKIE.length + 1) ?? null) : null;
}
export function customerTeardownCookiePresent(request: Request): boolean { return cookieValue(request) !== null; }
function redirect(location: string): Response {
  const responseHeaders = headers(); responseHeaders.set('location', location); responseHeaders.set('set-cookie', clearCookie());
  return new Response(null, { status: 303, headers: responseHeaders });
}
/** One message per fixed reason word; the page shows nothing else about a stopped attempt. */
const removalFailures = {
  authorization: 'Cloudflare authorization could not be verified. Review the requested permissions and authorize removal again from Settings.',
  account_access: 'The temporary grant could not read the required resources in your Cloudflare account. Check account access before reviewing removal again.',
  removal: 'Removal stopped while checking or deleting gateway resources. Some resources may already be removed. Review saved progress before authorizing another attempt.',
  no_progress: 'Removal stopped because a step made no further progress. Inspect the saved removal state before retrying.',
  expired: 'The removal authorization expired. Review removal again from Settings to continue from saved progress.',
  pass_limit: 'Removal reached its per-attempt limit. Review removal again from Settings to continue from saved progress.',
  revocation: 'Cloudflare did not confirm revocation of the temporary grant. Final removal could not continue. Check the grant in Cloudflare before retrying.',
  denied: 'Removal authorization was cancelled. Return to Settings when you are ready to review removal again.',
  interrupted: 'The removal attempt was interrupted before it settled, and the temporary grant could not be confirmed revoked. Check the grant in Cloudflare and review saved progress before authorizing another attempt.',
} satisfies Record<CustomerTeardownReason, string>;
function removalFailure(value: string | null): CustomerTeardownReason | undefined {
  return CUSTOMER_TEARDOWN_REASONS.find((reason) => reason === value);
}
function recoveryLocation(origin: string, reason: CustomerTeardownReason): string {
  return `${origin}${CUSTOMER_TEARDOWN_PATH}?result=recovery_required&reason=${reason}`;
}
/** Where the consent lands: the page that follows the removal the management object runs by alarm. */
function progressLocation(origin: string, attemptId: string): string {
  return `${origin}${CUSTOMER_TEARDOWN_PATH}?attempt=${attemptId}`;
}
function scriptLiteral<Value>(value: Value): string {
  return JSON.stringify(value).replaceAll('<', '\\u003c');
}
function htmlHeaders(nonce: string): Headers {
  const responseHeaders = headers('text/html; charset=utf-8');
  responseHeaders.set('content-security-policy', `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`);
  return responseHeaders;
}
export function page(failed: boolean, reason?: CustomerTeardownReason): Response {
  const nonce = crypto.randomUUID().replaceAll('-', '');
  return new Response(`${customerPageStart('Remove your Ankka Gateway', 'message')}<h1>Remove your Ankka Gateway</h1><p>This removes your gateway's Portal, registered MCP servers, and their access policies and DNS record. Managed BigQuery bridges and their stored Google key copies are removed too. Your team will lose its gateway connections. Your upstream services and their data stay in their own accounts.</p><p>Two temporary Cloudflare approvals are required. The first removes the gateway's connected resources. The second removes its management page, stored configuration, and Worker. Each phase checks the saved installation receipts before deleting resources.</p><p id="message" role="status" aria-live="polite">${failed ? (reason === undefined ? 'Removal stopped. Return to Settings to review saved progress before trying again.' : removalFailures[reason]) : 'You can cancel before granting access. Once removal begins, deleted resources cannot be restored by cancelling.'}</p><button class="danger" id="authorize"${failed ? ' hidden' : ''}>Authorize removal in Cloudflare</button><p><a href="/settings">Back to Settings</a></p><script nonce="${nonce}">(()=>{const handoff=location.hash.slice(1);history.replaceState(null,'',location.pathname);const button=document.querySelector('#authorize');const message=document.querySelector('#message');button.addEventListener('click',async()=>{button.disabled=true;try{if(!/^[A-Za-z0-9_-]{40,8192}$/.test(handoff))throw new Error();const response=await fetch('${CUSTOMER_TEARDOWN_START_PATH}',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({schemaVersion:1,handoff}),credentials:'same-origin',cache:'no-store'});const result=await response.json();if(!response.ok||typeof result.authorizationUrl!=='string')throw new Error();location.replace(result.authorizationUrl)}catch{message.textContent='Removal could not start. Return to Settings and review removal again.';button.hidden=true}})})();</script>${customerPageEnd}`, { headers: htmlHeaders(nonce) });
}

/**
 * Where the consent lands: a loader and the step list, following the removal
 * the management object runs behind it. Once settled, the page records the
 * result word in its own address (never the receipt) and hops to the
 * installer with the signed receipt, or shows the reason word's message.
 */
function progressPage(attemptId: string): Response {
  const nonce = crypto.randomUUID().replaceAll('-', '');
  return new Response(`${customerPageStart('Removing your Ankka Gateway', 'message')}<h1>Removing your Ankka Gateway</h1><p id="message" role="status" aria-live="polite"><span id="loader" class="page-loader">${customerLoadingIndicator}</span>Cloudflare approved the removal. Your gateway is removing its connected resources; this page updates itself.</p><ol id="steps"></ol><p id="detail"></p><p><a href="/settings">Back to Settings</a></p><script nonce="${nonce}">(()=>{
const attempt=${scriptLiteral(attemptId)},messages=${scriptLiteral(removalFailures)},message=document.querySelector('#message'),loader=document.querySelector('#loader'),steps=document.querySelector('#steps'),detail=document.querySelector('#detail');
let active=true,timer,controller;const stop=()=>{active=false;clearTimeout(timer);if(controller)controller.abort()};addEventListener('pagehide',stop);
const words=(result,reason)=>{const url=new URL(location.href);url.search='';url.searchParams.set('attempt',attempt);url.searchParams.set('result',result);if(reason)url.searchParams.set('reason',reason);history.replaceState(null,'',url.pathname+url.search)};
const show=(state)=>{steps.replaceChildren(...state.steps.map(step=>{const item=document.createElement('li');item.textContent=step.label+(step.state==='done'?' — Removed':step.state==='active'?' — Removing…':'');return item}));
if(state.status!=='settled')return false;stop();loader.remove();
if(state.result==='removed'&&/^https:\\/\\//.test(state.handoffUrl||'')){words('removed');message.textContent='Connected resources removed. Continue to the final removal of the gateway.';const link=document.createElement('a');link.href=state.handoffUrl;link.textContent='Continue to final removal';detail.replaceChildren(link);location.replace(state.handoffUrl);return true}
const reason=Object.hasOwn(messages,state.reason||'')?state.reason:null;words('recovery_required',reason);message.textContent=reason?messages[reason]:'Removal stopped. Return to Settings to review saved progress before trying again.';return true};
const poll=async()=>{controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),5000);try{const response=await fetch(${scriptLiteral(CUSTOMER_TEARDOWN_PROGRESS_PATH)}+'?attempt='+encodeURIComponent(attempt),{credentials:'same-origin',cache:'no-store',redirect:'manual',signal:controller.signal});if(!response.ok)throw new Error();const state=await response.json();if(!active)return;if(show(state))return}catch{if(!active)return}finally{clearTimeout(timeout)}if(active)timer=setTimeout(poll,2000)};
poll()})();</script>${customerPageEnd}`, { headers: htmlHeaders(nonce) });
}

/** The gateway removes dependencies; only signed, verified completion can authorize the hosted root phase. */
export function createCustomerTeardownRouter(config: CustomerTeardownConfig, dependencies: CustomerTeardownDependencies) {
  const now = dependencies.now ?? Date.now;
  for (const value of [config.managementOrigin, config.controlPlaneOrigin]) {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.origin !== value || url.username !== '' || url.password !== '') throw new Error('teardown_config_invalid');
  }
  const gatewayCallback = `${config.managementOrigin}${CUSTOMER_INSTALL_OAUTH_CALLBACK_PATH}`;
  async function command(kind: 'prove' | 'settle', identity: { readonly actionId: string; readonly actorEmail: string; readonly actionExpiresAt: number }, key: string) {
    const signed = await signedCustomerTeardownCommand({ kind, identity, actionKey: key, accountId: config.accountId, installId: config.installId, now: now() });
    return dependencies.command(kind, signed.body, signed.signature);
  }
  async function settle(attempt: CustomerTeardownAttempt, key: string, unconfirmed: boolean): Promise<void> {
    if (!await dependencies.attempts.compareAndSet(attempt.revision, { ...attempt, revision: attempt.revision + 1,
      phase: 'settled', priorGrantRevocationUnconfirmed: attempt.priorGrantRevocationUnconfirmed || unconfirmed })) throw new Error('teardown_attempt_conflict');
    const response = await command('settle', attempt, key); await response.body?.cancel();
    if (response.status !== 200) throw new Error('teardown_settlement_failed');
  }
  async function start(request: Request): Promise<Response> {
    if (request.headers.get('origin') !== config.managementOrigin ||
        ![null, 'same-origin'].includes(request.headers.get('sec-fetch-site')) ||
        request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') return json(403, { error: 'origin_required' });
    const raw = await readBoundedText(new Response(request.body, { headers: request.headers }), 'bad_request', 12 * 1024);
    const body = v.parse(v.strictObject({ schemaVersion: v.literal(1), handoff: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{40,8192}$/u)) }), JSON.parse(raw));
    const claim = v.parse(claimSchema, JSON.parse(new TextDecoder().decode(base64UrlDecode(body.handoff))));
    const at = now();
    if (claim.accountId !== config.accountId || claim.installationId !== config.installId ||
        claim.managementOrigin !== config.managementOrigin || claim.controlPlaneOrigin !== config.controlPlaneOrigin ||
        claim.workerName !== config.workerName || claim.workersSubdomain !== config.workersSubdomain ||
        claim.expiresAt <= at || claim.expiresAt > at + 10 * 60 * 1000) return json(400, { error: 'teardown_invalid' });
    const current = await dependencies.attempts.read();
    if (current !== null && current.phase !== 'settled' && current.expiresAt > at) return json(409, { error: 'teardown_attempt_pending' });
    const identity = { actionId: claim.actionId, actorEmail: claim.actorEmail, actionExpiresAt: claim.expiresAt };
    const proofResponse = await command('prove', identity, claim.actionKey);
    if (proofResponse.status !== 200) { await proofResponse.body?.cancel(); return json(409, { error: 'teardown_proof_rejected' }); }
    const proof = v.parse(proofSchema, JSON.parse(await readBoundedText(proofResponse, 'bad_request', 512 * 1024)));
    if (proof.actionId !== claim.actionId || new Set(proof.receiptResourceKinds).size !== proof.receiptResourceKinds.length) throw new Error('teardown_proof_invalid');
    const verifier = randomBase64Url(32); const state = randomBase64Url(32);
    const attempt: CustomerTeardownAttempt = { schemaVersion: 1, revision: (current?.revision ?? 0) + 1,
      ...identity, attemptId: `attempt_${randomBase64Url(18)}`, expiresAt: claim.expiresAt,
      stateHash: await sha256(state), verifierHash: await sha256(verifier), phase: 'authorizing',
      receiptResourceKinds: proof.receiptResourceKinds,
      priorGrantRevocationUnconfirmed: current?.priorGrantRevocationUnconfirmed === true || current?.phase === 'exchanging' };
    if (!await dependencies.attempts.compareAndSet(current?.revision ?? null, attempt)) return json(409, { error: 'teardown_attempt_pending' });
    try {
      const ticket = await dependencies.issueRelayTicket(attempt.receiptResourceKinds);
      if (!Number.isSafeInteger(ticket.expiresAt) || ticket.expiresAt <= now()) throw new Error('teardown_ticket_invalid');
      const challenge = await pkceChallenge(verifier);
      const relay = await beginCustomerBootstrapRelay({ publicClientId: config.publicClientId,
        relayTicket: ticket.relayTicket, gatewayState: state, pkceChallenge: challenge, gatewayCallback,
        operation: 'uninstall', receiptResourceKinds: attempt.receiptResourceKinds, transport: dependencies.transport });
      if (!validCustomerBootstrapRelayAuthorization(relay, config.publicClientId, challenge, 'uninstall', attempt.receiptResourceKinds)) throw new Error('teardown_relay_invalid');
      const sealed = await sealCustomerTeardownCookie(config.encryptionKey, { schemaVersion: 1, purpose: 'customer_teardown',
        attemptId: attempt.attemptId, expiresAt: attempt.expiresAt, verifier, actionKey: claim.actionKey });
      return json(200, { authorizationUrl: relay.authorizationUrl }, `${CUSTOMER_TEARDOWN_COOKIE}=${sealed}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${Math.max(1, Math.floor((attempt.expiresAt - now()) / 1000))}`);
    } catch {
      await settle(attempt, claim.actionKey, false);
      return json(503, { error: 'teardown_authorization_unavailable' }, clearCookie());
    }
  }
  async function callback(request: Request, url: URL): Promise<Response> {
    const sealed = cookieValue(request);
    if (sealed === null || sealed.length > 4096) return json(400, { error: 'teardown_callback_rejected' }, clearCookie());
    const cookie = await openCustomerTeardownCookie(config.encryptionKey, sealed, now());
    const attempt = await dependencies.attempts.read();
    const state = url.searchParams.get('state') ?? ''; const code = url.searchParams.get('code') ?? '';
    const denied = url.searchParams.get('error') === 'authorization_rejected' && code === '';
    if (attempt === null || attempt.phase !== 'authorizing' || attempt.attemptId !== cookie.attemptId ||
        attempt.expiresAt !== cookie.expiresAt || attempt.expiresAt <= now() || !v.is(token, state) ||
        !constantTimeEqual(await sha256(state), attempt.stateHash) ||
        !constantTimeEqual(await sha256(cookie.verifier), attempt.verifierHash) || url.searchParams.size !== 2 ||
        (!denied && (url.searchParams.has('error') || !/^[A-Za-z0-9._~-]{8,4096}$/u.test(code)))) return json(400, { error: 'teardown_callback_rejected' }, clearCookie());
    if (denied) { await settle(attempt, cookie.actionKey, false); return redirect(recoveryLocation(config.managementOrigin, 'denied')); }
    const exchanging: CustomerTeardownAttempt = { ...attempt, revision: attempt.revision + 1, phase: 'exchanging' };
    if (!await dependencies.attempts.compareAndSet(attempt.revision, exchanging)) return json(409, { error: 'teardown_callback_rejected' }, clearCookie());
    let grant: EphemeralCustomerCloudflareGrant | null = null;
    let failure: CustomerTeardownReason = 'authorization';
    try {
      grant = await exchangeCustomerCloudflareAuthorizationCode({ clientId: config.publicClientId, code, verifier: cookie.verifier,
        operation: 'uninstall', receiptResourceKinds: attempt.receiptResourceKinds, transport: dependencies.transport });
      grant.assertUsable();
      failure = 'account_access';
      await grant.withAccessToken((accessToken) => verifyCustomerCloudflareGrantAccountAccess({ accessToken, expectedAccountId: config.accountId,
        operation: 'uninstall', workerName: config.workerName, transport: dependencies.transport }));
      failure = 'removal';
      // From here the management object owns the grant and the key, in memory, and removes by alarm;
      // the browser follows the passes on the removal page. Nothing below waits for a provider.
      const started = await dependencies.startRemoval({ attempt: exchanging, grant, actionKey: cookie.actionKey, requestId: randomBase64Url(16) });
      return redirect(started === 'started' ? progressLocation(config.managementOrigin, exchanging.attemptId) : recoveryLocation(config.managementOrigin, 'removal'));
    } catch { /* A grant that cannot be used is revoked and the attempt settled before the callback answers. */ }
    let revoked = false;
    if (grant !== null) {
      try { await grant.revoke({ clientId: config.publicClientId, transport: dependencies.transport }); revoked = true; }
      catch { /* Keep the warning across every subsequent attempt. */ }
      finally { grant.discard(); }
    }
    await settle(exchanging, cookie.actionKey, !revoked);
    await dependencies.outcomes.write({ schemaVersion: 1, attemptId: exchanging.attemptId, result: 'recovery_required', reason: failure, handoffUrl: null });
    return redirect(recoveryLocation(config.managementOrigin, failure));
  }
  /** The removal page's view of one attempt: fixed labels and words, the receipt link once the dependencies are gone. */
  async function progress(attemptId: string): Promise<Response> {
    const attempt = await dependencies.attempts.read();
    if (attempt === null || attempt.attemptId !== attemptId) return json(404, { error: 'not_found' });
    const outcome = await dependencies.outcomes.read();
    const expired = attempt.phase === 'exchanging' && now() >= attempt.expiresAt;
    const status = attempt.phase === 'authorizing' ? 'authorizing' : attempt.phase === 'exchanging' && !expired ? 'removing' : 'settled';
    const settled = status !== 'settled' ? null
      : outcome?.attemptId === attemptId ? outcome
      : { result: 'recovery_required' as const, reason: expired ? 'expired' as const : 'interrupted' as const, handoffUrl: null };
    const live = status === 'removing' ? dependencies.liveProgress(attemptId) : null;
    const view: CustomerTeardownProgress = {
      schemaVersion: 1, attemptId, status,
      result: settled?.result ?? null, reason: settled?.reason ?? null, handoffUrl: settled?.handoffUrl ?? null,
      steps: customerTeardownProgressSteps({ kinds: attempt.receiptResourceKinds, phase: live?.phase ?? null,
        removedKinds: live?.removedKinds ?? [], result: settled?.result ?? null, removing: status === 'removing' }),
    };
    return new Response(JSON.stringify(v.parse(customerTeardownProgressSchema, view)), { status: 200, headers: headers() });
  }
  /** The page's own address carries at most the attempt and the fixed result and reason words. */
  function pageQuery(url: URL): { attemptId: string | null; failed: boolean; reason: CustomerTeardownReason | undefined } | null {
    const keys = [...url.searchParams.keys()];
    if (!keys.every((key) => ['attempt', 'result', 'reason'].includes(key)) || keys.length !== new Set(keys).size) return null;
    const attempt = url.searchParams.get('attempt');
    const result = url.searchParams.get('result');
    if (attempt !== null && !v.is(attemptIdSchema, attempt)) return null;
    if (result !== null && result !== 'recovery_required' && !(attempt !== null && result === 'removed')) return null;
    if (result === null && url.searchParams.has('reason')) return null;
    return { attemptId: attempt, failed: result === 'recovery_required', reason: removalFailure(url.searchParams.get('reason')) };
  }
  return { async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.origin !== config.managementOrigin || url.hash !== '' || url.username !== '' || url.password !== '') return json(404, { error: 'not_found' });
    try {
      await dependencies.assertOperational();
      if (request.method === 'GET' && url.pathname === CUSTOMER_TEARDOWN_PATH) {
        const query = pageQuery(url);
        if (query === null) return json(404, { error: 'not_found' });
        if (query.attemptId !== null) return progressPage(query.attemptId);
        return page(query.failed, query.reason);
      }
      if (request.method === 'GET' && url.pathname === CUSTOMER_TEARDOWN_PROGRESS_PATH) {
        const attemptId = url.searchParams.get('attempt');
        if (url.searchParams.size !== 1 || attemptId === null || !v.is(attemptIdSchema, attemptId)) return json(404, { error: 'not_found' });
        return await progress(attemptId);
      }
      if (request.method === 'POST' && url.pathname === CUSTOMER_TEARDOWN_START_PATH && url.search === '') return await start(request);
      if (request.method === 'GET' && url.pathname === CUSTOMER_INSTALL_OAUTH_CALLBACK_PATH) return await callback(request, url);
      return json(404, { error: 'not_found' });
    } catch { return json(409, { error: 'teardown_recovery_required' }); }
  } };
}
