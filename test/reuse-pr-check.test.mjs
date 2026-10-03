import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { reusablePrCheck } from '../scripts/reuse-pr-check.mjs';

const repository = 'example/synthetic-gateway';
const commit = 'a'.repeat(40);
const head = 'b'.repeat(40);
const tree = 'c'.repeat(40);

function evidence() {
  const pr = { number: 12, merged_at: '2026-01-01T00:00:00Z', merge_commit_sha: commit,
    base: { ref: 'main', repo: { full_name: repository } }, head: { sha: head } };
  const run = { id: 34, run_attempt: 2, head_sha: head, event: 'pull_request',
    path: '.github/workflows/ci.yml', repository: { full_name: repository }, status: 'completed', conclusion: 'success' };
  const proof = { schemaVersion: 1, repository, runId: 34, runAttempt: 2, testedCommit: 'd'.repeat(40), tree };
  const data = { pulls: [pr], runs: [run], proof };
  const calls = [];
  return { data, pr, run, proof, calls, check: () => reusablePrCheck({ repository, commit, tree,
    api: async (path) => {
      calls.push(path);
      if (path === `repos/${repository}/commits/${commit}/pulls?per_page=100`) return data.pulls;
      assert.equal(path, `repos/${repository}/actions/workflows/ci.yml/runs?event=pull_request&head_sha=${head}&per_page=100`);
      return { workflow_runs: data.runs };
    },
    readProof: async (runId, attempt) => {
      assert.equal(runId, data.runs[0].id);
      assert.equal(attempt, data.runs[0].run_attempt);
      return data.proof;
    },
  }) };
}

test('a rebased merge reuses CI for the exact tested tree, not the old commit ID', async () => {
  assert.deepEqual(await evidence().check(), { runId: 34, pullRequest: 12, tree });
});

for (const [name, change] of [
  ['different merged files', ({ proof }) => { proof.tree = 'e'.repeat(40); }],
  ['different source repository', ({ proof }) => { proof.repository = 'other/synthetic-gateway'; }],
  ['different run', ({ proof }) => { proof.runId += 1; }],
  ['older run attempt', ({ proof }) => { proof.runAttempt -= 1; }],
  ['missing artifact', ({ data }) => { data.proof = null; }],
  ['invalid tested commit', ({ proof }) => { proof.testedCommit = ''; }],
  ['unmerged PR', ({ pr }) => { pr.merged_at = null; }],
  ['another merge commit', ({ pr }) => { pr.merge_commit_sha = head; }],
  ['another base branch', ({ pr }) => { pr.base.ref = 'other'; }],
  ['another base repository', ({ pr }) => { pr.base.repo.full_name = 'other/synthetic-gateway'; }],
  ['ambiguous merged PR', ({ data, pr }) => { data.pulls.push(structuredClone(pr)); }],
  ['another workflow', ({ run }) => { run.path = '.github/workflows/other.yml'; }],
  ['another run repository', ({ run }) => { run.repository.full_name = 'other/synthetic-gateway'; }],
  ['another PR revision', ({ run }) => { run.head_sha = commit; }],
  ['push result rather than full PR validation', ({ run }) => { run.event = 'push'; }],
  ['incomplete run', ({ run }) => { run.status = 'in_progress'; }],
  ['failed run', ({ run }) => { run.conclusion = 'failure'; }],
]) {
  test(`CI reuse refuses ${name}`, async () => {
    const fixture = evidence(); change(fixture);
    assert.equal(await fixture.check(), null);
  });
}

test('a newer failed run prevents reusing an older green run', async () => {
  const fixture = evidence();
  fixture.data.runs.unshift({ ...fixture.run, id: 35, conclusion: 'failure' });
  assert.equal(await fixture.check(), null);
});

test('PRs always request full validation and record the checkout identity', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ankka-ci-output-'));
  try {
    const output = join(directory, 'outputs');
    execFileSync(process.execPath, ['scripts/reuse-pr-check.mjs'], { env: {
      ...process.env, GITHUB_EVENT_NAME: 'pull_request', GITHUB_REF: 'refs/pull/12/merge', GITHUB_OUTPUT: output,
    } });
    const values = readFileSync(output, 'utf8');
    assert.match(values, /^source-commit=[a-f0-9]{40}\nsource-tree=[a-f0-9]{40}\nreused=false\n$/u);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('the final workflow gate requires fresh history and refuses failed or cancelled jobs', () => {
  const yaml = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const gate = yaml.split('      - name: Every gate passed\n')[1].split('        run: |\n')[1]
    .split('      - name: Record the source')[0].split('\n').map((line) => line.slice(10)).join('\n');
  for (const [reused, install, history, results, accepted] of [
    ['false', 'success', 'success', 'success success success success success', true],
    ['false', 'success', 'success', 'success skipped success success success', false],
    ['true', 'success', 'success', 'success skipped skipped skipped success', true],
    ['true', 'failure', 'success', 'failure skipped skipped skipped success', false],
    ['true', 'success', 'failure', 'success skipped skipped skipped failure', false],
    ['true', 'success', 'skipped', 'success skipped skipped skipped skipped', false],
    ['true', 'success', 'success', 'success failure skipped skipped success', false],
    ['true', 'success', 'success', 'success cancelled skipped skipped success', false],
  ]) {
    const run = () => execFileSync('bash', ['-e', '-c', gate], { stdio: 'pipe', env: {
      ...process.env, REUSED: reused, INSTALL_RESULT: install, HISTORY_RESULT: history, RESULTS: results,
    } });
    if (accepted) assert.doesNotThrow(run);
    else assert.throws(run);
  }
});
