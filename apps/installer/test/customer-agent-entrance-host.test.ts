import { describe, expect, it } from 'vitest';

import worker from '../src/customer-gateway-entrypoint';

const TOKEN = 'A'.repeat(43);
const CLIENT_ID = `${'a'.repeat(32)}.access`;

/** The deployed entrypoint in front of a management object that records what reaches it. */
function entrypoint() {
  const forwarded: string[] = [];
  const namespace: DurableObjectNamespace = Object.create(null);
  Object.defineProperties(namespace, {
    idFromName: { value: (name: string) => name },
    get: { value: () => ({ fetch: async (request: Request) => {
      forwarded.push(`${request.method} ${new URL(request.url).pathname}`);
      return Response.json({ schemaVersion: 1, error: 'not_found' }, { status: 404 });
    } }) },
  });
  const context: ExecutionContext = Object.create(null);
  const env: Parameters<typeof worker.fetch>[1] = {
    API_LOADER: { get: () => { throw new Error('unexpected execution'); }, load: () => { throw new Error('unexpected execution'); } },
    ADMIN_STATE: namespace, ADMIN_EMAILS: 'admin@example.com', ANKKA_INSTALL_ID: `acg-${'b'.repeat(24)}`,
    ANKKA_GATEWAY_RELEASE: 'gateway-v0.2.45', ANKKA_GATEWAY_RELEASE_SHA256: `sha256:${'f'.repeat(64)}`,
    ANKKA_MANAGEMENT_HOSTNAME: 'manage.example.com', ANKKA_UPDATE_CHANNEL: 'canary', ANKKA_UPDATE_KEY_ID: 'synthetic',
    ANKKA_UPDATE_PUBLIC_KEY: TOKEN, ANKKA_WORKERS_SUBDOMAIN: 'customer', ANKKA_WORKER_NAME: 'ankka-gateway',
    CF_ACCESS_AUD: 'c'.repeat(64), CF_ACCESS_ISSUER: 'https://team.cloudflareaccess.com', CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
    CLOUDFLARE_ZONE_ID: 'd'.repeat(32), CLOUDFLARE_ZONE_NAME: 'example.com', ZERO_TRUST_READY: 'true',
    ANKKA_GATEWAY_OWNERSHIP_WRAP_KEY: TOKEN,
  };
  return { forwarded, fetch: (request: Request) => worker.fetch(request, env, context) };
}

describe('the agent entrance hostname', () => {
  it('never reaches an installer, operation, BigQuery or management route', async () => {
    const edge = entrypoint();
    for (const [method, path] of [
      ['GET', '/__ankka/install'], ['GET', '/__ankka/install/status'], ['GET', '/__ankka/operation'],
      ['POST', '/__ankka/install/oauth/callback'], ['GET', '/api/bigquery'], ['POST', '/api/bigquery'],
      ['POST', '/api/teardown-actions'], ['GET', '/api/team'], ['GET', '/api/agent-entrance'], ['GET', '/'],
      ['POST', '/mcp'], ['POST', '/api/mcp'],
    ] as const) {
      const response = await edge.fetch(new Request(`https://agents.example.com${path}`, { method, body: method === 'POST' ? '{}' : null }));
      expect(response.status, `${method} ${path}`).toBe(404);
    }
    expect(edge.forwarded).toEqual([]);
  });

  it('serves its MCP route, which asks the management object only to admit the agent', async () => {
    const edge = entrypoint();
    const bearer = `ankka_agent_v1_${Buffer.from(`${CLIENT_ID}:synthetic-secret-0123456789`).toString('base64url')}`;
    const response = await edge.fetch(new Request('https://agents.example.com/api/agents/mcp', { method: 'POST',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) }));
    // The synthetic object says the entrance is off for this hostname.
    expect(response.status).toBe(404);
    expect(edge.forwarded).toEqual(['POST /agent-entrance/admit']);
  });
});
