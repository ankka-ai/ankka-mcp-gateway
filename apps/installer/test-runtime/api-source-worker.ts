import { AdminState as FinalAdminState } from '../src/customer-gateway-entrypoint';
import { initializeCustomerGatewayOwnershipState } from '../src/customer-gateway-ownership-state';
import sourceWorker, { ApiSourceManagement, ApiSource } from '../../api-source-runtime/src/index';

// Synthetic test harness only. Production exports no storage inspection route.
export class ApiSourceFixture extends ApiSource {
  private finalRuntime: FinalAdminState | undefined;
  async gatewayManage(text: string): Promise<Response> {
    if (this.finalRuntime === undefined) {
      const token = 'A'.repeat(43);
      await initializeCustomerGatewayOwnershipState({ storage: this.ctx.storage, wrappingKey: token });
      this.finalRuntime = new FinalAdminState(this.ctx, {
        ADMIN_STATE: this.env.SOURCE, API_LOADER: this.env.LOADER,
        ADMIN_EMAILS: 'admin@example.com', ANKKA_INSTALL_ID: `acg-${'b'.repeat(24)}`,
        ANKKA_GATEWAY_RELEASE: 'gateway-v1.0.0', ANKKA_GATEWAY_RELEASE_SHA256: `sha256:${'f'.repeat(64)}`,
        ANKKA_MANAGEMENT_HOSTNAME: 'manage.example.com', ANKKA_UPDATE_CHANNEL: 'canary', ANKKA_UPDATE_KEY_ID: 'synthetic',
        ANKKA_UPDATE_PUBLIC_KEY: token, ANKKA_WORKERS_SUBDOMAIN: 'customer', ANKKA_WORKER_NAME: 'ankka-gateway',
        CF_ACCESS_AUD: 'c'.repeat(64), CF_ACCESS_ISSUER: 'https://team.cloudflareaccess.com', CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
        CLOUDFLARE_ZONE_ID: 'd'.repeat(32), CLOUDFLARE_ZONE_NAME: 'example.com', ZERO_TRUST_READY: 'true',
        ANKKA_GATEWAY_OWNERSHIP_WRAP_KEY: token,
        ANKKA_API_CONNECTIONS: JSON.stringify({ inventory: { connection: JSON.parse(this.env.CONNECTION_JSON), credential: this.env.PROVIDER_TOKEN },
          billing: { connection: JSON.parse(this.env.CONNECTION_JSON), credential: this.env.PROVIDER_TOKEN } }),
      });
    }
    return this.finalRuntime.fetch(new Request('https://admin-state.invalid/api-source-runtime/manage', { method: 'POST', body: text }));
  }
  async inspect(): Promise<string> { return JSON.stringify(Object.fromEntries(await this.ctx.storage.list())); }
}
interface FixtureEnv extends Env { FIXTURE: DurableObjectNamespace<ApiSourceFixture> }
export default {
  async fetch(request, env, ctx): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === '/gateway/manage') return env.FIXTURE.get(env.FIXTURE.idFromName('source')).gatewayManage(await request.text());
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
