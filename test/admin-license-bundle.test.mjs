import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

test('license generation tolerates missing dev flags only for reviewed build binaries', async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'ankka-license-fixture-'));
  const entry = { version: '1.0.0', resolved: 'https://registry.npmjs.org/synthetic-package/-/synthetic-package-1.0.0.tgz', integrity: 'sha512-synthetic', license: 'MIT' };
  const optional = { ...entry, optional: true, os: ['linux'] };
  const packages = {
    'node_modules/synthetic-runtime': entry,
    'node_modules/@typescript/typescript-linux-x64': optional,
    'node_modules/lightningcss-linux-x64-gnu': optional,
    'node_modules/vite/node_modules/lightningcss-linux-arm64-gnu': optional,
    'node_modules/fsevents': { ...optional, os: ['darwin'] },
  };
  const lock = path.join(fixture, 'package-lock.json');
  const run = () => spawnSync(process.execPath, ['scripts/write-admin-license-bundle.mjs'], { cwd: fixture, encoding: 'utf8' });
  const saveLock = () => writeFile(lock, JSON.stringify({ lockfileVersion: 3, packages }));
  try {
    await mkdir(path.join(fixture, 'scripts'));
    await mkdir(path.join(fixture, 'apps/admin/dist'), { recursive: true });
    await mkdir(path.join(fixture, 'node_modules/synthetic-runtime'), { recursive: true });
    await symlink(path.join(root, 'node_modules/valibot'), path.join(fixture, 'node_modules/valibot'), 'dir');
    await copyFile(path.join(root, 'scripts/write-admin-license-bundle.mjs'), path.join(fixture, 'scripts/write-admin-license-bundle.mjs'));
    await writeFile(path.join(fixture, 'LICENSE'), 'Synthetic project license fixture.\n');
    await writeFile(path.join(fixture, 'node_modules/synthetic-runtime/package.json'), JSON.stringify({ name: 'synthetic-runtime', version: '1.0.0' }));
    await writeFile(path.join(fixture, 'node_modules/synthetic-runtime/LICENSE'), 'Synthetic runtime license fixture.\n');
    await saveLock();
    const success = run();
    assert.equal(success.status, 0, success.stderr);
    const bundle = await readFile(path.join(fixture, 'apps/admin/dist/THIRD_PARTY_LICENSES.txt'), 'utf8');
    assert.match(bundle, /Package: synthetic-runtime@1\.0\.0/u);
    assert.match(bundle, /Synthetic runtime license fixture/u);

    packages['node_modules/synthetic-native-runtime'] = optional;
    await saveLock();
    const missingRuntime = run();
    assert.notEqual(missingRuntime.status, 0);
    assert.match(missingRuntime.stderr, /license_bundle_package_invalid/u);
    delete packages['node_modules/synthetic-native-runtime'];

    packages['node_modules/fsevents'] = { ...entry, os: ['darwin'] };
    await saveLock();
    const requiredPackage = run();
    assert.notEqual(requiredPackage.status, 0);
    assert.match(requiredPackage.stderr, /license_bundle_package_invalid/u);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
