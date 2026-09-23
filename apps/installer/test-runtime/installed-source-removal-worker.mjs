// Local-only fixture: the production removal journal and root receipt live in
// separate SQLite objects, as they do in the deployed gateway.
import { DurableObject } from 'cloudflare:workers';
import { AdminState } from '../../../payload/worker/index.js';

export class RemovalState extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    const runtimeEnv = { ...env };
    if (env.FIXTURE_DASHBOARD_TARGET) runtimeEnv.DASHBOARD_ACCESS_TARGET = async () => JSON.parse(env.FIXTURE_DASHBOARD_TARGET);
    this.runtime = new AdminState(ctx, runtimeEnv);
  }
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/fixture/seed') {
      await this.ctx.storage.put(await request.json());
      return Response.json({ seeded: true });
    }
    if (path === '/fixture/state') return Response.json(Object.fromEntries(await this.ctx.storage.list()));
    return this.runtime.fetch(request);
  }
}

export default {
  fetch(request, env) {
    const name = request.headers.get('x-fixture-root') === 'true' ? `v1:${env.ANKKA_INSTALL_ID}` : 'v1:management';
    return env.ADMIN_STATE.get(env.ADMIN_STATE.idFromName(name)).fetch(request);
  },
};
