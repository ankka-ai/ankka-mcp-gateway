import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
import { z } from 'zod';
import { verifyAccess } from '../../read-only-connectors/src/access';
import { readRequestBody } from '../../read-only-connectors/src/incoming';
import { toolSchema } from './contract';
import { ApiSourceStore } from './state';

/** Standalone harness for local runtime verification; releases embed the store in AdminState. */
export class ApiSource extends DurableObject<Env> {
  private store() { return new ApiSourceStore(this.ctx.storage, this.env, `${this.env.PUBLIC_ORIGIN}/mcp`); }
  manage(text: string) { return this.store().manage(text); }
  catalogue() { return this.store().catalogue(); }
  call(name: string, input: string) { return this.store().call(name, input); }
}

const envelope = z.strictObject({
  jsonrpc: z.literal('2.0'), id: z.union([z.string().max(128), z.number().int()]).optional(),
  method: z.string().max(64), params: z.record(z.string(), z.json()).optional(),
});
const callSchema = z.strictObject({ name: z.string(), arguments: z.json().default({}), _meta: z.json().optional() });
function response(value: z.infer<ReturnType<typeof z.json>>, status = 200) {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
}

/** Bind only the gateway management Worker to this named entrypoint. No public route reaches it. */
export class ApiSourceManagement extends WorkerEntrypoint<Env> {
  override async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') return response({ error: 'method_not_allowed' }, 405);
    try {
      const body = await readRequestBody(request);
      return await this.env.SOURCE.get(this.env.SOURCE.idFromName('source')).manage(body);
    } catch { return response({ error: 'api_source_input_invalid' }, 400); }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.origin !== env.PUBLIC_ORIGIN || url.protocol !== 'https:' ||
          request.headers.has('origin') && request.headers.get('origin') !== url.origin) return response({ error: 'origin_rejected' }, 403);
      if (url.pathname !== '/mcp' || url.search !== '') return response({ error: 'not_found' }, 404);
      if (request.method !== 'POST') return response({ error: 'method_not_allowed' }, 405);
      if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') return response({ error: 'content_type_required' }, 415);
      if (!await verifyAccess(request, env.ACCESS_TEAM_DOMAIN, env.ACCESS_AUD, (input, init) => fetch(input, init))) {
        return response({ error: 'access_required' }, 403);
      }
      const parsed = envelope.safeParse(JSON.parse(await readRequestBody(request)));
      if (!parsed.success) return response({ error: 'invalid_request' }, 400);
      const message = parsed.data;
      if (message.id === undefined) return message.method === 'notifications/initialized'
        ? new Response(null, { status: 202 }) : response({ error: 'invalid_request' }, 400);
      const rpc = (result: z.infer<ReturnType<typeof z.json>>) => response({ jsonrpc: '2.0', id: message.id ?? null, result });
      const error = (code: number, text: string) => response({ jsonrpc: '2.0', id: message.id ?? null, error: { code, message: text } });
      if (message.method === 'initialize') return rpc({ protocolVersion: '2025-06-18', capabilities: { tools: {} },
        serverInfo: { name: 'ankka-api-source', version: '0.1.0-alpha.0' } });
      if (message.method === 'ping') return rpc({});
      const source = env.SOURCE.get(env.SOURCE.idFromName('source'));
      if (message.method === 'tools/list') {
        const tools = z.array(toolSchema).parse(JSON.parse(await source.catalogue()));
        return rpc({ tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema,
          annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true } })) });
      }
      if (message.method !== 'tools/call') return error(-32601, 'Method not found');
      const call = callSchema.safeParse(message.params);
      if (!call.success) return error(-32602, 'Invalid arguments');
      const outcome = z.discriminatedUnion('ok', [
        z.object({ ok: z.literal(true), result: z.json() }),
        z.object({ ok: z.literal(false), error: z.string() }),
      ]).parse(JSON.parse(await source.call(call.data.name, JSON.stringify(call.data.arguments))));
      return rpc({ isError: !outcome.ok, content: [{ type: 'text', text: JSON.stringify(outcome.ok ? outcome.result : { error: outcome.error }) }] });
    } catch { return response({ error: 'api_source_unavailable' }, 503); }
  },
} satisfies ExportedHandler<Env>;
