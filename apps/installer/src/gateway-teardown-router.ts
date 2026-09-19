import * as v from 'valibot';
import { canonicalJson } from './canonical-json';
import { exactOperationScopes } from './cloudflare-operation-authority';
import { PUBLIC_ORIGIN, OAUTH_CALLBACK_URL } from './constants';
import { parseCookies } from './cookies';
import { constantTimeEqual, deriveCsrfToken, openGatewayTeardownCookie, pkceChallenge,
  randomBase64Url, sealGatewayTeardownCookie, sha256, type GatewayTeardownCookie } from './crypto';
import type { ExactReleaseBundleIdentity } from './exact-release-bundle';
import { expiredGatewayTeardownHandoffHostname, gatewayTeardownJobId, verifyGatewayTeardownHandoff, type GatewayTeardownTrust } from './gateway-teardown-handoff';
import { authorizeGatewayTeardownJob, consumeGatewayTeardownCallback, createGatewayTeardownJob,
  settleGatewayTeardownAttempt, retainGatewayTeardownRevocationWarning, verifyGatewayTeardownJobAuthority, type GatewayTeardownJob } from './gateway-teardown-job';
import { GatewayTeardownStoreClient } from './gateway-teardown-store-client';
import { readBoundedText } from './http';
import { buildAuthorizationUrl, type CloudflareOauthConfig, type FetchTransport } from './oauth';
import { parseOauthCallbackQuery } from './oauth-callback-query';
import type { VerifiedReleaseBundle } from './release';
import type { TwoStageDeploySessionNamespace } from './two-stage-deploy-session';

export const GATEWAY_TEARDOWN_COOKIE = '__Host-ankka_gateway_teardown';
export const GATEWAY_TEARDOWN_ROUTES = Object.freeze(['/teardown', '/api/teardown', '/api/teardown/import', '/api/teardown/authorize']);
const TTL = 24 * 60 * 60 * 1000;
const headers = {
  'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
};
function json<Value>(value: Value, status = 200, cookie?: string): Response {
  const responseHeaders = new Headers(headers);
  if (cookie !== undefined) responseHeaders.set('set-cookie', cookie);
  return Response.json(value, { status, headers: responseHeaders });
}
function redirect(cookie: string): Response {
  return new Response(null, { status: 303, headers: { ...headers, location: `${PUBLIC_ORIGIN}/teardown`, 'set-cookie': cookie } });
}
function sameOrigin(request: Request): boolean {
  return request.headers.get('origin') === PUBLIC_ORIGIN &&
    [null, 'same-origin'].includes(request.headers.get('sec-fetch-site')) &&
    request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() === 'application/json';
}

/** What the page says about a failure a reload may get past; every other failure has its own refusal word. */
export const GATEWAY_TEARDOWN_RELOAD_GUIDANCE = 'Removal could not continue. Reload this page or use your saved recovery receipt.';
export type GatewayTeardownRefusalCode = 'teardown_receipt_expired' | 'teardown_receipt_rejected' | 'teardown_session_missing';

/**
 * A refusal no reload can change: the same receipt, or the same missing
 * session, meets the same answer. The hostname is known only for a receipt
 * that verifies except for its closed window.
 */
class GatewayTeardownRefusal extends Error {
  constructor(readonly code: GatewayTeardownRefusalCode, readonly hostname: string | null = null) { super(code); }
}

/** One message per refusal word: where a receipt this page can use comes from. */
export function gatewayTeardownRefusalMessage(code: GatewayTeardownRefusalCode, hostname: string | null = null): string {
  if (code === 'teardown_session_missing') {
    return "This browser has no removal open. Choose a recovery receipt you saved from this page, or open your gateway's management page and authorize the removal again.";
  }
  return `${code === 'teardown_receipt_expired' ? 'This removal receipt has expired.' : 'This removal receipt could not be verified.'} Open your gateway's management page${
    hostname === null ? '' : ` at ${hostname}`} and authorize the removal again to get a fresh one, or choose a recovery receipt you saved from this page.`;
}

function page(): Response {
  const nonce = randomBase64Url(18);
  return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="referrer" content="no-referrer"><title>Remove your gateway · Ankka</title>
<style>body{font:16px/1.55 system-ui,sans-serif;max-width:44rem;margin:4rem auto;padding:0 1.25rem;color:#171713;background:#fafaf7}h1{font-size:2rem;line-height:1.2}button,input{font:inherit}button{padding:.7rem 1rem;cursor:pointer}li{margin:.5rem 0}.warning{padding:1rem;background:#fff3d2}section{margin:2rem 0}small{display:block;margin-top:1rem}#receipt{max-width:100%}</style>
<main><p>Ankka MCP Gateway</p><h1>Finish removing your gateway</h1><p id="message" role="status" aria-live="polite">Loading removal progress…</p><small id="failure" hidden></small>
<section id="review" hidden><p id="target"></p><p>Your sources and Portal have already been removed. A fresh Cloudflare approval lets Ankka finish removing the gateway's storage, management page, and Worker from your account.</p><ol id="steps"></ol>
<p id="warning" class="warning" hidden>A previous temporary Cloudflare approval could not be confirmed revoked. Review Ankka MCP Gateway in Cloudflare → My Profile → Access Management → Connected Applications and revoke that approval.</p>
<button id="authorize" hidden>Authorize final removal</button><p><button id="download">Download recovery receipt</button></p><small>Keep this receipt to resume if you lose this browser session. It contains resource references and signed removal evidence, but no credentials.</small></section>
<section><label for="receipt">Resume from a saved recovery receipt</label><p><input id="receipt" type="file" accept="application/json,.json"></p></section></main>
<script nonce="${nonce}">(()=>{const message=document.querySelector('#message'),review=document.querySelector('#review'),authorize=document.querySelector('#authorize');let current,poll;
const reload=${JSON.stringify(GATEWAY_TEARDOWN_RELOAD_GUIDANCE)},rejected=${JSON.stringify(gatewayTeardownRefusalMessage('teardown_receipt_rejected'))};
const api=async(path,body)=>{let response;try{response=await fetch(path,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'content-type':'application/json',...(current?{'x-csrf-token':current.csrfToken}:{})},body:body===undefined?undefined:JSON.stringify(body),credentials:'same-origin',cache:'no-store'})}catch{throw new Error(reload)}if(!response.ok){const refusal=await response.json().catch(()=>null);throw new Error(refusal&&typeof refusal.message==='string'?refusal.message:reload)}return response.json()};
const show=value=>{current=value;review.hidden=false;document.querySelector('#target').textContent='Gateway: '+value.hostname;message.textContent=value.message;const failure=document.querySelector('#failure');failure.hidden=!value.failureReason;failure.textContent=value.failureReason?'Removal reference: '+value.failureReason:'';document.querySelector('#warning').hidden=!value.revocationUnconfirmed;authorize.hidden=!value.canAuthorize;authorize.disabled=false;authorize.textContent=value.started?'Authorize and resume removal':'Authorize final removal';const steps=document.querySelector('#steps');steps.replaceChildren(...value.steps.map(step=>{const item=document.createElement('li');item.textContent=step.label+(step.done?' — Removed':step.current?' — Removing…':'');return item}));clearTimeout(poll);if(value.removing)poll=setTimeout(()=>load().catch(error=>{message.textContent=error.message}),3000)};
const load=async()=>show(await api('/api/teardown'));
addEventListener('pagehide',()=>clearTimeout(poll));
const accept=async(handoff)=>{await api('/api/teardown/import',{handoff});history.replaceState(null,'','/teardown');await load()};
authorize.onclick=async()=>{authorize.disabled=true;try{const value=await api('/api/teardown/authorize',{});location.assign(value.authorizationUrl)}catch(error){message.textContent=error.message;authorize.disabled=false}};
document.querySelector('#download').onclick=()=>{if(!current)return;const url=URL.createObjectURL(new Blob([current.handoff],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='ankka-removal-receipt.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)};
document.querySelector('#receipt').onchange=async(event)=>{try{const file=event.target.files[0];if(!file||file.size>32768)throw new Error('Choose an Ankka removal receipt smaller than 32 KB.');await accept(await file.text())}catch(error){message.textContent=error.message}};
(async()=>{try{const fragment=location.hash.slice(1);if(fragment){let handoff;try{if(!/^[A-Za-z0-9_-]{40,45000}$/.test(fragment))throw new Error();handoff=new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(atob(fragment.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0)))}catch{throw new Error(rejected)}await accept(handoff)}else await load()}catch(error){message.textContent=error.message}})()})();</script></html>`, {
    headers: { ...headers, 'content-type': 'text/html; charset=utf-8',
      'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'` },
  });
}

export function createGatewayTeardownRouter(config: {
  readonly encryptionKey: string; readonly oauth: CloudflareOauthConfig; readonly trust: GatewayTeardownTrust;
  readonly release: ExactReleaseBundleIdentity; readonly namespace: TwoStageDeploySessionNamespace;
}, dependencies: {
  readonly now: () => number; readonly transport: FetchTransport;
  readonly loadBundle: (identity: ExactReleaseBundleIdentity) => Promise<VerifiedReleaseBundle>;
  readonly rateLimit: (request: Request, jobId: string | null) => Promise<void>;
}) {
  const portFor = (jobId: string) => new GatewayTeardownStoreClient(config.namespace.get(config.namespace.idFromName(`gateway-teardown:v1:${jobId}`)));
  const cookieFor = async (value: GatewayTeardownCookie) => `${GATEWAY_TEARDOWN_COOKIE}=${await sealGatewayTeardownCookie(config.encryptionKey, value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400`;
  const readCookie = async (request: Request) => {
    const sealed = parseCookies(request.headers.get('cookie')).get(GATEWAY_TEARDOWN_COOKIE);
    if (sealed === undefined) throw new GatewayTeardownRefusal('teardown_session_missing');
    // A cookie past its day, or sealed under another key, is no session either.
    try { return await openGatewayTeardownCookie(config.encryptionKey, sealed, dependencies.now()); }
    catch { throw new GatewayTeardownRefusal('teardown_session_missing'); }
  };
  /** The offered receipt as of now. A refusal says whether only its window has closed, and then names its gateway. */
  const verifyOffered = async (handoff: string) => {
    try { return await verifyGatewayTeardownHandoff({ handoff, trust: config.trust, now: dependencies.now() }); }
    catch {
      const hostname = await expiredGatewayTeardownHandoffHostname({ handoff, trust: config.trust, now: dependencies.now() });
      throw new GatewayTeardownRefusal(hostname === null ? 'teardown_receipt_rejected' : 'teardown_receipt_expired', hostname);
    }
  };
  const commit = async (port: GatewayTeardownStoreClient, previous: GatewayTeardownJob, job: GatewayTeardownJob) => {
    if (!await port.compareAndSet(previous.revision, job)) throw new Error('teardown_state_conflict');
  };
  const present = async (job: GatewayTeardownJob, jobId: string) => {
    const authority = await verifyGatewayTeardownJobAuthority({ job, trust: config.trust });
    const terminal = job.phase.startsWith('removed');
    const active = job.attempt !== null && job.attempt.expiresAt > dependencies.now();
    // The consent was exchanged and the job object is removing the root by alarm; the page follows it.
    const removing = active && job.phase === 'exchanging';
    const labels = ['Gateway storage', 'Management domain', 'Administrator policy', 'Management Access application', 'Gateway Worker'];
    return {
      hostname: authority.statement.management.hostname, handoff: job.handoff,
      csrfToken: await deriveCsrfToken(config.encryptionKey, `gateway-teardown:${jobId}`),
      canAuthorize: !terminal && !active, started: job.phase !== 'review', removing,
      // `complete` is the settled end of the job; five verified steps with an attempt still running are not it.
      complete: terminal, revocationUnconfirmed: job.revocation === 'unconfirmed', failureReason: job.failureReason,
      message: terminal ? 'Gateway removal is complete.'
        : removing ? 'Removing your gateway. This page updates itself.'
        : active ? 'Cloudflare authorization is in progress. Return here if it is interrupted.'
        : job.phase === 'review' ? 'Review the final removal, then authorize it in Cloudflare.'
        : job.failureReason === 'budget_exhausted' ? 'Removal paused at its per-attempt limit. Authorize again to continue.'
        : 'Removal is incomplete. Authorize again to resume from the verified progress.',
      steps: labels.map((label, index) => ({ label, done: index < job.verifiedSteps.length,
        current: removing && index === job.verifiedSteps.length })),
    };
  };
  const importJob = async (request: Request): Promise<Response> => {
    if (!sameOrigin(request)) return json({ error: 'origin_invalid' }, 403);
    await dependencies.rateLimit(request, null);
    const body = v.parse(v.strictObject({ handoff: v.pipe(v.string(), v.minLength(1), v.maxLength(32768)) }),
      JSON.parse(await readBoundedText(new Response(request.body), 'bad_request', 48 * 1024)));
    const jobId = await gatewayTeardownJobId(body.handoff).catch(() => { throw new GatewayTeardownRefusal('teardown_receipt_rejected'); });
    const port = portFor(jobId);
    let job = await port.read();
    if (job === null) {
      const offered = await verifyOffered(body.handoff);
      // A runner-signed handoff belongs to the operator's own record; the hosted finalizer never adopts it.
      if (offered.statement.customerGrantRevocation !== 'confirmed') throw new GatewayTeardownRefusal('teardown_receipt_rejected');
      const bundle = await dependencies.loadBundle(config.release);
      const retirement = bundle.manifest.components.workerRetirement.files[0];
      if (retirement?.path !== 'payload/worker-retirement/index.js') throw new Error('retirement_missing');
      const proposed = await createGatewayTeardownJob({ ...body, trust: config.trust, now: dependencies.now(),
        release: config.release, retirementModuleSha256: retirement.sha256 });
      if (await port.compareAndSet(null, proposed)) job = proposed;
      else job = await port.read();
    }
    if (job === null) throw new Error('teardown_handoff_conflict');
    const accepted = await verifyGatewayTeardownJobAuthority({ job, trust: config.trust });
    if (job.handoff !== body.handoff) {
      // A new gateway consent can re-sign the same completed dependency graph.
      // It cannot replace the original job's locators, release, or progress.
      const fresh = await verifyOffered(body.handoff);
      if (fresh.certificate.certificateSha256 !== accepted.certificate.certificateSha256 ||
          canonicalJson(fresh.statement.management) !== canonicalJson(accepted.statement.management) ||
          fresh.statement.readyReceiptChecksum !== accepted.statement.readyReceiptChecksum ||
          fresh.statement.dependencyResourcesHash !== accepted.statement.dependencyResourcesHash) throw new GatewayTeardownRefusal('teardown_receipt_rejected');
      if (fresh.statement.priorGrantRevocationUnconfirmed && job.revocation !== 'unconfirmed') {
        const warned = retainGatewayTeardownRevocationWarning(job, dependencies.now());
        await commit(port, job, warned); job = warned;
      }
    }
    return json({ imported: true }, 200, await cookieFor({ purpose: 'gateway_teardown', schemaVersion: 1,
      jobId, expiresAt: dependencies.now() + TTL, attempt: null }));
  };
  const authorize = async (request: Request): Promise<Response> => {
    if (!sameOrigin(request)) return json({ error: 'origin_invalid' }, 403);
    const cookie = await readCookie(request);
    const expected = await deriveCsrfToken(config.encryptionKey, `gateway-teardown:${cookie.jobId}`);
    if (!constantTimeEqual(request.headers.get('x-csrf-token') ?? '', expected)) return json({ error: 'csrf_invalid' }, 403);
    v.parse(v.strictObject({}), JSON.parse(await readBoundedText(new Response(request.body), 'bad_request', 1024)));
    await dependencies.rateLimit(request, cookie.jobId);
    const port = portFor(cookie.jobId);
    const current = await port.read();
    if (current === null) throw new Error('teardown_state_missing');
    await verifyGatewayTeardownJobAuthority({ job: current, trust: config.trust });
    const state = randomBase64Url(32), verifier = randomBase64Url(32), attemptId = `attempt_${randomBase64Url(18)}`;
    const job = authorizeGatewayTeardownJob({ job: current, attemptId, stateHash: await sha256(state),
      verifierHash: await sha256(verifier), now: dependencies.now() });
    await commit(port, current, job);
    if (job.attempt === null) throw new Error('teardown_attempt_missing');
    return json({ authorizationUrl: buildAuthorizationUrl({ clientId: config.oauth.clientId, state,
      challenge: await pkceChallenge(verifier), scopes: exactOperationScopes('gateway-root-finalize') }) }, 200,
    await cookieFor({ ...cookie, expiresAt: dependencies.now() + TTL, attempt: { id: attemptId, state, verifier, expiresAt: job.attempt.expiresAt } }));
  };
  const claimsCallback = async (request: Request): Promise<boolean> => {
    if (request.method !== 'GET' || new URL(request.url).pathname !== new URL(OAUTH_CALLBACK_URL).pathname) return false;
    try {
      const cookie = await readCookie(request);
      return cookie.attempt !== null && constantTimeEqual(new URL(request.url).searchParams.get('state') ?? '', cookie.attempt.state);
    } catch { return false; }
  };
  const callback = async (request: Request): Promise<Response> => {
    const cookie = await readCookie(request), attempt = cookie.attempt;
    if (attempt === null) throw new Error('teardown_callback_invalid');
    // Cloudflare echoes the granted scope beside the code; only this operation's exact scope set is admitted.
    const query = parseOauthCallbackQuery(new URL(request.url), exactOperationScopes('gateway-root-finalize'));
    if (query === null || !constantTimeEqual(query.state, attempt.state)) throw new Error('teardown_callback_invalid');
    await dependencies.rateLimit(request, cookie.jobId);
    const port = portFor(cookie.jobId), current = await port.read();
    if (current === null) throw new Error('teardown_state_missing');
    const job = consumeGatewayTeardownCallback({ job: current, attemptId: attempt.id, stateHash: await sha256(attempt.state),
      verifierHash: await sha256(attempt.verifier), now: dependencies.now() });
    await commit(port, current, job);
    if (query.denied) {
      const denied = settleGatewayTeardownAttempt({ job, attemptId: attempt.id, revocation: 'confirmed', now: dependencies.now() });
      await commit(port, job, denied);
    } else {
      // The job object exchanges the code, keeps the grant only in its memory and runs the
      // removal by alarm; the browser goes to the removal page at once and follows it there.
      await port.finalize({ attemptId: attempt.id, code: query.code, verifier: attempt.verifier });
    }
    return redirect(await cookieFor({ ...cookie, attempt: null }));
  };
  return {
    claimsCallback,
    async fetch(request: Request): Promise<Response> {
      try {
        const url = new URL(request.url);
        if (url.origin !== PUBLIC_ORIGIN || (url.pathname !== new URL(OAUTH_CALLBACK_URL).pathname && url.search)) return json({ error: 'not_found' }, 404);
        if (request.method === 'GET' && url.pathname === '/teardown') return page();
        if (request.method === 'POST' && url.pathname === '/api/teardown/import') return await importJob(request);
        if (request.method === 'POST' && url.pathname === '/api/teardown/authorize') return await authorize(request);
        if (await claimsCallback(request)) return await callback(request);
        if (request.method === 'GET' && url.pathname === '/api/teardown') {
          const cookie = await readCookie(request);
          await dependencies.rateLimit(request, cookie.jobId);
          const job = await portFor(cookie.jobId).read();
          if (job === null) throw new Error('teardown_state_missing');
          return json(await present(job, cookie.jobId));
        }
        return json({ error: 'not_found' }, 404);
      } catch (cause) {
        const refusal = v.safeParse(v.instance(GatewayTeardownRefusal), cause);
        if (!refusal.success) return json({ error: 'teardown_unavailable' }, 409);
        return json({ error: refusal.output.code, message: gatewayTeardownRefusalMessage(refusal.output.code, refusal.output.hostname) }, 409);
      }
    },
  };
}
