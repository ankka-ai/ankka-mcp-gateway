import { customerPageEnd, customerPageStart } from './customer-page-shell';
import { customerLoadingIndicator } from './customer-page-theme';
import type { CustomerBootstrapCallbackOutcome } from './customer-bootstrap-router';
import { PUBLIC_ORIGIN } from './constants';
import { CUSTOMER_INSTALL_CLEANUP_PATH, CUSTOMER_INSTALL_ROOT_PATH, CUSTOMER_INSTALL_STATUS_PATH } from './customer-install-paths';

function secureHeaders(contentType: string): Headers {
  return new Headers({
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    'content-type': contentType,
    'cross-origin-opener-policy': 'same-origin',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  });
}

function scriptLiteral<Value>(value: Value): string {
  return JSON.stringify(value).replaceAll('<', '\\u003c');
}

/**
 * Where the second Cloudflare approval lands. The passes run behind alarms,
 * so the page follows the status route until the attempt settles; the
 * temporary workers.dev address can close before the final runtime upload.
 * Losing that address is not proof of readiness. The fixed management page
 * continues checking same-origin status behind Access before opening the dashboard.
 *
 * While the install runs, the shell's status also carries one fixed word
 * about the management token step, and the page says in a sentence what it
 * means: the token is written in the last step, was skipped, or was dropped
 * and can be added later in Settings. A status without the word (the final
 * runtime's recovery status) shows nothing.
 */
export function customerInstallProgressPage(
  managementHostname: string,
  outcome: CustomerBootstrapCallbackOutcome,
  cookies: readonly string[],
): Response {
  const nonce = crypto.randomUUID().replaceAll('-', '');
  const headers = secureHeaders('text/html; charset=utf-8');
  headers.set('content-security-policy', `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`);
  for (const cookie of cookies) headers.append('set-cookie', cookie);
  if (outcome.status === 'INCOMPLETE' && outcome.failureCode === 'authorization_rejected') {
    headers.set('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    return new Response(`${customerPageStart('Cloudflare approval did not complete', 'message')}<h1>Cloudflare approval did not complete</h1><p>Cloudflare did not authorize this setup attempt. Return to your gateway setup to review the settings and try the approval again.</p><p><a href="${CUSTOMER_INSTALL_ROOT_PATH}">Return to gateway setup</a></p>${customerPageEnd}`, {
      status: 200,
      headers,
    });
  }
  const initial = scriptLiteral({
    status: outcome.status,
    failure: outcome.failureCode === null ? null : { code: outcome.failureCode, reason: outcome.failureReason },
  });
  return new Response(`${customerPageStart('Install Ankka Gateway', 'message')}<h1 id="title">Finishing your Ankka Gateway</h1><div id="progress">${customerLoadingIndicator}</div><p id="message" role="status" aria-live="polite">Cloudflare approved the install. Setting up the Gateway takes a few minutes; this page updates itself.</p><p id="detail"></p><p id="credential"></p><script nonce="${nonce}">
(()=>{
  const management=${scriptLiteral(`https://${managementHostname}/?setup=finishing`)};
  const title=document.querySelector('#title');
  const message=document.querySelector('#message');
  const detail=document.querySelector('#detail');
  const credential=document.querySelector('#credential');
  // One fixed word from the status route about the management token step; never a value.
  const notes={
    held:'Your management token is saved as an encrypted secret on your gateway in the last step of setup.',
    installed:'Your management token is saved as an encrypted secret on your gateway.',
    skipped:'This gateway was set up without a management token. Adding connectors and managing team access stay disabled until you add it in Settings.',
    dropped:'Your gateway no longer held the management token you pasted. Setup cannot finish until you provide a token again.',
  };
  const installer=${scriptLiteral(PUBLIC_ORIGIN)};
  const progress=document.querySelector('#progress');
  let misses=0;
  let active=true;
  let removing=false;
  let removalRequested=false;
  let timer;
  let controller;
  const stop=()=>{active=false;progress.hidden=true;clearTimeout(timer);if(controller)controller.abort()};
  const reasonText=(failure)=>failure?'Reason: '+failure.code+(failure.reason?' / '+failure.reason:''):'';
  const installerLink=(label)=>{const link=document.createElement('a');link.href=installer;link.textContent=label;detail.append(link)};
  const unconfirmed=()=>{
    stop();
    title.textContent='Removal was not confirmed';
    message.textContent='This page lost contact before removal could be confirmed. Return to the installer and start again only after it shows this installation is gone.';
    detail.textContent='';
    installerLink('Return to the installer');
  };
  addEventListener('pagehide',stop);
  const openManagement=()=>{
    if(!active)return;
    stop();
    title.textContent='Opening your management page';
    message.textContent='Your management page will check that setup finished before opening your dashboard. Cloudflare may ask you to sign in.';
    const link=document.createElement('a');
    link.href=management;
    link.textContent='Open your management page';
    detail.textContent='';
    detail.append(link);
    location.replace(management);
  };
  const show=(state)=>{
    credential.textContent=state.status==='CONVERGING'&&Object.hasOwn(notes,String(state.managementCredential))?notes[state.managementCredential]:'';
    if(state.status==='READY'){openManagement();return true}
    const failure=state.failure;
    if(state.cleanup==='removing'){
      removing=true;
      title.textContent='Removing the unfinished gateway';
      message.textContent='Setup stopped before it was ready. This page stays open while that unfinished gateway is removed.';
      detail.textContent=reasonText(failure);
      if(!removalRequested){
        removalRequested=true;
        fetch(${scriptLiteral(CUSTOMER_INSTALL_CLEANUP_PATH)},{method:'POST',headers:{'content-type':'application/json'},body:'{}',credentials:'same-origin',cache:'no-store'}).then(async(response)=>{if(!response.ok)throw new Error();const next=await response.json();if(active)show(next)}).catch(()=>{if(active)unconfirmed()});
      }
      return false;
    }
    if(state.cleanup==='removed'||state.safeToStartAgain===true){
      stop();
      title.textContent='The unfinished gateway was removed';
      message.textContent='It is safe to return to the installer and start again.';
      detail.textContent=reasonText(failure);
      installerLink('Return to the installer');
      return true;
    }
    if(state.status==='INCOMPLETE'||state.cleanup==='recovery_required'){
      stop();
      title.textContent='Setup did not complete';
      message.textContent='The Gateway stopped before it was ready. Return to the installer to remove this install before trying again. Do not start another one until that removal finishes.';
      detail.textContent=reasonText(failure);
      installerLink('Remove this install');
      return true;
    }
    if(state.status!=='CONVERGING')throw new Error();
    return false;
  };
  const poll=async()=>{
    controller=new AbortController();
    const timeout=setTimeout(()=>controller.abort(),5000);
    try{
      const response=await fetch(${scriptLiteral(CUSTOMER_INSTALL_STATUS_PATH)},{credentials:'same-origin',cache:'no-store',redirect:'manual',signal:controller.signal});
      if(!response.ok)throw new Error();
      const state=await response.json();
      if(!active)return;
      if(show(state))return;
      misses=0;
    }catch{
      if(!active)return;
      misses+=1;
      if(removing){
        if(misses>=5)unconfirmed();
      }else{
      if(misses===3){message.textContent='Still finishing. The temporary setup address is being replaced by your management address; this can take a few minutes.'}
      if(misses>=20){openManagement();return}
      }
    }finally{clearTimeout(timeout)}
    if(active)timer=setTimeout(poll,3000);
  };
  if(!show(${initial}))timer=setTimeout(poll,3000);
})();
</script>${customerPageEnd}`, {
    status: 200,
    headers,
  });
}
