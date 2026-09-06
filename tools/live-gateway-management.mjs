import * as v from 'valibot';

const ACTION_ID = /^action_[A-Za-z0-9_-]{32}$/u;
const SOURCE_ID = /^[a-z][a-z0-9-]{0,31}$/u;
const SYNTHETIC_EMAIL = 'qualification@example.com';

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

function membership(value) {
  return JSON.stringify(value.map((member) => [member.email, [...member.sourceIds].sort()])
    .sort(([left], [right]) => left.localeCompare(right)));
}

/** Fixed synthetic source and membership exercise through the real management API.
 * A lost or rejected mutation stops the sequence; its journal is never replaced.
 */
export async function qualifyLiveGatewayManagement({ request, source, checkpoint }) {
  const sourceUrl = new URL(source.url);
  requireCondition(sourceUrl.protocol === 'https:' && !sourceUrl.username && !sourceUrl.password &&
    !sourceUrl.hash && !sourceUrl.search && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(source.tool), 'synthetic_source_invalid');
  const initial = await request('/api/sources');
  requireCondition(initial?.schemaVersion === 1 && initial.applyMode === 'account_token' &&
    initial.installationEnabled === true && Number.isSafeInteger(initial.revision) &&
    Array.isArray(initial.sources) && initial.sources.length === 0, 'fresh_token_managed_gateway_required');
  const initialTeam = verifiedTeam(await request('/api/team'));
  const baseline = initialTeam.members;
  requireCondition(baseline.every((member) => initialTeam.adminEmails?.includes(member.email) && member.email !== SYNTHETIC_EMAIL && Array.isArray(member.sourceIds) && member.sourceIds.length === 0), 'fresh_team_required');
  const discovery = await request('/api/sources/discover', { method: 'POST', body: { url: source.url } });
  requireCondition(discovery?.status === 'discovered' && discovery.authentication === 'none' &&
    discovery.endpoint === source.url && Array.isArray(discovery.tools) &&
    discovery.tools.some((tool) => tool.name === source.tool && tool.destructiveHint !== true), 'synthetic_source_not_discovered');
  await checkpoint({ stage: 'source_draft', status: 'started' });
  const saved = await request('/api/sources', { method: 'PUT', body: {
    schemaVersion: 1, revision: initial.revision,
    source: { label: 'Lifecycle synthetic source', url: source.url, authMode: 'none', enabledTools: [source.tool] },
  } });
  const draft = saved?.sources?.find((item) => item.url === source.url);
  requireCondition(v.is(v.pipe(v.string(), v.regex(SOURCE_ID)), draft?.id) && draft.status === 'draft' && saved.sources.length === 1 &&
    Number.isSafeInteger(saved.revision), 'source_draft_unverified');
  await checkpoint({ stage: 'source_apply', status: 'started', sourceId: draft.id });
  const applied = await request('/api/source-actions', { method: 'POST', body: {
    schemaVersion: 1, revision: saved.revision, sourceId: draft.id,
  } });
  requireCondition(ACTION_ID.test(applied?.actionId), 'source_action_unverified');
  await checkpoint({ stage: 'source_apply', status: 'recorded', sourceId: draft.id, actionId: applied.actionId });
  requireCondition(applied.status === 'succeeded' && applied.handoffUrl === undefined, 'source_action_not_completed_without_oauth');
  const action = await request(`/api/source-actions/${applied.actionId}`);
  requireCondition(action?.status === 'succeeded' && action.sourceId === draft.id, 'source_action_readback_failed');
  const installed = await request('/api/sources');
  requireCondition(installed?.sources?.some((item) => item.id === draft.id && item.status === 'installed' &&
    item.enabledTools.length === 1 && item.enabledTools[0] === source.tool), 'source_install_readback_failed');
  const denyTeam = verifiedTeam(await request('/api/team'));
  requireCondition(membership(denyTeam.members) === membership(baseline), 'source_not_default_deny');
  await checkpoint({ stage: 'source_apply', status: 'passed', sourceId: draft.id, actionId: applied.actionId });

  for (const [stage, members] of [
    ['team_grant', [...baseline, { email: SYNTHETIC_EMAIL, sourceIds: [draft.id] }]],
    ['team_remove', baseline],
  ]) {
    const before = verifiedTeam(await request('/api/team'));
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
