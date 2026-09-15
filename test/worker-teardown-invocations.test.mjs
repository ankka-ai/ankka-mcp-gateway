import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

test('the teardown command re-enters the same Durable Object without holding its mutation queue', async () => {
  const built = await build({ stdin: { resolveDir: process.cwd(), loader: 'ts', contents: `
    import { customerTeardownCommand } from './apps/installer/src/customer-teardown-command.ts';
    export class Probe {
      constructor(state, env) { this.state = state; this.env = env; this.queue = Promise.resolve(); }
      async fetch(request) {
        if (new URL(request.url).pathname === '/callback') {
          const command = customerTeardownCommand(this.env.ADMIN_STATE);
          for (let pass = 0; pass < 3; pass++) {
            const response = await command('apply', 'synthetic-body', 'synthetic-signature');
            if (response.status !== 200) throw new Error('pass failed');
            await response.body.cancel();
          }
          return Response.json({ passes: await this.state.storage.get('passes') });
        }
        const run = async () => {
          if (new URL(request.url).pathname !== '/teardown-actions/apply-current' ||
              request.headers.get('x-ankka-teardown-action-signature') !== 'synthetic-signature' ||
              await request.text() !== 'synthetic-body') throw new Error('wrong command');
          for (let read = 0; read < 25; read++) {
            const response = await fetch('https://provider.invalid/read');
            await response.body.cancel();
          }
          await this.state.storage.put('passes', (await this.state.storage.get('passes') ?? 0) + 1);
          return Response.json({ status: 'removing' });
        };
        const result = this.queue.then(run); this.queue = result.then(() => undefined, () => undefined); return result;
      }
    }
    export default { fetch(request, env) {
      return env.ADMIN_STATE.get(env.ADMIN_STATE.idFromName('v1:management')).fetch(request);
    } };
  ` }, bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false, logLevel: 'silent' });
  let providerCalls = 0;
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: built.outputFiles[0].text, compatibilityDate: '2026-09-01',
    durableObjects: { ADMIN_STATE: { className: 'Probe', useSQLite: true } },
    outboundService: () => { providerCalls++; return new Response('{}'); },
  }));
  try {
    const response = await mf.dispatchFetch('https://gateway.invalid/callback');
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(await response.json(), { passes: 3 });
    assert.equal(providerCalls, 75);
  } finally { await mf.dispose(); }
});

test('an alarm re-enters the same Durable Object through its namespace, one signed pass per alarm, and re-arms itself', async () => {
  // The removal driver runs behind the consent page this way: each alarm is its own invocation, the apply pass is a
  // self-stub call with its own budget, and the next alarm is armed before the pass ends.
  const built = await build({ stdin: { resolveDir: process.cwd(), loader: 'ts', contents: `
    import { customerTeardownCommand } from './apps/installer/src/customer-teardown-command.ts';
    export class Probe {
      constructor(state, env) { this.state = state; this.env = env; this.queue = Promise.resolve(); }
      async alarm() {
        const command = customerTeardownCommand(this.env.ADMIN_STATE);
        const response = await command('apply', 'synthetic-body', 'synthetic-signature');
        if (response.status !== 200) throw new Error('pass failed');
        await response.body.cancel();
        const passes = await this.state.storage.get('passes');
        if (passes < 3) await this.state.storage.setAlarm(Date.now());
      }
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === '/arm') { await this.state.storage.setAlarm(Date.now()); return Response.json({ armed: true }); }
        if (path === '/passes') return Response.json({ passes: await this.state.storage.get('passes') ?? 0 });
        const run = async () => {
          if (path !== '/teardown-actions/apply-current' ||
              request.headers.get('x-ankka-teardown-action-signature') !== 'synthetic-signature' ||
              await request.text() !== 'synthetic-body') throw new Error('wrong command');
          for (let read = 0; read < 25; read++) {
            const response = await fetch('https://provider.invalid/read');
            await response.body.cancel();
          }
          await this.state.storage.put('passes', (await this.state.storage.get('passes') ?? 0) + 1);
          return Response.json({ status: 'removing' });
        };
        const result = this.queue.then(run); this.queue = result.then(() => undefined, () => undefined); return result;
      }
    }
    export default { fetch(request, env) {
      return env.ADMIN_STATE.get(env.ADMIN_STATE.idFromName('v1:management')).fetch(request);
    } };
  ` }, bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false, logLevel: 'silent' });
  let providerCalls = 0;
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: built.outputFiles[0].text, compatibilityDate: '2026-09-01',
    durableObjects: { ADMIN_STATE: { className: 'Probe', useSQLite: true } },
    outboundService: () => { providerCalls++; return new Response('{}'); },
  }));
  try {
    const armed = await mf.dispatchFetch('https://gateway.invalid/arm');
    assert.equal(armed.status, 200, await armed.clone().text());
    let passes = 0;
    for (let waited = 0; passes < 3 && waited < 200; waited += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const response = await mf.dispatchFetch('https://gateway.invalid/passes');
      ({ passes } = await response.json());
    }
    assert.equal(passes, 3);
    assert.equal(providerCalls, 75);
  } finally { await mf.dispose(); }
});
