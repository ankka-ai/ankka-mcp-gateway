// Local-only bindings around the actual production bootstrap entrypoint and DO.
import { DurableObject } from 'cloudflare:workers';
import worker, { AdminState as ProductionAdminState } from '../src/customer-gateway-bootstrap-entrypoint';
import { PUBLIC_ORIGIN } from '../src/constants';
export class AdminState extends ProductionAdminState {
  constructor(ctx: DurableObjectState, env: Env) { super(ctx, configuration(env)); }
}
interface Env { ADMIN_STATE: DurableObjectNamespace; FAULT_STATE: DurableObjectNamespace }
export class FaultState extends DurableObject {
  override async fetch(): Promise<Response> {
    await Promise.resolve();
    throw new Error('synthetic configuration failure');
  }
}
const token = 'A'.repeat(43);
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    const fault = path === '/fixture/rejected-configuration';
    const forwarded = new Request('https://bootstrap.example.com' + (fault ? '/__ankka/install/configuration' : path), request);
    return worker.fetch(forwarded, configuration({ ...env, ADMIN_STATE: fault ? env.FAULT_STATE : env.ADMIN_STATE }));
  },
} satisfies ExportedHandler<Env>;

function configuration(env: Env) {
  return {
      ADMIN_STATE: env.ADMIN_STATE,
      CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), ANKKA_INSTALL_ID: 'acg-' + 'b'.repeat(24),
      ANKKA_WORKER_NAME: 'synthetic-bootstrap', ANKKA_GATEWAY_RELEASE: 'gateway-v0.0.1',
      ANKKA_GATEWAY_RELEASE_SHA256: 'sha256:' + 'c'.repeat(64),
      ANKKA_PLAN_ID: 'plan-' + 'd'.repeat(24), ANKKA_PLAN_HASH: 'sha256:' + 'e'.repeat(64),
      ANKKA_BOOTSTRAP_ID: 'boot_' + 'f'.repeat(24), ANKKA_BOOTSTRAP_SECRET_SHA256: 'sha256:' + '1'.repeat(64),
      ANKKA_BOOTSTRAP_EXPIRES_AT: '1900000000000',
      ANKKA_BOOTSTRAP_CALLBACK: 'https://bootstrap.example.com/__ankka/install/oauth/callback',
      ANKKA_INSTALLER_ORIGIN: PUBLIC_ORIGIN, ANKKA_MANAGEMENT_HOSTNAME: 'manage.example.com',
      ANKKA_UPDATE_CHANNEL: 'canary', ANKKA_UPDATE_KEY_ID: 'synthetic', ANKKA_UPDATE_PUBLIC_KEY: token,
      CLOUDFLARE_CUSTOMER_OAUTH_CLIENT_ID: 'g'.repeat(32), CLOUDFLARE_OWNERSHIP_ISSUER_PUBLIC_KEY: token,
      CLOUDFLARE_OWNERSHIP_ISSUER_KEY_ID: 'synthetic', ANKKA_GATEWAY_OWNERSHIP_WRAP_KEY: token,
      ANKKA_BOOTSTRAP_NONCE: token,
  } satisfies Parameters<typeof worker.fetch>[1];
}
