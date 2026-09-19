import { DurableObject } from 'cloudflare:workers';
// @ts-expect-error The production payload is a validated release input, not a TS package.
import { AdminState } from '../../../payload/worker/index.js';

const sourcesKey = 'ankka-mcp-gateway/management-sources/v1';
const actionsKey = 'ankka-mcp-gateway/source-actions/v1';
const sourceId = 'source-0123456789abcdef';
const bridgeKey = `ankka-mcp-gateway/bigquery-source/v1/${sourceId}`;

// Local-only fixture: production deletion against workerd's actual SQLite storage.
export class BootstrapFixture extends DurableObject {
  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
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
