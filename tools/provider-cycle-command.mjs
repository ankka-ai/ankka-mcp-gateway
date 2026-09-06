import { readFile, lstat, realpath, mkdir } from 'node:fs/promises';
import { resolve, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import * as v from 'valibot';

const root = fileURLToPath(new URL('../', import.meta.url));
const text = v.pipe(v.string(), v.minLength(1));
const schema = v.strictObject({ schemaVersion: v.literal(1),
  accountId: v.pipe(text, v.regex(/^[a-f0-9]{32}$/u)), zoneId: v.pipe(text, v.regex(/^[a-f0-9]{32}$/u)),
  zoneName: v.pipe(text, v.regex(/^[a-z0-9.-]+$/u)), adminEmail: v.pipe(text, v.email()),
  manifest: text, runDirectory: text,
});
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') {
  console.log('Usage: npm run test:live -- --config /private/config.json [--cleanup]\nUses ANKKA_LIVE_TOKEN from the process environment. Creates disposable Portal, Access and DNS resources using production payload code, verifies them, and runs production cleanup. No Chrome, OAuth, public worker, or release publication. Keep the private run directory for cleanup recovery.');
} else {
  try {
    if (args[0] !== '--config' || !(args.length === 2 || args.length === 3 && args[2] === '--cleanup')) throw new Error();
    const path = await realpath(args[1]);
    const rel = relative(root, path), stat = await lstat(args[1]);
    if (!rel.startsWith('../') || !stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077) throw new Error();
    const config = v.parse(schema, JSON.parse(await readFile(path, 'utf8')));
    if (!process.env.ANKKA_LIVE_TOKEN) throw new Error();
    const recover = args[2] === '--cleanup';
    const directory = resolve(config.runDirectory);
    if (directory !== config.runDirectory || !relative(root, await realpath(dirname(directory))).startsWith('../')) throw new Error();
    if (!recover) await mkdir(directory, { mode: 0o700 });
    const env = { ...process.env, ANKKA_LIVE_ACCOUNT_ID: config.accountId, ANKKA_LIVE_ZONE_ID: config.zoneId,
      ANKKA_LIVE_ZONE_NAME: config.zoneName, ANKKA_LIVE_ADMIN_EMAIL: config.adminEmail,
      ANKKA_LIVE_MANIFEST: config.manifest, ANKKA_LIVE_RUN_DIR: directory,
      ANKKA_LIVE_PREFIX: `api${Date.now().toString(36)}`, ANKKA_LIVE_RECOVER: recover ? '1' : '0' };
    // The reviewed current payload is fixed; inherited overrides cannot select code.
    delete env.ANKKA_LIVE_PAYLOAD; delete env.ANKKA_LIVE_KEEP;
    const child = spawn(process.execPath, [resolve(root, 'node_modules/vitest/vitest.mjs'), 'run',
      '--config', 'vitest.live.config.ts', 'test-live/provider-cycle.live.ts'], {
      cwd: resolve(root, 'apps/installer'), env, stdio: 'inherit',
    });
    const status = await new Promise((done) => { child.once('error', () => done(1)); child.once('exit', (code) => done(code ?? 1)); });
    process.exitCode = status;
  } catch { console.error('Live test could not start. Check private config, external run directory, manifest and ANKKA_LIVE_TOKEN.'); process.exitCode = 1; }
}
