import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/validate-lifecycle.mjs', import.meta.url));
test('lifecycle help distinguishes offline checks from live qualification and rejects live switches', () => {
  for (const args of [['--help'], ['--live']]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    assert.equal(result.status, args[0] === '--help' ? 0 : 2);
    assert.match(result.stdout, /Does not qualify a live gateway/);
    assert.doesNotMatch(result.stdout, /Starting:/);
  }
});

test('a failed stage stops execution and leaves later results explicitly untested', { skip: process.platform === 'win32' }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ankka-offline-lifecycle-'));
  try {
    const executable = path.join(directory, 'npm');
    await writeFile(executable, '#!/bin/sh\nif [ "$2" = "build:admin" ]; then exit 0; fi\nexit 7\n');
    await chmod(executable, 0o700);
    const result = spawnSync(process.execPath, [script], {
      encoding: 'utf8', env: { ...process.env, PATH: directory },
    });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /PASS: Build admin fixture/);
    assert.match(result.stdout, /FAIL: Installation and durable checkpoints/);
    assert.match(result.stdout, /NOT RUN: Removal, interruption and recovery/);
    assert.doesNotMatch(result.stdout, /Starting: Source and Team management/);
    assert.match(result.stdout, /Live gateway lifecycle and browser consent: NOT VALIDATED/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
