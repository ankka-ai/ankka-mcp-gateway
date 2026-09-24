import { CUSTOMER_INSTALL_OAUTH_START_PATH } from './customer-install-paths';
import { customerPageEnd, customerPageStart } from './customer-page-shell';
import { customerLoadingIndicator } from './customer-page-theme';

export function recoveryPage(): Response {
  const nonce = crypto.randomUUID().replaceAll('-', '');
  const headers = new Headers({
    'cache-control': 'no-store',
    'content-type': 'text/html; charset=utf-8',
    'cross-origin-opener-policy': 'same-origin',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  });
  headers.set('content-security-policy', `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`);
  return new Response(`${customerPageStart('Finish Ankka Gateway setup', 'message')}<h1>Finish your Ankka Gateway</h1><div id="progress">${customerLoadingIndicator}</div><p id="message" role="status" aria-live="polite">Preparing a fresh, temporary Cloudflare approval…</p><button id="retry" hidden>Try again</button><script nonce="${nonce}">(()=>{const message=document.querySelector('#message');const retry=document.querySelector('#retry');const progress=document.querySelector('#progress');const run=async()=>{retry.hidden=true;progress.hidden=false;try{const response=await fetch('${CUSTOMER_INSTALL_OAUTH_START_PATH}',{method:'POST',headers:{'content-type':'application/json'},body:'{}',credentials:'same-origin',cache:'no-store'});const value=await response.json();if(!response.ok||typeof value.authorizationUrl!=='string')throw new Error();location.assign(value.authorizationUrl)}catch{progress.hidden=true;message.textContent='Setup is still finishing or needs a fresh attempt. Wait a moment, then try again.';retry.hidden=false}};retry.addEventListener('click',run);run()})();</script>${customerPageEnd}`, {
    status: 200,
    headers,
  });
}
