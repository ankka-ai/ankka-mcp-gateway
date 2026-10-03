import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sha = /^[a-f0-9]{40}$/u;
const repositoryName = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;

/** Reuse only a completed CI run for the PR that produced this exact main commit. */
export async function reusablePrCheck({ repository, commit, tree, api, readProof }) {
  if (!repositoryName.test(repository) || !sha.test(commit) || !sha.test(tree)) return null;
  const root = `repos/${repository}`;
  const pulls = await api(`${root}/commits/${commit}/pulls?per_page=100`);
  const merged = pulls.filter((pr) => pr.merged_at && pr.merge_commit_sha === commit &&
    pr.base?.ref === 'main' && pr.base.repo?.full_name === repository);
  if (merged.length !== 1 || !sha.test(merged[0].head?.sha ?? '')) return null;
  const head = merged[0].head.sha;
  const { workflow_runs: runs } = await api(`${root}/actions/workflows/ci.yml/runs?event=pull_request&head_sha=${head}&per_page=100`);
  const run = runs.filter((item) => item.head_sha === head && item.event === 'pull_request' &&
    item.path === '.github/workflows/ci.yml' && item.repository?.full_name === repository)
    .sort((a, b) => b.id - a.id)[0];
  // A newer failed or pending attempt must never fall back to an older success.
  if (!run || run.status !== 'completed' || run.conclusion !== 'success' ||
    !Number.isSafeInteger(run.id) || !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1) return null;
  const proof = await readProof(run.id, run.run_attempt);
  if (proof?.schemaVersion !== 1 || proof.repository !== repository || proof.runId !== run.id ||
    proof.runAttempt !== run.run_attempt || !sha.test(proof.testedCommit ?? '') || proof.tree !== tree) return null;
  return { runId: run.id, pullRequest: merged[0].number, tree };
}

function gh(...args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });
}

function readProof(repository, runId, attempt) {
  const directory = mkdtempSync(join(tmpdir(), 'ankka-ci-proof-'));
  try {
    gh('run', 'download', String(runId), '--repo', repository, '--name', `checked-source-${attempt}`, '--dir', directory);
    const text = readFileSync(join(directory, 'checked-source.json'), 'utf8');
    if (text.length > 4096) return null;
    return JSON.parse(text);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function main() {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const tree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim();
  if (!sha.test(commit) || !sha.test(tree)) throw new Error('invalid_checkout_identity');
  let reused = null;
  if (process.env.GITHUB_EVENT_NAME === 'push' && process.env.GITHUB_REF === 'refs/heads/main') {
    try {
      const repository = process.env.GITHUB_REPOSITORY;
      reused = await reusablePrCheck({ repository, commit, tree,
        api: async (path) => JSON.parse(gh('api', path)),
        readProof: async (runId, attempt) => readProof(repository, runId, attempt),
      });
    } catch {
      // Missing/expired evidence, provider failures and older workflows all run the full gate.
      reused = null;
    }
  }
  appendFileSync(process.env.GITHUB_OUTPUT,
    `source-commit=${commit}\nsource-tree=${tree}\nreused=${reused !== null}\n`);
  console.log(reused
    ? `Reusing full PR #${reused.pullRequest} validation from run ${reused.runId}: exact source tree ${tree}.`
    : 'Running the full CI gate.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
