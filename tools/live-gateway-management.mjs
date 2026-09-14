import * as v from 'valibot';

const ACTION_ID = /^action_[A-Za-z0-9_-]{32}$/u;
const SOURCE_ID = /^[a-z][a-z0-9-]{0,31}$/u;
const SYNTHETIC_EMAIL = 'qualification@example.com';
/** The gateway's consent window plus its clock-skew allowance. */
const MAX_CONSENT_WINDOW_MS = 11 * 60 * 1000;

export class LiveManagementQualificationError extends Error {
  constructor(code) { super(code); this.code = code; }
}

function requireCondition(value, code) {
  if (!value) throw new LiveManagementQualificationError(code);
}

function verifiedTeam(team) {
  requireCondition(team?.schemaVersion === 1 && team.editingEnabled === true &&
    team.managementCredentialConfigured === true && Number.isSafeInteger(team.revision) &&
    v.is(v.string(), team.observedAt) && Number.isFinite(Date.parse(team.observedAt)) &&
    Array.isArray(team.members), 'team_readback_unverified');
  return team;
}

function administratorsOnly(team, members) {
  return members.every((member) => team.adminEmails?.includes(member.email) && member.email !== SYNTHETIC_EMAIL &&
    Array.isArray(member.sourceIds) && member.sourceIds.length === 0);
}

function membership(value) {
  return JSON.stringify(value.map((member) => [member.email, [...member.sourceIds].sort()])
    .sort(([left], [right]) => left.localeCompare(right)));
}

/** The gateway's own action journal for one source: the action blocking it, if any, and its completed action. */
async function sourceActionJournal(request, sourceId) {
  const snapshot = await request('/api/source-actions');
  requireCondition(snapshot?.schemaVersion === 1 && Array.isArray(snapshot.actions), 'source_action_unverified');
  const pointer = snapshot.blockingAction ?? null;
  requireCondition(pointer === null || (pointer.kind === 'source' && pointer.sourceId === sourceId), 'lifecycle_pending');
  const pending = pointer === null ? null : snapshot.actions.find((action) => action.actionId === pointer.actionId) ?? null;
  requireCondition(pointer === null || (ACTION_ID.test(pending?.actionId) && pending.sourceId === sourceId &&
    Number.isFinite(Date.parse(pending.expiresAt))), 'source_action_unverified');
  const succeeded = snapshot.actions.find((action) => action.sourceId === sourceId && action.status === 'succeeded') ?? null;
  return { pending, succeeded };
}

/**
 * One source apply. A fresh draft is prepared and applied. A draft whose
 * action stopped mid-way is renewed through the gateway's renewal route, which
 * re-enters the same journal: nothing is re-prepared and no provider write is
 * repeated blindly. The gateway rotates the action key only after the stopped
 * action's consent window has elapsed, so `wait` sleeps until then.
 */
async function applySource({ request, checkpoint, wait, draft, revision }) {
  const journal = await sourceActionJournal(request, draft.id);
  if (draft.status === 'installed') {
    requireCondition(journal.pending === null && ACTION_ID.test(journal.succeeded?.actionId), 'source_action_unverified');
    await checkpoint({ stage: 'source_apply', status: 'recovered', sourceId: draft.id, actionId: journal.succeeded.actionId });
    return { actionId: journal.succeeded.actionId, status: 'succeeded' };
  }
  const body = { schemaVersion: 1, revision, sourceId: draft.id };
  if (journal.pending === null) return request('/api/source-actions', { method: 'POST', body });
  let { pending } = journal;
  if (pending.canRenew !== true) {
    const remaining = Date.parse(pending.expiresAt) - Date.now();
    requireCondition(wait !== null && remaining > 0 && remaining <= MAX_CONSENT_WINDOW_MS, 'source_action_recovery_required');
    await checkpoint({ stage: 'source_apply', status: 'waiting', sourceId: draft.id, actionId: pending.actionId });
    await wait(remaining + 1000);
    pending = (await sourceActionJournal(request, draft.id)).pending;
    requireCondition(pending?.actionId === journal.pending.actionId && pending.canRenew === true, 'source_action_recovery_required');
  }
  await checkpoint({ stage: 'source_apply', status: 'renewed', sourceId: draft.id, actionId: pending.actionId });
  return request(`/api/source-actions/${pending.actionId}/renew`, { method: 'POST', body });
}

/** Fixed synthetic source and membership exercise through the real management API.
 * A lost or rejected mutation stops the sequence; its journal is never replaced.
 * Re-entering after an interruption continues from the gateway's own journal:
 * the existing draft is reused, a stopped action is renewed, and a membership
 * already in place is not written again.
 */
export async function qualifyLiveGatewayManagement({ request, source, checkpoint, wait = null }) {
  const sourceUrl = new URL(source.url);
  requireCondition(sourceUrl.protocol === 'https:' && !sourceUrl.username && !sourceUrl.password &&
    !sourceUrl.hash && !sourceUrl.search && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(source.tool), 'synthetic_source_invalid');
  const initial = await request('/api/sources');
  requireCondition(initial?.schemaVersion === 1 && initial.applyMode === 'account_token' &&
    initial.installationEnabled === true && Number.isSafeInteger(initial.revision) &&
    Array.isArray(initial.sources), 'fresh_token_managed_gateway_required');
  const existing = initial.sources.find((item) => item.url === source.url) ?? null;
  requireCondition(initial.sources.length === (existing === null ? 0 : 1), 'fresh_token_managed_gateway_required');
  requireCondition(existing === null || (v.is(v.pipe(v.string(), v.regex(SOURCE_ID)), existing.id) &&
    ['draft', 'installed'].includes(existing.status) && Array.isArray(existing.enabledTools) &&
    existing.enabledTools.length === 1 && existing.enabledTools[0] === source.tool), 'source_draft_unverified');
  // A re-entry reads the roster only after the source journal is reconciled: the gateway withholds its team view
  // while a stopped source action leaves the Portal ahead of the committed ownership.
  let initialMembers = null;
  if (existing === null) {
    const initialTeam = verifiedTeam(await request('/api/team'));
    requireCondition(administratorsOnly(initialTeam, initialTeam.members), 'fresh_team_required');
    initialMembers = initialTeam.members;
  }
  let draft = existing;
  let revision = initial.revision;
  if (draft === null) {
    const discovery = await request('/api/sources/discover', { method: 'POST', body: { url: source.url } });
    requireCondition(discovery?.status === 'discovered' && discovery.authentication === 'none' &&
      discovery.endpoint === source.url && Array.isArray(discovery.tools) &&
      discovery.tools.some((tool) => tool.name === source.tool && tool.destructiveHint !== true), 'synthetic_source_not_discovered');
    await checkpoint({ stage: 'source_draft', status: 'started' });
    const saved = await request('/api/sources', { method: 'PUT', body: {
      schemaVersion: 1, revision: initial.revision,
      source: { label: 'Lifecycle synthetic source', url: source.url, authMode: 'none', enabledTools: [source.tool] },
    } });
    draft = saved?.sources?.find((item) => item.url === source.url);
    requireCondition(v.is(v.pipe(v.string(), v.regex(SOURCE_ID)), draft?.id) && draft.status === 'draft' && saved.sources.length === 1 &&
      Number.isSafeInteger(saved.revision), 'source_draft_unverified');
    revision = saved.revision;
  }
  await checkpoint({ stage: 'source_apply', status: 'started', sourceId: draft.id });
  const applied = await applySource({ request, checkpoint, wait, draft, revision });
  requireCondition(ACTION_ID.test(applied?.actionId), 'source_action_unverified');
  await checkpoint({ stage: 'source_apply', status: 'recorded', sourceId: draft.id, actionId: applied.actionId });
  requireCondition(applied.status === 'succeeded' && applied.handoffUrl === undefined, 'source_action_not_completed_without_oauth');
  const action = await request(`/api/source-actions/${applied.actionId}`);
  requireCondition(action?.status === 'succeeded' && action.sourceId === draft.id, 'source_action_readback_failed');
  const installed = await request('/api/sources');
  requireCondition(installed?.sources?.some((item) => item.id === draft.id && item.status === 'installed' &&
    item.enabledTools.length === 1 && item.enabledTools[0] === source.tool), 'source_install_readback_failed');
  // Installing a source grants nobody. A fresh run compares against the roster it entered with; a re-entry accepts
  // exactly administrators without sources plus this exercise's own earlier grant of the synthetic member.
  const denyTeam = verifiedTeam(await request('/api/team'));
  const baseline = denyTeam.members.filter((member) => member.email !== SYNTHETIC_EMAIL);
  requireCondition(administratorsOnly(denyTeam, baseline) && denyTeam.members.every((member) => member.email !== SYNTHETIC_EMAIL ||
    (Array.isArray(member.sourceIds) && member.sourceIds.length === 1 && member.sourceIds[0] === draft.id)), 'fresh_team_required');
  requireCondition(initialMembers === null || membership(denyTeam.members) === membership(initialMembers), 'source_not_default_deny');
  await checkpoint({ stage: 'source_apply', status: 'passed', sourceId: draft.id, actionId: applied.actionId });

  for (const [stage, members] of [
    ['team_grant', [...baseline, { email: SYNTHETIC_EMAIL, sourceIds: [draft.id] }]],
    ['team_remove', baseline],
  ]) {
    const before = verifiedTeam(await request('/api/team'));
    if (membership(before.members) === membership(members)) {
      await checkpoint({ stage, status: 'recovered', sourceId: draft.id });
      continue;
    }
    await checkpoint({ stage, status: 'started', sourceId: draft.id });
    const result = await request('/api/team-actions', { method: 'POST', body: {
      schemaVersion: 1, expectedRevision: before.revision, members,
    } });
    requireCondition(ACTION_ID.test(result?.action?.actionId), 'team_action_unverified');
    await checkpoint({ stage, status: 'recorded', actionId: result.action.actionId });
    requireCondition(result.action.status === 'succeeded' && result.handoffUrl === undefined, 'team_action_not_completed_without_oauth');
    const after = verifiedTeam(await request('/api/team'));
    requireCondition(after.revision > before.revision && membership(after.members) === membership(members), 'team_policy_readback_failed');
    await checkpoint({ stage, status: 'passed', actionId: result.action.actionId });
  }
  return { sourceId: draft.id, sourceActionId: applied.actionId, baselineMembers: baseline };
}
