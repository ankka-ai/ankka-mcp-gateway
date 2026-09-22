import { DynamicWorkerExecutor } from '@cloudflare/codemode';
import { z } from 'zod';
import { ConnectorRequestError, executeReadRequest, type ReadRequestPlan } from '../../read-only-connectors/src/request';
import { LIMITS, jsonSize, type Connection, type Json, type SourceTool } from './contract';

const requestSchema = z.strictObject({
  method: z.enum(['GET', 'POST']), path: z.string().max(2048),
  query: z.record(z.string(), z.string()).optional(), body: z.json().optional(),
});
export type Outcome = { ok: true; result: Json; requests: number } | { ok: false; error: string; requests: number };

export function permits(tool: SourceTool, plan: ReadRequestPlan): boolean {
  return tool.requests.some((operation) => operation.method === plan.method &&
    new RegExp(`^${operation.path.split('/').map((segment) => /^\{[A-Za-z][A-Za-z0-9_]*\}$/u.test(segment)
      ? '[^/]+' : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('/')}$`, 'u').test(plan.path));
}

export async function executeTool(
  tool: SourceTool, input: Json, connection: Connection, credential: string, loader: WorkerLoader,
  fetcher: typeof globalThis.fetch = (request, init) => globalThis.fetch(request, init),
): Promise<Outcome> {
  let requests = 0;
  let closed = false;
  let failure: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = Date.now() + LIMITS.milliseconds;
  try {
    if (credential.length < 1 || credential.length > 8192 || /[\r\n]/u.test(credential)) throw new Error();
    if (jsonSize(input) > LIMITS.inputBytes || !z.fromJSONSchema(tool.inputSchema).safeParse(input).success) {
      return { ok: false, error: 'api_source_input_invalid', requests };
    }
    const limitedLoader: WorkerLoader = {
      load: (code) => loader.load({ ...code, limits: { cpuMs: 100, subRequests: 32 } }),
      get: (id, getCode) => loader.get(id, async () => ({ ...await getCode(), limits: { cpuMs: 100, subRequests: 32 } })),
    };
    const executor = new DynamicWorkerExecutor({ loader: limitedLoader, timeout: LIMITS.milliseconds, globalOutbound: null, modules: {}, bindings: {} });
    const execution = executor.execute(`async () => { const run = (${tool.code}); return await run(await input.read()); }`, [
      { name: 'input', fns: { read: async () => input } },
      { name: 'api', fns: { request: async (...args) => {
        if (closed || Date.now() >= deadline || requests >= LIMITS.requests) {
          failure = 'api_source_request_budget';
          throw new Error(failure);
        }
        requests++;
        const parsed = requestSchema.safeParse(args[0]);
        if (!parsed.success || args.length !== 1) {
          failure = 'api_source_request_invalid';
          throw new Error(failure);
        }
        const plan: ReadRequestPlan = { method: parsed.data.method, path: parsed.data.path };
        if (parsed.data.query !== undefined) Object.defineProperty(plan, 'query', { value: parsed.data.query, enumerable: true });
        if (parsed.data.body !== undefined) Object.defineProperty(plan, 'body', { value: parsed.data.body, enumerable: true });
        try {
          const result = await executeReadRequest({ origin: connection.origin, plan,
            headers: { [connection.authHeader]: connection.authPrefix + credential },
            allowRequest: (candidate) => !closed && Date.now() < deadline && permits(tool, candidate), fetch: fetcher });
          // An echo/debug API must not return the configured credential to generated code.
          if (JSON.stringify(result).includes(credential)) throw new Error();
          return result;
        } catch (error) {
          failure = error instanceof ConnectorRequestError ? error.code.toLowerCase() : 'api_source_response_rejected';
          throw new Error(failure);
        }
      } } },
    ]);
    // The host deadline remains effective even if generated code changes sandbox timers.
    const executed = await Promise.race([execution, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        closed = true;
        failure = 'api_source_execution_timeout';
        reject(new Error(failure));
      }, LIMITS.milliseconds);
    })]);
    if (failure || executed.error) return { ok: false, error: failure ?? 'api_source_execution_failed', requests };
    const parsed = z.json().safeParse(executed.result);
    if (!parsed.success || jsonSize(parsed.data) > LIMITS.outputBytes || JSON.stringify(parsed.data).includes(credential)) {
      return { ok: false, error: 'api_source_result_invalid', requests };
    }
    return { ok: true, result: parsed.data, requests };
  } catch { return { ok: false, error: failure ?? 'api_source_execution_failed', requests }; }
  finally { closed = true; clearTimeout(timer); }
}
