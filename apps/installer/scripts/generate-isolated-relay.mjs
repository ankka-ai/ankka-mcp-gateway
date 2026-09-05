import { build } from 'esbuild';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compileRelayOrigin, compiledRelayOrigin } from './compiled-relay-origin.mjs';
import { parseIsolatedCanaryTarget, readIsolatedCanaryTargetFile } from './isolated-canary-target.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));

export async function isolatedRelayArtifacts(target) {
  target = parseIsolatedCanaryTarget(target);
  const installerOrigin = `https://${target.hostname}`;
  const relayOrigin = compiledRelayOrigin(installerOrigin);
  if (relayOrigin === 'https://auth.ankka.ai') throw new Error('isolated_relay_required');
  const entry = path.join(root, 'apps/installer/src/auth-entrypoint.ts');
  const relay = path.join(root, 'apps/installer/src/cloudflare-code-relay.ts');
  const built = await build({
    entryPoints: [entry], bundle: true, format: 'esm', platform: 'browser', target: 'es2022',
    write: false, sourcemap: false, legalComments: 'none', logLevel: 'silent',
    plugins: [{ name: 'isolated-relay-origin', setup(builder) {
      builder.onLoad({ filter: /cloudflare-code-relay\.ts$/ }, async (args) => {
        if (path.resolve(args.path) !== relay) throw new Error('relay_source_invalid');
        return { contents: compileRelayOrigin(await readFile(relay, 'utf8'), installerOrigin), loader: 'ts' };
      });
    } }],
  });
  if (built.outputFiles.length !== 1) throw new Error('relay_build_invalid');
  const name = target.workerName.replace('ankka-gateway-deploy-isolated-', 'ankka-auth-isolated-');
  const template = await readFile(path.join(root, 'apps/installer/wrangler.auth.toml'), 'utf8');
  const config = template.replace('name = "ankka-cloudflare-auth"', `name = ${JSON.stringify(name)}\naccount_id = ${JSON.stringify(target.accountId)}`)
    .replace('main = "src/auth-entrypoint.ts"', 'main = "relay.mjs"\nno_bundle = true\nsend_metrics = false')
    .replace('pattern = "auth.ankka.ai"', `pattern = ${JSON.stringify(new URL(relayOrigin).hostname)}`);
  return { source: built.outputFiles[0].text, config, relayOrigin, workerName: name };
}

async function main(args) {
  if (args.length === 1 && args[0] === '--help') {
    console.log('Usage: node apps/installer/scripts/generate-isolated-relay.mjs --target <external-target.json> --out <new-external-directory>\nGenerates an isolated OAuth relay. Does not deploy or provision secrets.');
    return;
  }
  if (args.length !== 4 || args[0] !== '--target' || args[2] !== '--out') throw new Error('arguments_invalid');
  const target = await readIsolatedCanaryTargetFile(args[1]);
  const output = path.resolve(args[3]);
  const parent = await realpath(path.dirname(output));
  const relative = path.relative(root, path.join(parent, path.basename(output)));
  if (relative === '' || (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) throw new Error('external_output_required');
  const files = await isolatedRelayArtifacts(target);
  await mkdir(output, { mode: 0o700 });
  await writeFile(path.join(output, 'relay.mjs'), files.source, { flag: 'wx', mode: 0o600 });
  await writeFile(path.join(output, 'wrangler.toml'), files.config, { flag: 'wx', mode: 0o600 });
  console.log('Isolated relay artifacts prepared. No live operation performed.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(() => { console.error('Isolated relay preparation failed.'); process.exitCode = 1; });
}
