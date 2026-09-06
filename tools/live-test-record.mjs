import { open, readFile, rename, lstat, realpath, unlink } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
export async function privateRunDirectory(directory) {
  const canonical = await realpath(directory);
  const stat = await lstat(directory);
  const rel = relative(root, canonical);
  if (!isAbsolute(directory) || !stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077 ||
      !(rel === '..' || rel.startsWith('../'))) throw new Error('private_run_directory_required');
  return canonical;
}

/** Only stage names and bounded numerical diagnostics belong in console output.
 * Exact receipts and resource identities remain in the private recovery record.
 */
export async function openLiveTestRecord(directory, { recover = false } = {}) {
  directory = await privateRunDirectory(directory);
  const lock = await open(join(directory, 'run.lock'), 'wx', 0o600);
  const path = join(directory, 'record.json');
  let state;
  try {
    if (recover) {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077 || stat.size > 16 * 1024 * 1024) throw new Error('private_record_required');
      state = JSON.parse(await readFile(path, 'utf8'));
      if (state.schemaVersion !== 1 || state.scope !== 'provider_api') throw new Error('record_invalid');
    } else {
      const file = await open(path, 'wx', 0o600);
      await file.close();
      state = { schemaVersion: 1, scope: 'provider_api', qualified: false, events: [], storage: {}, recovery: null };
    }
  } catch (error) { await lock.close(); await unlink(join(directory, 'run.lock')); throw error; }
  async function save() {
    const pending = join(directory, `${randomUUID()}.tmp`);
    const file = await open(pending, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(state)); await file.sync(); } finally { await file.close(); }
    await rename(pending, path);
    const parent = await open(directory, 'r');
    try { await parent.sync(); } finally { await parent.close(); }
  }
  await save();
  return {
    state,
    async put(key, value) { state.storage[key] = structuredClone(value); await save(); },
    async recovery(value) { state.recovery = value; await save(); },
    async event(stage, status) { state.events.push({ stage, status, at: new Date().toISOString() }); await save(); },
    async close() { await lock.close(); await unlink(join(directory, 'run.lock')); },
  };
}

export function providerDiagnostic(request, status, elapsed) {
  const url = new URL(request.url);
  // Resource paths and query parameters may contain account IDs or emails.
  const family = url.hostname !== 'api.cloudflare.com' ? 'external' :
    url.pathname.includes('/dns_records') ? 'dns' : url.pathname.includes('/access/') ? 'access' :
    url.pathname.includes('/workers/') ? 'workers' : 'cloudflare';
  return { method: request.method, family, status, ms: Math.max(0, Math.round(elapsed)) };
}
