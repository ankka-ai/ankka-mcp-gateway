import { DurableObject } from 'cloudflare:workers';
import * as v from 'valibot';
// @ts-expect-error The production payload is a validated release input, not a TS package.
import { AdminState } from '../../../payload/worker/index.js';

import { createBigQuerySetup } from '../src/customer-bigquery-setup';
import { createBigQueryTeardown } from '../src/customer-bigquery-teardown';
import { BIGQUERY_SETUP_TOOLS, bigQueryHex, bigQuerySourceNames } from '../src/customer-bigquery-contract';
import { canonicalJson } from '../src/canonical-json';

const sourcesKey = 'ankka-mcp-gateway/management-sources/v1';
const actionsKey = 'ankka-mcp-gateway/source-actions/v1';
const sourceId = 'source-0123456789abcdef';
const bridgeKey = `ankka-mcp-gateway/bigquery-source/v1/${sourceId}`;

// Local-only fixture: production deletion against workerd's actual SQLite storage.
export class BootstrapFixture extends DurableObject<{ STATE: DurableObjectNamespace }> {
  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === '/seed-bridge') {
      await this.ctx.storage.put(v.parse(v.record(v.string(), v.unknown()), await request.json()));
      const configuration = { queryProjectId: 'query-project', allowedDatasets: [{ projectId: 'data-project', datasetId: 'reporting' }] };
      const installationId = await this.ctx.storage.get<string>('fixture-installation-id');
      if (!installationId) throw new Error('fixture_context_missing');
      const names = await bigQuerySourceNames(installationId, 'example.com', configuration);
      const source = { id: names.sourceId, label: 'Synthetic bridge', url: names.url, authMode: 'oauth',
        onBehalfOfUser: false, enabledTools: [...BIGQUERY_SETUP_TOOLS] };
      const sourceHash = `sha256:${await bigQueryHex(canonicalJson(source))}`;
      const actionId = `action_${'b'.repeat(32)}`, now = Date.now();
      await this.ctx.storage.put({
        [sourcesKey]: { schemaVersion: 1, revision: 2, applyMode: 'oauth_per_action', sources: [{ ...source, status: 'draft' }] },
        [actionsKey]: { schemaVersion: 1, revision: 1, actions: [{ schemaVersion: 1, actionId, sourceId: source.id,
          sourceRevision: 2, sourceHash, actorEmail: 'admin@example.com', actionKeyHash: `sha256:${'0'.repeat(64)}`,
          issuedAt: now - 700_000, expiresAt: now - 100_000, initialPolicyVersion: 2, status: 'recovery_required',
          resources: [], pending: null, portalUpdate: null, bigquerySetupStarted: true, failureCode: 'bigquery_setup_required' }] },
        [`ankka-mcp-gateway/bigquery-source/v1/${source.id}`]: { schemaVersion: 1, sourceId: source.id, actionId,
          configuration: names.configuration, workerName: names.workerName, hostname: names.hostname,
          operatorEmail: 'admin@example.com', sourceHash, application: null, workerVersion: null,
          domainId: null, pending: null, ready: false },
      });
      return Response.json({ sourceId: source.id });
    }
    if (path === '/prepare-bridge' || path === '/remove-bridge' || path.startsWith('/source-actions/remove-')) {
      const env = await this.ctx.storage.get<Record<string, string>>('fixture-env');
      if (!env?.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_ZONE_ID || !env.ANKKA_INSTALL_ID) throw new Error('fixture_context_missing');
      const context = { accountId: env.CLOUDFLARE_ACCOUNT_ID, zoneId: env.CLOUDFLARE_ZONE_ID,
        installationId: env.ANKKA_INSTALL_ID, zoneName: 'example.com', accessIssuer: 'https://example.cloudflareaccess.com',
        managementOrigin: 'https://manage.example.com', workerName: 'ankka-gateway', workersSubdomain: 'example',
        controlPlaneOrigin: 'https://deploy.ankka.ai', releaseIdentity: { schemaVersion: 1 as const, channel: 'canary' as const,
          controlPlaneOrigin: 'https://deploy.ankka.ai', release: 'gateway-v1.0.0', keyId: 'test-key', publicKey: 'p'.repeat(43), artifactSha256: 'a'.repeat(64) } };
      const managed = createBigQueryTeardown(context, { storage: this.ctx.storage, fetch });
      const runtime = new AdminState(this.ctx, env, managed);
      if (path.startsWith('/source-actions/remove-')) return runtime.fetch(request);
      const setup = createBigQuerySetup(context, { storage: this.ctx.storage, fetch,
        runtime: (command) => runtime.fetch(command),
        removalRuntime: (command) => this.env.STATE.get(this.ctx.id).fetch(command) });
      if (path === '/prepare-bridge') return setup.prepareRemoval(request, 'admin@example.com');
      return setup.remove(await request.json());
    }
    if (path === '/bridge-state') return Response.json(Object.fromEntries(await this.ctx.storage.list()));
    if (path === '/seed') {
      await this.ctx.storage.put({
        [sourcesKey]: { schemaVersion: 1, revision: 1, applyMode: 'oauth_per_action', sources: [{
          id: sourceId, label: 'Synthetic BigQuery', url: 'https://bq.example.com/mcp', authMode: 'oauth',
          onBehalfOfUser: false, enabledTools: ['execute_sql_readonly'], status: 'draft',
        }] },
        [actionsKey]: { schemaVersion: 1, revision: 1, actions: [] },
        [bridgeKey]: { schemaVersion: 1, sourceId, actionId: `action_${'a'.repeat(32)}`,
          configuration: { queryProjectId: 'query-project', allowedDatasets: [{ projectId: 'data-project', datasetId: 'reporting' }] },
          workerName: `ankka-bq-${'a'.repeat(24)}`, hostname: `bq-${'a'.repeat(16)}.example.com`,
          operatorEmail: 'admin@example.com', sourceHash: `sha256:${'0'.repeat(64)}`,
          application: null, workerVersion: null, domainId: null, pending: null, ready: false },
      });
      return Response.json({ seeded: true });
    }
    if (path === '/remove') {
      const runtime = new AdminState(this.ctx, {});
      return runtime.fetch(new Request('https://admin-state.invalid/sources', { method: 'DELETE',
        headers: { 'content-type': 'application/json', 'x-ankka-actor-email': 'admin@example.com' },
        body: JSON.stringify({ schemaVersion: 1, revision: 1, sourceId }),
      }));
    }
    return Response.json({ sources: await this.ctx.storage.get(sourcesKey),
      actions: await this.ctx.storage.get(actionsKey), hasBridge: await this.ctx.storage.get(bridgeKey) !== undefined });
  }
}

export default {
  async fetch(request: Request, env: { STATE: DurableObjectNamespace }): Promise<Response> {
    return env.STATE.get(env.STATE.idFromName('synthetic-removal')).fetch(request);
  },
};
