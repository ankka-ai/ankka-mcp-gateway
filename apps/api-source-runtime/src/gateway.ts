import { z } from 'zod';
import { readRequestBody } from '../../read-only-connectors/src/incoming';
import { AUTHORING_GUIDE, connectionSchema } from './contract';
import { ApiSourceStore } from './state';

export const connectionKeySchema = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);
const connectionsSchema = z.record(connectionKeySchema, z.strictObject({
  connection: connectionSchema,
  credential: z.string().min(1).max(8192).regex(/^[^\r\n]+$/),
})).refine((entries) => Object.keys(entries).length <= 32);
const requestSchema = z.strictObject({
  operation: z.enum(['read', 'save', 'test', 'activate', 'disable', 'discard', 'catalogue', 'call']),
  connectionKey: connectionKeySchema.optional(),
  revision: z.number().optional(), definitionJson: z.string().optional(),
  tool: z.string().optional(), argumentsJson: z.string().optional(),
});

export interface GatewayApiEnv {
  ANKKA_API_CONNECTIONS?: string;
  ANKKA_MANAGEMENT_HOSTNAME: string;
  API_LOADER: WorkerLoader;
}

/** The secret pairs each credential with its destination; management code cannot rebind either. */
export async function gatewayApiRequest(request: Request, env: GatewayApiEnv, storage: DurableObjectStorage): Promise<Response> {
  try {
    const raw = env.ANKKA_API_CONNECTIONS ?? '{}';
    if (raw.length > 32_768) throw new Error();
    const connections = connectionsSchema.parse(JSON.parse(raw));
    const text = await readRequestBody(request);
    const { connectionKey, ...command } = requestSchema.parse(JSON.parse(text));
    if (command.operation === 'read' && connectionKey === undefined) return Response.json({
      guide: AUTHORING_GUIDE,
      connections: Object.entries(connections).map(([key, { connection }]) => ({ connectionKey: key, connection })),
      setup: 'Configure ANKKA_API_CONNECTIONS as a secret directly on your gateway Worker. Each key maps to {connection, credential}. Never send credentials to an agent or management MCP.',
    });
    const configured = connectionKey === undefined || !Object.hasOwn(connections, connectionKey) ? undefined : connections[connectionKey];
    if (!configured) return Response.json({ error: 'api_source_connection_required' }, { status: 409 });
    const source = new ApiSourceStore(storage, {
      CONNECTION_JSON: JSON.stringify(configured.connection), PROVIDER_TOKEN: configured.credential, LOADER: env.API_LOADER,
    }, `https://${env.ANKKA_MANAGEMENT_HOSTNAME}/api/api-sources/${connectionKey}/mcp`, `api-source/v1/${connectionKey}`);
    if (command.operation === 'catalogue') return new Response(await source.catalogue(), { headers: { 'content-type': 'application/json' } });
    if (command.operation === 'call') {
      if (command.tool === undefined || command.argumentsJson === undefined) throw new Error();
      return new Response(await source.call(command.tool, command.argumentsJson), { headers: { 'content-type': 'application/json' } });
    }
    return source.manage(JSON.stringify(command));
  } catch { return Response.json({ error: 'api_source_input_or_configuration_invalid' }, { status: 400 }); }
}
