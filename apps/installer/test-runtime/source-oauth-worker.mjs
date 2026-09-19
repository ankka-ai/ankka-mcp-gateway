// Local-only harness: production OAuth state and crypto run on SQLite in workerd.
import { DurableObject } from 'cloudflare:workers';
import { AdminState as RuntimeAdminState } from '../../../payload/worker/index.js';
export class SourceOauthState extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.runtime = new RuntimeAdminState(ctx, env); }
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
  fetch(request, env) { return env.ADMIN_STATE.get(env.ADMIN_STATE.idFromName('v1:management')).fetch(request); },
};
