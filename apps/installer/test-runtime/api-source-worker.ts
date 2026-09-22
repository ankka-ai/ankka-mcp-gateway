import sourceWorker, { ApiSourceManagement } from '../../api-source-runtime/src/index';
import { ApiSource } from '../../api-source-runtime/src/state';

// Synthetic test harness only. Production exports no storage inspection route.
export class ApiSourceFixture extends ApiSource {
  async inspect(): Promise<string> { return JSON.stringify(Object.fromEntries(await this.ctx.storage.list())); }
}
interface FixtureEnv extends Env { FIXTURE: DurableObjectNamespace<ApiSourceFixture> }
export default {
  async fetch(request, env, ctx): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === '/manage') return new ApiSourceManagement(ctx, env).fetch(request);
    if (path === '/state') return new Response(await env.FIXTURE.get(env.FIXTURE.idFromName('source')).inspect());
    if (path === '/call') {
      const input = await request.json<{ name: string; input: string }>();
      return new Response(await env.SOURCE.get(env.SOURCE.idFromName('source')).call(input.name, input.input));
    }
    if (path === '/catalogue') return new Response(await env.SOURCE.get(env.SOURCE.idFromName('source')).catalogue());
    // Exercise the production origin/auth/route boundary without adding a bypass there.
    return sourceWorker.fetch(new Request(`https://api-source.example.com${path}`, request), env);
  },
} satisfies ExportedHandler<FixtureEnv>;
