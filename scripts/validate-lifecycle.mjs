import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Fixed offline suites only: never select a live harness from environment input.
const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (args.length > 0) {
  const help = args.length === 1 && args[0] === '--help';
  console.log('Usage: npm run validate:lifecycle\nRuns offline installation, management, signed-update and recovery regressions.\nUses synthetic provider fixtures. Does not qualify a live gateway or browser consent.');
  process.exit(help ? 0 : 2);
}
const installer = (...files) => ['run', 'test', '--workspace', '@ankka/gateway-installer', '--', ...files];
const stages = [
  ['Build admin fixture', ['run', 'build:admin']],
  ['Installation and durable checkpoints', installer('test/customer-stage2-converger.test.ts', 'test/customer-stage2-journal.test.ts')],
  ['Source and Team management', null],
  ['Signed releases and runtime update', installer('test/offline-two-release-origin-lifecycle.test.mjs', 'test/customer-runtime-update.test.ts')],
  ['Removal, interruption and recovery', installer('test/customer-teardown-router.test.ts', 'test/customer-bigquery-teardown-runtime.test.mjs', 'test/gateway-teardown-provider.test.ts', 'test/gateway-teardown-job.test.ts', 'test/gateway-teardown-router.test.ts')],
];
console.log('OFFLINE lifecycle validation — synthetic providers; no deployment or live qualification.');
const results = [];
for (const [name, command] of stages) {
  console.log(`\nStarting: ${name}`);
  const result = command === null
    ? spawnSync(process.execPath, ['--test', 'test/worker-team-access.test.mjs'], { cwd: root, stdio: 'inherit' })
    : spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', command, { cwd: root, stdio: 'inherit' });
  const passed = result.status === 0 && !result.error;
  results.push({ name, passed });
  if (!passed) break;
}
console.log('\nOffline lifecycle results:');
for (const [name] of stages) {
  const result = results.find((entry) => entry.name === name);
  console.log(`${result === undefined ? 'NOT RUN' : result.passed ? 'PASS' : 'FAIL'}: ${name}`);
}
console.log('Live gateway lifecycle and browser consent: NOT VALIDATED by this command.');
process.exitCode = results.length === stages.length && results.every((entry) => entry.passed) ? 0 : 1;
