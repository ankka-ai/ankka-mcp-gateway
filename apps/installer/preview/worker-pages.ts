import type { Connect } from 'vite'
import { customerSetupPage } from '../src/customer-setup-page'
import { customerInstallProgressPage } from '../src/customer-install-progress-page'
import { bigQueryCredentialPage } from '../src/customer-bigquery-credential-page'
import { customerManagementCredentialPage } from '../src/customer-management-credential-page'
import { operationPage } from '../src/customer-operation-router'
import { recoveryPage } from '../src/customer-gateway-entrypoint'
import { page as customerTeardownPage } from '../src/customer-teardown-router'
import { page as finalTeardownPage } from '../src/gateway-teardown-router'

// This module is mounted only by Vite's local UI server, never by a Worker.
// Render the real HTML, replacing network calls in the browser with fixed fixtures.
function fixtureScript(scenario: string): string {
  return String.raw`(()=>{
const scenario=${JSON.stringify(scenario)};
const basics={gatewayName:'Example MCP Gateway',zoneName:'example.com',adminEmail:'owner@example.com',additionalAdminEmails:['admin@example.com'],managementHostname:'manage.example.com',portalHostname:'mcp.example.com'};
const reviewed=selection=>({availableZones:[{name:'example.com'}],selection,plan:{managementAdminEmails:[selection.basics.adminEmail,...selection.basics.additionalAdminEmails],managementResources:[{name:'Management Worker'},{name:'Administrator access policy'}],gatewayResources:[{name:'MCP gateway'},{name:'Gateway DNS record'}]}});
if(scenario.startsWith('operation-'))history.replaceState(null,'',location.pathname+'#'+'a'.repeat(40));
window.fetch=async(input,options={})=>{
  const path=new URL(String(input),location.href).pathname;
  if(scenario.endsWith('-loading'))return new Promise(()=>{});
  if(path==='/__ankka/install/setup'){
    if(scenario==='expired')return Response.json({error:'bootstrap_unavailable'},{status:410});
    if(scenario==='setup-review')return Response.json(reviewed({schemaVersion:1,basics,firstSource:null}));
    return Response.json({availableZones:scenario==='no-domains'?[]:[{name:'example.com'}],selection:null,plan:null});
  }
  if(path==='/__ankka/install/configuration')return Response.json(reviewed(JSON.parse(options.body)));
  if(path==='/__ankka/install/status')return Response.json({schemaVersion:1,status:'CONVERGING'});
  if(path==='/api/teardown')return Response.json({hostname:'manage.example.com',message:'Review the final removal, then authorize it in Cloudflare.',failureReason:null,revocationUnconfirmed:true,canAuthorize:true,started:false,handoff:'synthetic-preview-receipt',steps:['Gateway storage','Management domain','Administrator policy','Management Access application','Gateway Worker'].map(label=>({label,done:false}))});
  return Response.json({error:'preview_only'},{status:409});
};
})();`
}

function render(scenario: string): Response | null {
  if (['setup', 'setup-review', 'setup-loading', 'no-domains', 'expired'].includes(scenario)) return customerSetupPage()
  if (scenario === 'progress') return customerInstallProgressPage('manage.example.com', { status: 'CONVERGING', failureCode: null, failureReason: null }, [])
  if (scenario === 'incomplete' || scenario === 'denied') return customerInstallProgressPage('manage.example.com', { status: 'INCOMPLETE', failureCode: scenario === 'denied' ? 'authorization_rejected' : 'provider_recovery_required', failureReason: null }, [])
  if (scenario === 'operation-loading' || scenario === 'operation-error') return operationPage()
  if (scenario === 'recovery-loading' || scenario === 'recovery-error') return recoveryPage()
  if (scenario === 'bigquery-key') return bigQueryCredentialPage('synthetic-preview-code', 'synthetic-preview-state')
  if (scenario === 'management-token') return customerManagementCredentialPage({ code: 'synthetic-preview-code', state: 'synthetic-preview-state', managementHostname: 'manage.example.com', expiresAt: 600_000, now: 0 })
  if (scenario === 'remove-review' || scenario === 'remove-error') return customerTeardownPage(scenario === 'remove-error')
  if (scenario === 'remove-final') return finalTeardownPage()
  return null
}

export function workerPagesPreview(): Connect.NextHandleFunction {
  return (request, response, next) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1:5731')
    if (!url.pathname.startsWith('/__ui/worker/')) { next(); return }
    if (request.method !== 'GET') { response.writeHead(405); response.end(); return }
    const scenario = url.pathname.slice('/__ui/worker/'.length)
    const page = render(scenario)
    if (!page) { response.writeHead(404); response.end('Unknown preview'); return }
    void page.text().then(html => {
      const nonce = html.match(/<script nonce="([^"]+)"/u)?.[1] ?? 'local-ui-preview'
      // Only this dev response allows the local gallery frame. Production CSP is unchanged.
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
        'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'none'; frame-ancestors 'self' http://127.0.0.1:5730; base-uri 'none'; form-action 'none'`,
      })
      response.end(html.replace('</head>', `<script nonce="${nonce}">${fixtureScript(scenario)}</script></head>`))
    }).catch(next)
  }
}
