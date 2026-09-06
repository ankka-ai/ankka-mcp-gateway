import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Bundles production state/crypto code; SQLite and Web Crypto execute in workerd.
export async function createRuntime({ storage = false, diagnostics = false } = {}) {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL('./bootstrap-worker.ts', import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022',
    external: ['cloudflare:workers'],
  });
  const registry = await mkdtemp(join(tmpdir(), 'ankka-runtime-registry-'));
  let blockedRequests = 0;
  const options = {
    host: '127.0.0.1', port: 0,
    cf: false,
    unsafeLocalExplorer: diagnostics,
    unsafeObservability: diagnostics,
    unsafeDevRegistryPath: registry,
    workers: [{
      config: {
        type: 'worker', name: 'ankka-synthetic-bootstrap', compatibilityDate: '2026-08-14',
        manifest: {
          mainModule: 'fixture.mjs',
          modules: { 'fixture.mjs': { type: 'esm', contents: bundle.outputFiles[0].text } },
        },
        env: { STATE: { type: 'durable-object', workerName: 'ankka-synthetic-bootstrap', exportName: 'BootstrapFixture' } },
        exports: { BootstrapFixture: { type: 'durable-object', storage: 'sqlite' } },
      },
      dev: {
        // No credentials, remote bindings, .dev.vars, or real provider requests.
        outboundService: { type: 'fetcher', handler: () => {
          blockedRequests++;
          return Response.json({ code: 'outbound_disabled' }, { status: 502 });
        } },
      },
    }],
  };
  if (storage) options.resourcePersistencePath = storage;
  const runtime = new Miniflare(options);
  async function dispose() {
    try { await runtime.dispose(); }
    finally { await rm(registry, { recursive: true, force: true }); }
  }
  try {
    await runtime.ready;
    return { runtime, dispose, blockedRequests: () => blockedRequests };
  } catch (error) {
    await dispose();
    throw error;
  }
}
