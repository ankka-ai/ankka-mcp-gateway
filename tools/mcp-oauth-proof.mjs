// Opt-in experiment for the undocumented dashboard credential-import contract.
// Does not install a gateway or modify an existing source, portal or application.
import { randomBytes } from 'node:crypto';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'esbuild';
import * as v from 'valibot';
import { resolveOperatorCredential } from './operator-credential.mjs';
import { createStatelessPortalTransport, LivePortalCanaryError } from './live-portal-canary.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const FIXTURE = 'ankka-mcp-oauth-proof';
const idSchema = v.pipe(v.string(), v.regex(/^[a-f0-9]{32}$/u));
const reference = v.union([v.strictObject({ env: v.string() }),
  v.strictObject({ keychain: v.strictObject({ service: v.string(), account: v.string() }) })]);
const jobSchema = v.strictObject({ accountId: idSchema,
  zoneName: v.pipe(v.string(), v.regex(/^(?:[a-z0-9-]+\.)+[a-z]{2,}$/u)),
  deploymentCredential: reference, managementCredential: reference });
const allowlist = [{ name: 'synthetic_status', enabled: true }, { name: 'synthetic_other_read', enabled: false }];
class ProofError extends Error {
  constructor(code, status, providerCodes) { super(code); this.code = code; this.status = status; this.providerCodes = providerCodes; }
}
const ensure = (condition, code) => { if (!condition) throw new ProofError(code); };
let stage = 'preflight';
const progress = (name) => { stage = name; process.stdout.write(`${JSON.stringify({ stage })}\n`); };

// Never include request URLs, bodies, provider messages or exception text in output.
async function request(url, init = {}) {
  try { return await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(20_000) }); }
  catch { throw new ProofError('transport_failed'); }
}
async function readJson(response) {
  const reader = response.body?.getReader();
  ensure(reader, 'response_empty');
  let bytes = 0, text = '', count = 0;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      ensure(bytes <= 512 * 1024 && ++count <= 512, 'response_too_large');
      text += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } catch (error) {
    if (error instanceof ProofError) throw error;
    throw new ProofError('response_invalid');
  } finally { void reader.cancel().catch(() => {}); }
}
function provider(token) {
  return async (method, path, body, { absent = false } = {}) => {
    const form = body instanceof FormData;
    const init = { method, headers: { authorization: `Bearer ${token}` } };
    if (!form) init.headers['content-type'] = 'application/json';
    if (body !== undefined) init.body = form ? body : JSON.stringify(body);
    const response = await request(`https://api.cloudflare.com/client/v4${path}`, init);
    if (absent && response.status === 404) { await response.body?.cancel(); return null; }
    const value = await readJson(response);
    if (!response.ok || value.success !== true) {
      const error = new ProofError('provider_rejected', response.status,
        (value.errors || []).map((item) => item.code).filter(Number.isInteger));
      const details = value.result?.error_details;
      if (details) error.upstream = { status: details.status_code, mcpCode: details.mcp_code, retryable: details.retryable, isUpstream: details.is_upstream,
        categories: ['schema', 'validation', 'invalid', 'unauthorized', 'authentication', 'initialize', 'discover', 'token', 'refresh', 'scope', 'response', 'header', 'protocol', 'fetch', 'connect', 'unsupported', 'resultType', 'parse', 'required']
          .filter((word) => `${value.result.error || ''} ${details.cause || ''}`.toLowerCase().includes(word.toLowerCase())) };
      throw error;
    }
    return value.result;
  };
}
function upload(code, metadata) {
  const form = new FormData();
  form.set('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.set('worker.mjs', new Blob([code], { type: 'application/javascript+module' }), 'worker.mjs');
  return form;
}
async function privateJson(path) {
  ensure(isAbsolute(path), 'private_path_required');
  const rel = relative(ROOT, resolve(path));
  ensure(rel.startsWith('..') || isAbsolute(rel), 'private_file_inside_repository');
  const info = await stat(path);
  ensure(info.isFile() && (info.mode & 0o077) === 0 && info.size <= 32_768, 'private_file_permissions');
  return JSON.parse(await readFile(path, 'utf8'));
}
async function run() {
  const [mode, jobPath, receiptPath] = process.argv.slice(2);
  ensure(['run', 'cleanup'].includes(mode) && process.argv.length === 4 && receiptPath === undefined, 'usage');
  const job = v.parse(jobSchema, await privateJson(jobPath));
  const receiptFile = resolve(dirname(jobPath), 'oauth-proof.receipt.json');
  const api = provider(await resolveOperatorCredential(job.deploymentCredential));
  const account = `/accounts/${job.accountId}`;
  const sourceBase = `${account}/access/ai-controls/mcp/servers`;
  const portalBase = `${account}/access/ai-controls/mcp/portals`;
  const appsBase = `${account}/access/apps`;
  const tokensBase = `${account}/access/service_tokens`;
  let receipt;
  async function save() { await writeFile(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 }); }
  async function list(path) {
    const all = [];
    for (let page = 1; page <= 100; page++) {
      const result = await api('GET', `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      ensure(Array.isArray(result), 'list_invalid'); all.push(...result);
      if (result.length < 100) return all;
    }
    throw new ProofError('list_limit');
  }
  async function cleanup() {
    progress('cleanup');
    ensure(receipt.accountId === job.accountId && /^oauth-proof-[a-f0-9]{12}$/u.test(receipt.id)
      && receipt.marker === `${FIXTURE}:${receipt.id}` && receipt.hostname === `${receipt.id}.${job.zoneName}`, 'receipt_invalid');
    // Re-discover by exact random ownership marker to cover a lost create response.
    for (const app of (await list(appsBase)).filter((item) => [receipt.marker + ':source', receipt.marker + ':portal'].includes(item.name))) {
      const live = await api('GET', `${appsBase}/${app.id}`);
      const sourceOwned = live.type === 'mcp' && live.destinations?.length === 1
        && live.destinations[0].mcp_server_id === receipt.id;
      const portalOwned = live.type === 'mcp_portal' && live.domain === receipt.hostname;
      ensure(sourceOwned || portalOwned, 'cleanup_ownership');
      await api('DELETE', `${appsBase}/${app.id}`);
    }
    const portal = await api('GET', `${portalBase}/${receipt.id}`, undefined, { absent: true });
    if (portal) {
      ensure(portal.description === receipt.marker && portal.hostname === receipt.hostname, 'cleanup_ownership');
      await api('DELETE', `${portalBase}/${receipt.id}`);
    }
    if (receipt.zoneId) {
      v.parse(idSchema, receipt.zoneId);
      for (const dns of await list(`/zones/${receipt.zoneId}/dns_records?name=${receipt.hostname}`)) {
        ensure(dns.comment === receipt.marker && dns.type === 'CNAME' && dns.content === 'gateway.agents.cloudflare.com', 'cleanup_ownership');
        await api('DELETE', `/zones/${receipt.zoneId}/dns_records/${dns.id}`);
      }
    }
    const source = await api('GET', `${sourceBase}/${receipt.id}`, undefined, { absent: true });
    if (source) {
      ensure(source.description === receipt.marker && source.hostname === `${receipt.origin}/mcp`, 'cleanup_ownership');
      await api('DELETE', `${sourceBase}/${receipt.id}`);
    }
    for (const token of (await list(tokensBase)).filter((item) => [receipt.marker + ':client1', receipt.marker + ':client2'].includes(item.name))) {
      await api('DELETE', `${tokensBase}/${token.id}`);
    }
    const settingsPath = `${account}/workers/scripts/${receipt.id}/settings`;
    const worker = await api('GET', settingsPath, undefined, { absent: true });
    if (worker) {
      ensure(worker.tags?.includes(receipt.marker), 'cleanup_ownership');
      await api('DELETE', `${account}/workers/scripts/${receipt.id}?force=true`);
    }
    ensure(!(await api('GET', `${sourceBase}/${receipt.id}`, undefined, { absent: true })), 'cleanup_source_remaining');
    ensure(!(await api('GET', `${portalBase}/${receipt.id}`, undefined, { absent: true })), 'cleanup_portal_remaining');
    ensure(!(await api('GET', settingsPath, undefined, { absent: true })), 'cleanup_worker_remaining');
    const namespaces = await api('GET', `${account}/workers/durable_objects/namespaces`);
    ensure(!namespaces.some((item) => item.script === receipt.id || item.name?.startsWith(`${receipt.id}_`)), 'cleanup_namespace_remaining');
    ensure(!(await list(appsBase)).some((item) => [receipt.marker + ':source', receipt.marker + ':portal'].includes(item.name)), 'cleanup_app_remaining');
    ensure(!(await list(tokensBase)).some((item) => [receipt.marker + ':client1', receipt.marker + ':client2'].includes(item.name)), 'cleanup_client_remaining');
    if (receipt.zoneId) ensure((await list(`/zones/${receipt.zoneId}/dns_records?name=${receipt.hostname}`)).length === 0, 'cleanup_dns_remaining');
    receipt.cleaned = true; await save(); progress('cleaned');
  }
  if (mode === 'cleanup') { receipt = await privateJson(receiptFile); await cleanup(); return; }
  try {
    const previous = await privateJson(receiptFile);
    ensure(previous.cleaned === true, 'cleanup_previous_run_first');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const management = await resolveOperatorCredential(job.managementCredential);
  const control = randomBytes(32).toString('base64url');
  const id = `oauth-proof-${randomBytes(6).toString('hex')}`;
  const subdomain = (await api('GET', `${account}/workers/subdomain`)).subdomain;
  ensure(/^[a-z0-9-]+$/u.test(subdomain), 'subdomain_invalid');
  const zones = await list(`/zones?name=${job.zoneName}&account.id=${job.accountId}`);
  ensure(zones.length === 1 && zones[0].account.id === job.accountId, 'zone_invalid');
  const zoneId = v.parse(idSchema, zones[0].id);
  const origin = `https://${id}.${subdomain}.workers.dev`;
  const hostname = `${id}.${job.zoneName}`, marker = `${FIXTURE}:${id}`;
  receipt = { accountId: job.accountId, zoneId, id, hostname, origin, marker, cleaned: false };
  ensure(!(await api('GET', `${sourceBase}/${id}`, undefined, { absent: true })), 'source_collision');
  ensure(!(await api('GET', `${portalBase}/${id}`, undefined, { absent: true })), 'portal_collision');
  ensure(!(await api('GET', `${account}/workers/scripts/${id}/settings`, undefined, { absent: true })), 'worker_collision');
  await save();
  let completed = false;
  try {
    progress('deploy_fixture');
    const bundle = await build({ entryPoints: [resolve(ROOT, 'fixtures/mcp-oauth-proof/worker.mjs')], bundle: true,
      write: false, format: 'esm', platform: 'browser', target: 'es2022', external: ['cloudflare:workers'] });
    const vars = { PUBLIC_ORIGIN: origin, ACCOUNT_ID: job.accountId, SERVER_ID: id,
      EXPIRES_AT: String(Date.now() + 3_600_000), ACCESS_TTL_SECONDS: '90' };
    const metadata = { main_module: 'worker.mjs', compatibility_date: '2026-09-02', tags: [marker],
      compatibility_flags: ['global_fetch_strictly_public'],
      logpush: false, observability: { enabled: false, logs: { enabled: false, invocation_logs: false, persist: false }, traces: { enabled: false, persist: false } },
      migrations: { new_tag: 'v1', new_sqlite_classes: ['OAuthProofState'] },
      bindings: [{ type: 'durable_object_namespace', name: 'STATE', class_name: 'OAuthProofState' },
        ...Object.entries(vars).map(([name, text]) => ({ name, text, type: 'plain_text' })),
        { type: 'secret_text', name: 'CONTROL_SECRET', text: control },
        { type: 'secret_text', name: 'ANKKA_MANAGEMENT_TOKEN', text: management }] };
    await api('PUT', `${account}/workers/scripts/${id}`, upload(bundle.outputFiles[0].text, metadata));
    await api('POST', `${account}/workers/scripts/${id}/subdomain`, { enabled: true, previews_enabled: false });
    let ready = false;
    for (let attempt = 0; attempt < 15; attempt++) {
      try { const health = await request(`${origin}/health`); ready = health.ok && (await readJson(health)).fixture === FIXTURE; } catch { /* DNS propagation. */ }
      if (ready) break; await delay(2_000);
    }
    ensure(ready, 'fixture_unavailable');
    // The HTTP route can become healthy before its new namespace reaches all edges.
    await delay(3_000);
    progress('create_synthetic_source');
    await api('POST', sourceBase, { id, name: 'Synthetic OAuth proof', hostname: `${origin}/mcp`, description: marker,
      auth_type: 'oauth', secure_web_gateway: false, updated_tools: allowlist.map((item) => ({ ...item, enabled: false })) });
    const sourceAppBody = { name: `${marker}:source`, type: 'mcp', destinations: [{ type: 'via_mcp_server_portal', mcp_server_id: id }] };
    const sourceApp = await api('POST', appsBase, sourceAppBody);
    await delay(2_000);
    progress('self_hosted_callback');
    const start = await request(`${origin}/client/start`, { method: 'POST', headers: { authorization: `Bearer ${control}` } });
    if (start.status !== 303) {
      const diagnostics = await readJson(await request(`${origin}/control/report`, { headers: { authorization: `Bearer ${control}` } }));
      process.stdout.write(`${JSON.stringify({ counters: diagnostics.counters })}\n`);
      throw new ProofError('start_failed', start.status);
    }
    const cookie = start.headers.get('set-cookie')?.split(';')[0];
    ensure(cookie?.startsWith('__Host-ankka-proof='), 'cookie_missing');
    let location = new URL(start.headers.get('location'));
    ensure(location.origin === origin && location.pathname === '/authorize', 'authorization_destination');
    const authorization = await request(location, { headers: { cookie } });
    if (authorization.status !== 303) throw new ProofError('authorization_failed', authorization.status);
    location = new URL(authorization.headers.get('location'));
    ensure(location.origin === origin && location.pathname === '/client/callback', 'callback_destination');
    const callback = await request(location, { headers: { cookie } });
    ensure(callback.status === 303 && callback.headers.get('location') === `${origin}/client/complete`, 'callback_failed');
    ensure((await request(location, { headers: { cookie } })).status === 400, 'callback_replay');
    const report = async () => (await readJson(await request(`${origin}/control/report`, { headers: { authorization: `Bearer ${control}` } }))).counters;
    let counters = await report();
    ensure(counters.codeExchanges === 1 && counters.imports === 1, 'grant_not_imported');
    progress('cloudflare_sync');
    for (let attempt = 0; attempt < 5; attempt++) {
      try { await api('POST', `${sourceBase}/${id}/sync`); break; }
      catch (error) {
        if (attempt === 4 || !(error instanceof ProofError) || !error.upstream?.retryable) throw error;
        await delay(3_000);
      }
    }
    let source;
    for (let attempt = 0; attempt < 20; attempt++) {
      source = await api('GET', `${sourceBase}/${id}`);
      if (source.tools?.length === 2) break;
      await delay(1_500);
    }
    ensure(source.tools?.length === 2, 'source_discovery_failed');
    await api('PUT', `${sourceBase}/${id}`, { updated_tools: allowlist, updated_prompts: [] });
    progress('create_two_service_clients');
    const clients = [];
    for (const number of [1, 2]) clients.push(await api('POST', tokensBase, { name: `${marker}:client${number}`, duration: '1h' }));
    const policies = [{ name: marker, decision: 'non_identity', include: clients.map((client) => ({ service_token: { token_id: client.id } })), exclude: [], require: [] }];
    await api('PUT', `${appsBase}/${sourceApp.id}`, { ...sourceAppBody, policies });
    await api('POST', portalBase, { id, name: 'Synthetic OAuth proof', description: marker, hostname, code_mode: 'off', secure_web_gateway: false,
      servers: [{ id, server_id: id, on_behalf: false, default_disabled: true, updated_tools: allowlist, updated_prompts: [] }] });
    await api('POST', appsBase, { name: `${marker}:portal`, type: 'mcp_portal', domain: hostname,
      destinations: [{ type: 'public', uri: hostname }], policies,
      oauth_configuration: { enabled: true, dynamic_client_registration: { enabled: true, allow_any_on_localhost: true, allow_any_on_loopback: true },
        grant: { access_token_lifetime: '15m', session_duration: '1h' } } });
    await api('POST', `/zones/${zoneId}/dns_records`, { type: 'CNAME', name: hostname, content: 'gateway.agents.cloudflare.com', proxied: true, ttl: 1, comment: marker });
    // DNS and policy propagation overlaps the natural token-expiry wait.
    progress('cloudflare_refresh_after_expiry');
    const refreshesBeforeExpiry = (await report()).refreshes || 0;
    await delay(45_000);
    await delay(46_000);
    await api('POST', `${sourceBase}/${id}/sync`);
    for (let attempt = 0; attempt < 15; attempt++) {
      counters = await report(); if (counters.refreshes > refreshesBeforeExpiry) break;
      await delay(1_000);
    }
    ensure(counters.refreshes > refreshesBeforeExpiry, 'cloudflare_refresh_not_observed');
    progress('shared_grant_read_only_calls');
    let requestId = 0;
    for (const client of clients) {
      const transport = createStatelessPortalTransport(`https://${hostname}/mcp`, { environment: { CF_ACCESS_CLIENT_ID: client.client_id, CF_ACCESS_CLIENT_SECRET: client.client_secret } });
      const rpc = (method, params = {}) => transport({ id: ++requestId, method, name: params.name,
        params: { ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientCapabilities': {}, 'io.modelcontextprotocol/clientInfo': { name: FIXTURE, version: '1.0.0' } } } });
      let listed;
      for (let attempt = 0; attempt < 24; attempt++) {
        try { listed = await rpc('tools/list'); if (listed.result?.tools) break; }
        catch (error) {
          if (attempt === 0 && error instanceof LivePortalCanaryError) process.stdout.write(`${JSON.stringify({ portalTransport: error.code })}\n`);
        }
        await delay(2_500);
      }
      ensure(listed?.result?.tools, 'portal_unavailable');
      if (!listed.result.tools.some((tool) => tool.name.endsWith('synthetic_status'))) {
        const toggle = await rpc('tools/call', { name: 'portal_toggle_single_server', arguments: { server_id: id, action: 'toggle' } });
        ensure(!toggle.error && !toggle.result?.isError, 'portal_enable_failed');
      }
      listed = await rpc('tools/list');
      const names = listed.result?.tools?.map((tool) => tool.name) || [];
      const toolName = names.find((name) => name.endsWith('synthetic_status'));
      ensure(toolName && !names.some((name) => name.includes('synthetic_other_read')), 'portal_allowlist_failed');
      const result = await rpc('tools/call', { name: toolName, arguments: {} });
      ensure(!result.error && result.result?.isError === false && result.result.content?.some((item) => {
        if (item.type !== 'text') return false;
        try { return JSON.parse(item.text).fixture === FIXTURE; } catch { return false; }
      }), 'shared_read_failed');
      const denied = await rpc('tools/call', { name: toolName.replace('synthetic_status', 'synthetic_other_read'), arguments: {} });
      ensure(denied.error || denied.result?.isError, 'disabled_read_allowed');
    }
    counters = await report();
    ensure(counters.codeExchanges === 1 && counters.imports === 1 && counters.readCalls >= 2 && !counters.otherReadCalls, 'shared_grant_failed');
    receipt.evidence = { selfHostedCallback: true, replayRejected: true, cloudflareRefresh: true, serviceClients: 2, sharedGrant: true, allowlist: true, counters };
    await save(); completed = true;
    process.stdout.write(`${JSON.stringify({ evidence: receipt.evidence })}\n`);
  } catch (error) {
    if (error instanceof ProofError) error.stage = stage;
    try {
      const diagnostics = await readJson(await request(`${origin}/control/report`, { headers: { authorization: `Bearer ${control}` } }));
      process.stdout.write(`${JSON.stringify({ counters: diagnostics.counters })}\n`);
    } catch { /* Best-effort, bounded diagnostics contain counters only. */ }
    throw error;
  } finally { await cleanup(); }
  ensure(completed, 'proof_incomplete');
}
try { await run(); }
catch (error) {
  const safe = error instanceof ProofError ? { code: error.code, status: error.status, providerCodes: error.providerCodes, upstream: error.upstream } : { code: 'internal_failure' };
  process.stderr.write(`${JSON.stringify({ failed: true, stage: error.stage || stage, ...safe })}\n`); process.exitCode = 1;
}
