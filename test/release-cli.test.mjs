import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { runRelease } from '../scripts/release.mjs';

test('help and invalid stages never start an operation or echo input', () => {
  let output = '';
  const options = {
    run() { assert.fail('must not spawn'); },
    stdout: { write(value) { output += value; } },
    stderr: { write(value) { output += value; } },
  };
  assert.equal(runRelease([], options), 0);
  assert.equal(runRelease(['unknown-sensitive-input'], options), 2);
  assert.equal(runRelease(['check', '--skip-tests'], options), 2);
  assert.ok(!output.includes('unknown-sensitive-input'));
});

test('signing input is inherited directly and arguments are never shell-evaluated', () => {
  const args = ['--release-dir', '/tmp/a directory; false', '--private-key-stdin'];
  const status = runRelease(['sign', ...args], {
    run(command, forwarded, options) {
      assert.equal(command, process.execPath);
      assert.ok(forwarded[0].endsWith('/sign-gateway-release.mjs'));
      assert.deepEqual(forwarded.slice(1), args);
      assert.deepEqual(options.stdio, ['inherit', 'inherit', 'inherit']);
      assert.equal(options.shell, false);
      return { status: 7 };
    },
  });
  assert.equal(status, 7);
});

test('preparation does not receive stdin and cannot advance to another stage', () => {
  let calls = 0;
  const status = runRelease(['build', '--help'], {
    run(_command, _args, options) {
      calls += 1;
      assert.equal(options.stdio[0], 'ignore');
      return { status: 0 };
    },
  });
  assert.equal(status, 0);
  assert.equal(calls, 1);
});

test('process failure fails the release stage without leaking exception details', () => {
  let output = '';
  assert.equal(runRelease(['build'], {
    run() { return { error: new Error('sensitive subprocess details') }; },
    stderr: { write(value) { output += value; } },
  }), 1);
  assert.ok(!output.includes('sensitive subprocess details'));
});

test('real CLI delegates validation to the signer without exposing piped bytes', () => {
  const result = spawnSync(process.execPath, ['scripts/release.mjs', 'sign'], {
    input: 'synthetic-invalid-signing-input', encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Release signing failed/u);
  assert.ok(!`${result.stdout}${result.stderr}`.includes('synthetic-invalid-signing-input'));
});
