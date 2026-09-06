import * as v from 'valibot';

/**
 * Read-only inventory of what a deployment credential can currently read, by
 * Cloudflare endpoint family. Output carries fixed family labels and HTTP
 * statuses only: no token, account, zone, resource identifiers or bodies.
 * Write permissions cannot be proven without writing; the first live stage
 * that needs one verifies it.
 */
const API = 'https://api.cloudflare.com/client/v4';
const ID = /^[a-f0-9]{32}$/u;

export class LifecycleCredentialError extends Error {
  constructor(code) { super(code); this.code = code; }
}

function verdict(status) {
  if (status === 200) return 'readable';
  if (status === 401) return 'credential_rejected';
  if (status === 403) return 'denied';
  if (status === 404) return 'not_found';
  if (status === 0) return 'unreachable';
  return status >= 500 ? 'provider_error' : 'rejected';
}

async function probe(transport, token, method, path, body) {
  const headers = { authorization: `Bearer ${token}`, accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  try {
    const response = await transport(`${API}${path}`, {
      method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(20_000),
    });
    let parsed = null;
    try { parsed = await response.json(); } catch { parsed = null; }
    return { status: response.status, parsed };
  } catch { return { status: 0, parsed: null }; }
}

const verifySchema = v.looseObject({ result: v.looseObject({ status: v.string(), expires_on: v.optional(v.nullable(v.string())) }) });

/** Families the fixed operation authority catalogue reads or writes. */
export function deploymentCredentialFamilies({ accountId, zoneId }) {
  const account = `/accounts/${accountId}`;
  const zone = `/zones/${zoneId}`;
  const since = new Date(Date.now() - 60 * 60_000).toISOString();
  return [
    ['accounts-list', 'GET', '/accounts?per_page=5'],
    ['zones-list', 'GET', `/zones?account.id=${accountId}&per_page=5`],
    ['zone-read', 'GET', zone],
    ['dns-records', 'GET', `${zone}/dns_records?per_page=1`],
    ['workers-scripts', 'GET', `${account}/workers/scripts?per_page=1`],
    ['workers-subdomain', 'GET', `${account}/workers/subdomain`],
    ['workers-custom-domains', 'GET', `${account}/workers/domains?per_page=1`],
    ['workers-durable-object-namespaces', 'GET', `${account}/workers/durable_objects/namespaces?per_page=1`],
    ['access-organization', 'GET', `${account}/access/organizations`],
    ['access-applications-account', 'GET', `${account}/access/apps?per_page=1`],
    ['access-applications-zone', 'GET', `${zone}/access/apps?per_page=1`],
    ['access-policies', 'GET', `${account}/access/policies?per_page=1`],
    ['access-service-tokens', 'GET', `${account}/access/service_tokens?per_page=1`],
    ['mcp-servers', 'GET', `${account}/access/ai-controls/mcp/servers?per_page=1`],
    ['mcp-portals', 'GET', `${account}/access/ai-controls/mcp/portals?per_page=1`],
    ['workers-analytics', 'POST', '/graphql', JSON.stringify({
      query: 'query($accountTag:string!,$from:Time!){viewer{accounts(filter:{accountTag:$accountTag}){workersInvocationsAdaptive(limit:1,filter:{datetime_geq:$from}){sum{requests}}}}}',
      variables: { accountTag: accountId, from: since },
    })],
  ];
}

export async function inventoryDeploymentCredential({ token, accountId, zoneId, transport = fetch }) {
  if (!v.is(v.pipe(v.string(), v.minLength(20)), token) || !ID.test(accountId) || !ID.test(zoneId)) {
    throw new LifecycleCredentialError('credential_inventory_input_invalid');
  }
  const identity = { kind: 'unknown', status: null, expiresOn: null };
  for (const [kind, path] of [['user_owned', '/user/tokens/verify'], ['account_owned', `/accounts/${accountId}/tokens/verify`]]) {
    const result = await probe(transport, token, 'GET', path);
    const parsed = v.safeParse(verifySchema, result.parsed);
    if (result.status === 200 && parsed.success) {
      identity.kind = kind; identity.status = parsed.output.result.status;
      identity.expiresOn = parsed.output.result.expires_on ?? null;
      break;
    }
  }
  const families = [];
  for (const [family, method, path, body] of deploymentCredentialFamilies({ accountId, zoneId })) {
    const result = await probe(transport, token, method, path, body);
    let outcome = verdict(result.status);
    if (family === 'workers-analytics' && result.status === 200 && Array.isArray(result.parsed?.errors) && result.parsed.errors.length > 0) outcome = 'denied';
    families.push({ family, status: result.status, outcome });
  }
  return { schemaVersion: 1, identity, families };
}

// Only the tool itself runs its command line; the bundled stage runner imports this module without invoking it.
if (import.meta.url.endsWith('/tools/lifecycle-credentials.mjs') && process.argv[1] && new URL(`file://${process.argv[1]}`).href === import.meta.url) {
  const args = process.argv.slice(2);
  const option = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
  const accountId = option('--account-id');
  const zoneId = option('--zone-id');
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !zoneId || !token || args.length !== 4) {
    console.error('Usage: node tools/lifecycle-credentials.mjs --account-id <id> --zone-id <id>\nReads the deployment token from the CLOUDFLARE_API_TOKEN environment variable of this process only.\nPrints read-only endpoint-family verdicts. Never prints the token, identifiers or provider bodies.');
    process.exitCode = 2;
  } else {
    try {
      const inventory = await inventoryDeploymentCredential({ token, accountId, zoneId });
      console.log(JSON.stringify(inventory, null, 2));
    } catch (error) {
      console.error(error instanceof LifecycleCredentialError ? error.code : 'credential_inventory_failed');
      process.exitCode = 1;
    }
  }
}
