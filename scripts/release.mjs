import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const installer = 'apps/installer/scripts/';
const stages = new Map([
  ['build', `${installer}build-gateway-release-candidate.mjs`],
  ['sign', `${installer}sign-gateway-release.mjs`],
  ['sbom', 'scripts/generate-release-sbom.mjs'],
  ['publisher', `${installer}generate-r2-publication-worker.mjs`],
  ['installer', `${installer}generate-reviewed-canary.mjs`],
  ['mirror', `${installer}publish-github-release.mjs`],
  ['canary', 'src/canary-lifecycle-cli.ts'],
]);

const help = `Usage: npm run release -- <stage> [stage options]

  check           Full offline release gate (same as npm run check)
  build           Build an exact candidate from a clean public commit
  sign            Sign that candidate; raw seed goes directly to signer stdin
  sbom            Generate the source-bound SBOM
  publisher       Prepare the create-only R2 publisher
  installer       Prepare or validate the pinned installer
  mirror          Prepare, validate, or explicitly publish the GitHub mirror
  lifecycle-test  Run the offline two-release lifecycle regression
  canary          Preview/run the receipt-bound Portal canary

Use <stage> --help for its existing options. SBOM options:
  --source <checkout> --source-commit <commit> --release <gateway-vX.Y.Z> --out <file>

Stages consume the existing artifacts; continue at the next stage after success.
No stage automatically signs, publishes, deploys, or advances another stage.
The Portal canary does not qualify signed gateway updates or OAuth handover.
See docs/OPERATIONS.md for the release sequence and live qualification.
`;

export function runRelease(argv, { run = spawnSync, stdout = process.stdout, stderr = process.stderr } = {}) {
  const [stage, ...args] = argv;
  if (!stage || (argv.length === 1 && stage === '--help')) {
    stdout.write(help);
    return 0;
  }
  if (stage === 'sbom' && args.length === 1 && args[0] === '--help') {
    stdout.write(help);
    return 0;
  }
  let command = process.execPath;
  let commandArgs;
  if (stage === 'check' || stage === 'lifecycle-test') {
    if (args.length === 1 && args[0] === '--help') {
      stdout.write(help);
      return 0;
    }
    if (args.length !== 0) {
      stderr.write('This stage accepts no options.\n');
      return 2;
    }
    command = 'npm';
    commandArgs = stage === 'check' ? ['run', 'check'] : [
      'run', 'test', '--workspace', '@ankka/gateway-installer', '--',
      'test/offline-two-release-origin-lifecycle.test.mjs',
    ];
  } else if (stages.has(stage)) {
    commandArgs = [path.join(root, stages.get(stage)), ...args];
  } else {
    stderr.write('Unknown release stage. Use npm run release -- --help.\n');
    return 2;
  }
  // Do not buffer, inspect, or forward signing input to any other stage.
  const result = run(command, commandArgs, {
    cwd: root,
    stdio: [stage === 'sign' || stage === 'canary' ? 'inherit' : 'ignore', 'inherit', 'inherit'],
    shell: false,
  });
  if (result.error || result.signal) {
    stderr.write('Release stage did not complete. Check its artifacts before retrying.\n');
    return 1;
  }
  return result.status ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = runRelease(process.argv.slice(2));
}
