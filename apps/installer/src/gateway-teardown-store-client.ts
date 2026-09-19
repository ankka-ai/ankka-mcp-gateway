import * as v from 'valibot';
import { boundaryObjectSchema } from './boundary';
import { canonicalJson } from './canonical-json';
import { GatewayTeardownDurableStatePort, initializeGatewayTeardownSql, type GatewayTeardownJobPort } from './gateway-teardown-durable-state';
import { parseGatewayTeardownJob, type GatewayTeardownJob } from './gateway-teardown-job';
import type { HostedStage1SessionSqlStorage } from './hosted-stage1-session-durable-state';
import { readBoundedText } from './http';
import type { TwoStageDeploySessionStub } from './two-stage-deploy-session';

const ORIGIN = 'https://two-stage-deploy-session.invalid';
const writeSchema = v.strictObject({ expectedRevision: v.nullable(v.pipe(v.number(), v.safeInteger(), v.minValue(1))), job: boundaryObjectSchema });
/**
 * The consumed callback's code and verifier, handed once to the job object
 * that exchanges them and keeps the grant in its memory. Neither is stored.
 */
const finalizeSchema = v.strictObject({
  attemptId: v.pipe(v.string(), v.regex(/^attempt_[A-Za-z0-9_-]{24}$/u)),
  code: v.pipe(v.string(), v.regex(/^[A-Za-z0-9._~-]{8,4096}$/u)),
  verifier: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{43}$/u)),
});
const finalizeResultSchema = v.strictObject({ started: v.boolean() });
export type GatewayTeardownFinalizeInput = v.InferOutput<typeof finalizeSchema>;
export type GatewayTeardownFinalizeResult = v.InferOutput<typeof finalizeResultSchema>;

/** Internal RPC only. The public router never accepts or forwards a job record. */
export async function handleGatewayTeardownStore(
  request: Request,
  storage: HostedStage1SessionSqlStorage,
  finalize?: (input: GatewayTeardownFinalizeInput) => Promise<GatewayTeardownFinalizeResult>,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.origin !== ORIGIN || url.search || url.hash) return new Response(null, { status: 404 });
  try {
    initializeGatewayTeardownSql(storage);
    const port = new GatewayTeardownDurableStatePort(storage);
    if (url.pathname === '/teardown/read' && request.method === 'GET') return Response.json({ job: await port.read() });
    if (url.pathname === '/teardown/finalize' && request.method === 'POST' && finalize !== undefined) {
      const body = v.parse(finalizeSchema, JSON.parse(await readBoundedText(new Response(request.body), 'bad_request', 16 * 1024)));
      return Response.json(v.parse(finalizeResultSchema, await finalize(body)));
    }
    if (url.pathname !== '/teardown/write' || request.method !== 'POST') return new Response(null, { status: 404 });
    const body = v.parse(writeSchema, JSON.parse(await readBoundedText(new Response(request.body), 'bad_request', 96 * 1024)));
    return Response.json({ written: await port.compareAndSet(body.expectedRevision, parseGatewayTeardownJob(body.job)) });
  } catch { return Response.json({ error: 'teardown_state_invalid' }, { status: 409 }); }
}

export class GatewayTeardownStoreClient implements GatewayTeardownJobPort {
  constructor(private readonly stub: TwoStageDeploySessionStub) {}

  async read(): Promise<GatewayTeardownJob | null> {
    const response = await this.stub.fetch(new Request(`${ORIGIN}/teardown/read`));
    if (!response.ok) throw new Error('teardown_state_unavailable');
    const body = v.parse(v.strictObject({ job: v.nullable(boundaryObjectSchema) }), JSON.parse(await readBoundedText(response, 'internal_error', 96 * 1024)));
    return body.job === null ? null : parseGatewayTeardownJob(body.job);
  }

  async compareAndSet(expectedRevision: number | null, job: GatewayTeardownJob): Promise<boolean> {
    const response = await this.stub.fetch(new Request(`${ORIGIN}/teardown/write`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: canonicalJson({ expectedRevision, job }) }));
    if (!response.ok) throw new Error('teardown_state_conflict');
    return v.parse(v.strictObject({ written: v.boolean() }), JSON.parse(await readBoundedText(response, 'internal_error', 1024))).written;
  }

  /** Hands the consumed callback to the job object, which exchanges it and runs the removal by alarm. */
  async finalize(input: GatewayTeardownFinalizeInput): Promise<GatewayTeardownFinalizeResult> {
    const response = await this.stub.fetch(new Request(`${ORIGIN}/teardown/finalize`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(v.parse(finalizeSchema, input)) }));
    if (!response.ok) throw new Error('teardown_finalize_unavailable');
    return v.parse(finalizeResultSchema, JSON.parse(await readBoundedText(response, 'internal_error', 1024)));
  }
}
