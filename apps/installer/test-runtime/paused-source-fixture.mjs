import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import worker, { managedSourceHash } from '../../../payload/worker/index.js';
import { ACCOUNT_ID, canonicalJson, cloudflareProvider, installReadyGateway, portalOnlyClaim, prefixedSha256, withProviderFetch } from '../../../test/payload-lifecycle.mjs';

export const sourceUrl = 'https://source.example.net/mcp';
const sourcesKey = 'ankka-mcp-gateway/management-sources/v1';
const actionsKey = 'ankka-mcp-gateway/source-actions/v1';

// Produce the seed through the actual installer, draft save, prepare and apply.
// No hand-authored receipts or hashes can make the runtime test accept a state
// that production would not create.
export async function pausedGateway({ onRequest } = {}) {
  const provider = cloudflareProvider({ onRequest(context) {
    const intercepted = onRequest?.(context);
    if (intercepted !== undefined) return intercepted;
    const { record, state } = context;
    if (record.method === 'POST' && record.pathname.endsWith('/mcp/servers')) {
      const server = { ...record.body, authentication_status: 'required', status: 'waiting', tools: [] };
      state.servers.set(server.id, server);
      return Response.json({ success: true, result: server });
    }
  } });
  const gateway = await installReadyGateway({ provider, claimInput: await portalOnlyClaim() });
  gateway.env.ANKKA_MANAGEMENT_TOKEN = randomBytes(32).toString('base64url');
  const stub = gateway.env.ADMIN_STATE.get('v1:management');
  const storage = gateway.objects.get('v1:management').storage;
  const post = (path, body, put = false) => stub.fetch(new Request(`https://admin-state.invalid${path}`, {
    method: put ? 'PUT' : 'POST', headers: { 'content-type': 'application/json' }, body: canonicalJson(body),
  }));
  const saved = await post('/sources', { schemaVersion: 1, revision: storage.snapshot(sourcesKey).revision,
    source: { label: 'Synthetic sign-in', url: sourceUrl, authMode: 'oauth', enabledTools: [] } }, true);
  assert.equal(saved.status, 200, await saved.clone().text());
  const sources = await saved.json(), source = sources.sources.at(-1);
  const actionKey = randomBytes(32).toString('base64url'), issuedAt = Date.now();
  const actionId = `action_${randomBytes(24).toString('base64url')}`;
  const prepared = await post('/source-actions', { schemaVersion: 1, actionId, sourceId: source.id, sourceRevision: sources.revision,
    actorEmail: 'admin@example.com', issuedAt, expiresAt: issuedAt + 600_000,
    actionKeyHash: await prefixedSha256(actionKey), sourceHash: await managedSourceHash(source) });
  assert.equal(prepared.status, 200, await prepared.clone().text());
  const body = canonicalJson({ schemaVersion: 1, actionId, actionKey, actorEmail: 'admin@example.com', accountId: ACCOUNT_ID,
    issuedAt, expiresAt: issuedAt + 600_000, cloudflareAccessToken: gateway.env.ANKKA_MANAGEMENT_TOKEN });
  const signature = createHmac('sha256', Buffer.from(actionKey, 'base64url')).update(body).digest('hex');
  const applied = await withProviderFetch((request) => request.url === sourceUrl
    ? Promise.resolve(new Response(null, { status: 401, headers: { 'www-authenticate': 'Bearer resource_metadata="https://source.example.net/.well-known/oauth-protected-resource/mcp"' } }))
    : provider.fetch(request), () => worker.fetch(new Request('https://ankka-gateway-test.tenant.workers.dev/__ankka/source-action', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-ankka-source-action-signature': `sha256=${signature}` }, body,
  }), gateway.env));
  assert.equal((await applied.json()).error, 'source_connection_required');
  return { ...gateway, provider, storage, source, action: storage.snapshot(actionsKey).actions.at(-1), revision: sources.revision };
}
