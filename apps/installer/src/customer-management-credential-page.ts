import { customerPageEnd, customerPageStart } from './customer-page-shell';
import { randomBase64Url } from './crypto';
import {
  customerManagementCredentialName,
  customerManagementCredentialTemplateLink,
} from './customer-management-credential';

function scriptLiteral<Value>(value: Value): string {
  return JSON.stringify(value).replaceAll('<', '\\u003c');
}

/**
 * Where one approved `management-credential` consent lands: a page of the
 * gateway itself with Cloudflare's create-token link and one paste field.
 *
 * The page holds the authorization code and the state in script memory only
 * and drops them from the address at once. The field is not echoed, has no
 * `name` (so no form submission could ever carry it) and is emptied as soon
 * as it is read. The value goes once, in the body of a same-origin POST to
 * this same callback, and is never placed in a URL, a fragment, a cookie,
 * browser storage, or the page again. The POST follows no redirect: an answer
 * that is one, such as a sign-in page for a session that ran out, is read as
 * unconfirmed and the value goes nowhere else. Nothing is persisted by this
 * page.
 */
export function customerManagementCredentialPage(input: {
  readonly code: string;
  readonly state: string;
  readonly managementHostname: string;
  /** When the approval this page was opened with stops being usable, on the gateway's clock. */
  readonly expiresAt: number;
  readonly now: number;
}): Response {
  const nonce = randomBase64Url(18);
  const remainingMs = Math.max(0, input.expiresAt - input.now);
  const page = `${customerPageStart('Add your management token', 'form')}<h1 id="heading" tabindex="-1">Add your management token</h1><p id="intro">Cloudflare approved one change: your gateway may save one secret on its own Worker. Create the token, then paste it here.</p><p id="message" role="status" aria-live="polite"></p><section class="domain-guide" aria-labelledby="token-heading"><h2 id="token-heading">Create it, then paste it</h2><ol class="ankka-steps" role="list"><li><a id="create" class="button-link" href="https://dash.cloudflare.com/" target="_blank" rel="noopener noreferrer">Create the token in Cloudflare ↗</a><p>The link fills in both permissions, <strong>Access: Apps and Policies Edit</strong> and <strong>MCP Portals Edit</strong>, and the name <strong id="token-name"></strong>, so you can find the token again later. Choose your account, create the token, and copy it. This needs a Super Administrator or Administrator of your Cloudflare account.</p></li><li><form id="token-form"><label for="token">Paste the token<input id="token" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="96" required></label><div class="actions"><button id="save" type="submit">Save the token in my gateway</button><button id="cancel" type="button" class="secondary">Cancel</button></div></form></li></ol><p class="domain-note">The token goes from this page to your own gateway and nowhere else; it never passes through anything Ankka hosts. Your gateway saves it as the encrypted secret <code>ANKKA_MANAGEMENT_TOKEN</code> and gives this approval back to Cloudflare. Cloudflare cannot limit the token to your gateway: it can edit every Access policy in your account.</p><p class="domain-note">Replacing a token? Your gateway cannot delete the earlier one. Afterwards, delete it in Cloudflare under Manage Account → Account API Tokens: it has the same name, <strong id="token-name-again"></strong>, and the earlier creation date.</p></section><p id="back" hidden><a href="/settings">Back to Settings</a></p><script nonce="${nonce}">(()=>{
const code=${scriptLiteral(input.code)},state=${scriptLiteral(input.state)},link=${scriptLiteral(customerManagementCredentialTemplateLink(input.managementHostname))},name=${scriptLiteral(customerManagementCredentialName(input.managementHostname))},remaining=${scriptLiteral(remainingMs)};
history.replaceState(null,'',location.pathname);
const $=id=>document.getElementById(id),form=$('token-form'),field=$('token'),save=$('save'),cancel=$('cancel'),message=$('message');
const target=new URL(link);if(target.origin==='https://dash.cloudflare.com')$('create').href=target.href;$('token-name').textContent=name;$('token-name-again').textContent=name;
const expired='Cloudflare’s approval ran out before the token arrived, so nothing was saved. Approvals last only a few minutes. Go back to Settings and start again.';
const unconfirmed='Your gateway could not confirm the result. Go back to Settings: it checks whether the token arrived, and you can start again there.';
let sent=false;
let timer;
const close=(text)=>{sent=true;clearTimeout(timer);field.value='';field.disabled=true;save.disabled=true;cancel.disabled=true;message.textContent=text;$('back').hidden=false};
timer=setTimeout(()=>{if(!sent)close(expired)},remaining);
const post=async(body)=>{const response=await fetch(location.pathname,{method:'POST',credentials:'same-origin',cache:'no-store',redirect:'manual',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return response.json()};
const leave=(result)=>{const next=new URL(String(result.redirectUrl));if(next.origin!==location.origin||next.pathname!=='/settings')throw new Error();clearTimeout(timer);location.replace(next.href)};
form.addEventListener('submit',async(event)=>{event.preventDefault();if(sent)return;let value=field.value.trim();field.value='';
if(!/^(?:cfat_[A-Za-z0-9]{40,64}|[A-Za-z0-9_-]{40})$/.test(value)){value='';message.textContent='That is not a Cloudflare account API token. Account tokens start with cfat_. Copy the token exactly as Cloudflare showed it.';return}
sent=true;save.disabled=true;cancel.disabled=true;message.textContent='Saving the token in your gateway…';
try{const result=await post({code,state,managementToken:value});value='';
if(result.error==='management_token_invalid'){sent=false;save.disabled=false;cancel.disabled=false;message.textContent='Your gateway did not accept that value as a Cloudflare account API token. Copy the token exactly as Cloudflare showed it and paste it again.';return}
if(result.result==='failed'&&result.reason==='approval_expired'){close(expired);return}
leave(result)}catch{value='';close(unconfirmed)}});
cancel.addEventListener('click',async()=>{if(sent)return;sent=true;field.value='';save.disabled=true;cancel.disabled=true;try{leave(await post({code,state,cancel:true}))}catch{location.replace('/settings')}});
})();</script>${customerPageEnd}`;
  return new Response(page, { headers: {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Opener-Policy': 'same-origin',
    'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
  } });
}
