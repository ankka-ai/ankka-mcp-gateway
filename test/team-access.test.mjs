import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TeamAccessError,
  normalizeTeamAccessRequest,
  planTeamAccessChange,
  teamPolicy,
  teamPolicyMatches,
} from '../src/team-access.js';

const ADMIN = 'owner@example.com';
const PERSON = 'person@example.com';

function context() {
  return {
    revision: 3,
    adminEmails: [ADMIN],
    sources: [
      { id: 'erp', label: 'ERP', enabledTools: ['erp_health', 'erp_search'], installed: true },
      { id: 'wiki', label: 'Wiki', enabledTools: ['wiki_search'], installed: true },
      { id: 'draft', label: 'Draft', enabledTools: [], installed: false },
    ],
    currentMembers: [{ email: ADMIN, sourceIds: ['erp'] }],
    portalTarget: { applicationId: 'portal-app', policyId: 'portal-policy', policyName: 'Gateway people' },
    sourceTargets: [
      { sourceId: 'wiki', applicationId: 'wiki-app', policyId: 'wiki-policy', policyName: 'Wiki people' },
      { sourceId: 'erp', applicationId: 'erp-app', policyId: 'erp-policy', policyName: 'ERP people' },
    ],
  };
}

function request(members = [{ email: ADMIN, sourceIds: ['erp'] }]) {
  return { schemaVersion: 1, expectedRevision: 3, members };
}

function code(expected) {
  return (error) => error instanceof TeamAccessError && error.message === expected && error.code === expected;
}

function observed(policy = teamPolicy([ADMIN], 'ERP people')) {
  return { id: 'erp-policy', ...structuredClone(policy) };
}

test('request normalization copies, sorts, and deeply freezes exact assignments', () => {
  const value = request([
    { email: ' PERSON@EXAMPLE.COM ', sourceIds: ['wiki', 'erp'] },
    { email: ' OWNER@example.com ', sourceIds: [] },
  ]);
  const baseline = structuredClone(value);
  const parsed = normalizeTeamAccessRequest(value, context());
  assert.deepEqual(parsed, request([
    { email: ADMIN, sourceIds: [] },
    { email: PERSON, sourceIds: ['erp', 'wiki'] },
  ]));
  assert.deepEqual(value, baseline);
  assert.ok(Object.isFrozen(parsed));
  assert.ok(Object.isFrozen(parsed.members));
  assert.ok(Object.isFrozen(parsed.members[1]));
  assert.ok(Object.isFrozen(parsed.members[1].sourceIds));
  value.members[1].sourceIds.push('wiki');
  assert.deepEqual(parsed.members[0].sourceIds, []);
});

test('administrator identities must remain, without implicit source permissions', () => {
  assert.throws(() => normalizeTeamAccessRequest(request([{ email: PERSON, sourceIds: [] }]), context()),
    code('team_access_admin_required'));
  const current = context();
  current.adminEmails.push('second-owner@example.com');
  assert.throws(() => normalizeTeamAccessRequest(request(), current), code('team_access_admin_required'));
  const parsed = normalizeTeamAccessRequest(request([{ email: ADMIN, sourceIds: [] }]), context());
  assert.deepEqual(parsed.members[0].sourceIds, []);
});

test('strict request schema rejects roles, per-person tools, credentials, and unknown fields', () => {
  for (const value of [
    null, [], {}, { ...request(), schemaVersion: 2 }, { ...request(), role: 'admin' },
    { ...request(), expectedRevision: '3' }, { ...request(), expectedRevision: -1 },
    { ...request(), expectedRevision: 3.5 },
    request([{ email: ADMIN, sourceIds: [], role: 'admin' }]),
    request([{ email: ADMIN, sourceIds: [], tools: ['erp_search'] }]),
    request([{ email: ADMIN, sourceIds: [], authorization: 'synthetic-only' }]),
    request([{ email: ADMIN }]), request([]),
  ]) {
    assert.throws(() => normalizeTeamAccessRequest(value, context()), code('team_access_invalid_request'));
  }
  let getterCalls = 0;
  const accessor = { schemaVersion: 1, expectedRevision: 3, get members() { getterCalls += 1; return []; } };
  assert.throws(() => normalizeTeamAccessRequest(accessor, context()), code('team_access_invalid_request'));
  assert.equal(getterCalls, 0);
  assert.throws(() => normalizeTeamAccessRequest({ ...request(), [Symbol('extra')]: true }, context()),
    code('team_access_invalid_request'));
});

test('revision conflicts are distinct and invalid current revisions fail closed', () => {
  for (const revision of [2, 4, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => normalizeTeamAccessRequest({ ...request(), expectedRevision: revision }, context()),
      code('team_access_revision_conflict'));
  }
  for (const revision of [-1, 3.5, '3', Number.MAX_SAFE_INTEGER, Infinity]) {
    assert.throws(() => normalizeTeamAccessRequest(request(), { ...context(), revision }),
      code('team_access_invalid_state'));
  }
});

test('emails are bounded and duplicates after normalization are rejected', () => {
  for (const email of ['', 'no-at-sign', 'two@@example.com', 'line\nbreak@example.com', 'a'.repeat(65) + '@example.com']) {
    assert.throws(() => normalizeTeamAccessRequest(request([
      { email: ADMIN, sourceIds: [] }, { email, sourceIds: [] },
    ]), context()), code('team_access_invalid_request'));
  }
  assert.throws(() => normalizeTeamAccessRequest(request([
    { email: ADMIN, sourceIds: [] }, { email: ' OWNER@EXAMPLE.COM ', sourceIds: [] },
  ]), context()), code('team_access_invalid_request'));
});

test('larger teams and administrator audiences retain exact grants without a user-count cap', () => {
  const members = [{ email: ADMIN, sourceIds: [] }, ...Array.from({ length: 100 }, (_value, index) => ({
    email: `user-${String(index).padStart(3, '0')}@example.com`, sourceIds: ['erp'],
  }))];
  const current = context();
  const parsed = normalizeTeamAccessRequest(request(members), current);
  assert.deepEqual(parsed.members, members);
  const plan = planTeamAccessChange(request(members), current);
  assert.equal(plan.policies[0].after.include.length, 101);
  const erp = plan.policies.find(({ sourceId }) => sourceId === 'erp').after;
  assert.deepEqual(erp.include.map(({ email }) => email.email), members.slice(1).map(({ email }) => email));
  assert.equal(teamPolicyMatches(observed(erp), erp, 'erp-policy'), true);
  current.adminEmails = members.map(({ email }) => email);
  assert.deepEqual(normalizeTeamAccessRequest(request(members), current).members, members);
  assert.throws(() => normalizeTeamAccessRequest(request(members.slice(0, -1)), current),
    code('team_access_admin_required'));
});

test('only explicitly assigned installed sources are valid', () => {
  for (const sourceIds of [['draft'], ['unknown'], ['erp', 'erp'], ['*'], [null], Array(33).fill('erp')]) {
    assert.throws(() => normalizeTeamAccessRequest(request([{ email: ADMIN, sourceIds }]), context()),
      code('team_access_invalid_request'));
  }
  const current = context();
  current.sources.push({ id: 'new-source', label: 'New source', enabledTools: ['health'], installed: true });
  assert.deepEqual(normalizeTeamAccessRequest(request(), current).members[0].sourceIds, ['erp']);
});

test('source capability context is bounded and cannot smuggle policy or credential fields', () => {
  const original = context();
  for (const source of [
    { ...original.sources[0], installed: 'true' },
    { ...original.sources[0], token: 'synthetic-only' },
    { ...original.sources[0], enabledTools: ['a', 'a'] },
    { ...original.sources[0], enabledTools: ['bad tool'] },
    { ...original.sources[0], enabledTools: Array(501).fill('health') },
    { ...original.sources[0], label: 'x'.repeat(81) },
  ]) {
    assert.throws(() => normalizeTeamAccessRequest(request(), { ...original, sources: [source] }),
      code('team_access_invalid_state'));
  }
  assert.throws(() => normalizeTeamAccessRequest(request(), { ...original, sources: Array(33).fill(original.sources[0]) }),
    code('team_access_invalid_state'));
  assert.throws(() => normalizeTeamAccessRequest(request(), { ...original, sources: [original.sources[0], original.sources[0]] }),
    code('team_access_invalid_state'));
  assert.throws(() => normalizeTeamAccessRequest(request(), { ...original, adminEmails: [] }),
    code('team_access_invalid_state'));
});

test('email policy is canonical; an empty audience is explicit deny-everyone', () => {
  assert.deepEqual(teamPolicy([PERSON, ' OWNER@EXAMPLE.COM '], 'ERP people'), {
    name: 'ERP people', decision: 'allow',
    include: [{ email: { email: ADMIN } }, { email: { email: PERSON } }], exclude: [], require: [],
  });
  const policy = teamPolicy([], 'ERP people');
  assert.deepEqual(policy, {
    name: 'ERP people', decision: 'deny', include: [{ everyone: {} }], exclude: [], require: [],
  });
  assert.ok(Object.isFrozen(policy.include[0].everyone));
  assert.throws(() => teamPolicy([ADMIN, ADMIN], 'ERP people'), code('team_access_invalid_request'));
  assert.throws(() => teamPolicy([], ''), code('team_access_invalid_target'));
});

test('provider readback accepts full neutral metadata, any email order, and expected precedence', () => {
  const expected = teamPolicy([ADMIN, PERSON], 'ERP people');
  const live = {
    ...observed(expected), include: [...expected.include].reverse(),
    uid: 'erp-policy', reusable: false,
    account_id: 'synthetic-account', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z',
    precedence: 1, approval_required: false, approval_groups: [], isolation_required: false,
    purpose_justification_required: false, purpose_justification_prompt: '', session_duration: null,
    connection_rules: {}, mfa_config: null,
  };
  assert.equal(teamPolicyMatches(live, expected, 'erp-policy'), true);
  assert.equal(teamPolicyMatches(live, { ...expected, precedence: 1 }, 'erp-policy'), true);
  assert.equal(teamPolicyMatches(live, { ...expected, precedence: 2 }, 'erp-policy'), false);
  assert.equal(teamPolicyMatches({ ...live, precedence: '1' }, expected, 'erp-policy'), false);
  const deny = teamPolicy([], 'ERP people');
  assert.equal(teamPolicyMatches(observed(deny), deny, 'erp-policy'), true);
});

test('provider readback blocks group policies, extra rules, policy-ID drift, and allow-everyone', () => {
  const expected = teamPolicy([ADMIN], 'ERP people');
  const original = observed(expected);
  for (const patch of [
    { id: 'different-policy' }, { name: 'different name' }, { decision: 'bypass' },
    { decision: 'non_identity' }, { decision: 'allow', include: [] },
    { include: [{ everyone: {} }] }, { include: [{ group: { id: 'synthetic-group' } }] },
    { include: [...original.include, ...original.include] },
    { include: [{ email: { email: ADMIN, extra: true } }] },
    { include: [{ email: { email: ADMIN }, everyone: {} }] },
    { require: [{ email: { email: ADMIN } }] }, { exclude: [{ email: { email: PERSON } }] },
    { require: null }, { exclude: undefined },
  ]) {
    assert.equal(teamPolicyMatches({ ...original, ...patch }, expected, 'erp-policy'), false);
  }
  const deny = teamPolicy([], 'ERP people');
  assert.equal(teamPolicyMatches(observed({ ...deny, include: [{ everyone: { extra: true } }] }), deny, 'erp-policy'), false);
  assert.equal(teamPolicyMatches(observed({ ...deny, include: [] }), deny, 'erp-policy'), false);
});

test('non-default or unknown authorization fields block a rewrite', () => {
  const expected = teamPolicy([ADMIN], 'ERP people');
  for (const patch of [
    { uid: 'different-policy' }, { uid: null }, { reusable: true }, { reusable: null },
    { approval_required: true }, { approval_groups: [{ approvals_needed: 1 }] },
    { isolation_required: true }, { purpose_justification_required: true },
    { purpose_justification_prompt: 'Keep this requirement' }, { session_duration: '15m' },
    { connection_rules: { ssh: { usernames: ['operator'] } } },
    { mfa_config: { mfa_disabled: false } }, { unknown_authorization: false },
  ]) {
    assert.equal(teamPolicyMatches({ ...observed(expected), ...patch }, expected, 'erp-policy'), false);
  }
  assert.equal(teamPolicyMatches(observed(expected), { ...expected, require: [{ everyone: {} }] }, 'erp-policy'), false);
  assert.equal(teamPolicyMatches(null, expected, 'erp-policy'), false);
});

test('plan projects exact changes without mutating admins, tool lists, inputs, or targets', () => {
  const current = context();
  const baseline = structuredClone(current);
  const input = request([{ email: PERSON, sourceIds: ['wiki'] }, { email: ADMIN, sourceIds: [] }]);
  const result = planTeamAccessChange(input, current);
  assert.deepEqual(result.summary, { addedPeople: 1, removedPeople: 0, changedSources: 2 });
  assert.deepEqual(result.policyChanges.map((change) => [change.kind, change.sourceId]), [
    ['portal', undefined], ['source', 'erp'], ['source', 'wiki'],
  ]);
  assert.deepEqual(result.policies, result.policyChanges);
  const erp = result.policyChanges[1];
  assert.equal(erp.applicationId, 'erp-app');
  assert.equal(erp.policyId, 'erp-policy');
  assert.deepEqual(erp.before, teamPolicy([ADMIN], 'ERP people'));
  assert.deepEqual(erp.after, teamPolicy([], 'ERP people'));
  assert.deepEqual(result.policyChanges[2].before, teamPolicy([], 'Wiki people'));
  assert.deepEqual(result.nextState, {
    schemaVersion: 1, revision: 4, members: [{ email: ADMIN, sourceIds: [] }, { email: PERSON, sourceIds: ['wiki'] }],
  });
  assert.deepEqual(current, baseline);
  assert.ok(Object.isFrozen(result.policyChanges[0].after.include));
  assert.ok(Object.isFrozen(result.nextState.members[0].sourceIds));
  assert.equal(JSON.stringify(result.nextState).includes('applicationId'), false);
  assert.equal(JSON.stringify(result.nextState).includes('enabledTools'), false);
});

test('no-op plan contains no cloud writes; removing a person removes only their explicit grants', () => {
  const noOp = planTeamAccessChange(request(), context());
  assert.deepEqual(noOp.policyChanges, []);
  assert.deepEqual(noOp.policies.map((policy) => policy.sourceId), [undefined, 'erp', 'wiki']);
  assert.ok(noOp.policies.every((policy) => JSON.stringify(policy.before) === JSON.stringify(policy.after)));
  const current = context();
  current.currentMembers.push({ email: PERSON, sourceIds: ['wiki'] });
  const result = planTeamAccessChange(request(), current);
  assert.deepEqual(result.summary, { addedPeople: 0, removedPeople: 1, changedSources: 1 });
  assert.equal(result.policyChanges[1].sourceId, 'wiki');
  assert.equal(result.policies.length, 3);
  assert.deepEqual(result.policyChanges[1].after, teamPolicy([], 'Wiki people'));
});

test('new installed source starts denied; no-op input does not inherit the Portal audience', () => {
  const current = context();
  current.sources.push({ id: 'new-source', label: 'New source', enabledTools: ['health'], installed: true });
  current.sourceTargets.push({ sourceId: 'new-source', applicationId: 'new-app', policyId: 'new-policy', policyName: 'New people' });
  assert.deepEqual(planTeamAccessChange(request(), current).policyChanges, []);
  assert.deepEqual(planTeamAccessChange(request(), current).policies.find((policy) => policy.sourceId === 'new-source').before,
    teamPolicy([], 'New people'));
  const result = planTeamAccessChange(request([{ email: ADMIN, sourceIds: ['erp', 'new-source'] }]), current);
  assert.equal(result.policyChanges.length, 1);
  assert.deepEqual(result.policyChanges[0].before, teamPolicy([], 'New people'));
  assert.deepEqual(result.policyChanges[0].after, teamPolicy([ADMIN], 'New people'));
});

test('plans require an exact unique target for every installed source', () => {
  for (const change of [
    (current) => { current.sourceTargets.pop(); },
    (current) => { current.sourceTargets.push({ ...current.sourceTargets[0] }); },
    (current) => { current.sourceTargets[0].sourceId = 'draft'; },
    (current) => { current.sourceTargets[0].applicationId = current.portalTarget.applicationId; },
    (current) => { current.sourceTargets[0].policyId = current.portalTarget.policyId; },
    (current) => { current.sourceTargets[0].applicationId = '../other'; },
    (current) => { current.sourceTargets[0].token = 'synthetic-only'; },
    (current) => { current.portalTarget.url = 'https://other.example.com'; },
  ]) {
    const current = context();
    change(current);
    assert.throws(() => planTeamAccessChange(request(), current), code('team_access_invalid_target'));
  }
  assert.throws(() => planTeamAccessChange(request(), { ...context(), currentMembers: [{ email: PERSON, sourceIds: [] }] }),
    code('team_access_invalid_state'));
});

test('errors never echo identity, tool arguments, or caller-controlled messages', () => {
  const failure = new TeamAccessError('person@example.com private input');
  assert.equal(failure.message, 'team_access_invalid_request');
  assert.equal(failure.code, 'team_access_invalid_request');
  assert.throws(() => normalizeTeamAccessRequest(request([
    { email: 'private input', sourceIds: [] },
  ]), context()), code('team_access_invalid_request'));
});

test('every subset of source grants projects only those people to each exact native audience', () => {
  for (let adminMask = 0; adminMask < 4; adminMask += 1) {
    for (let memberMask = 0; memberMask < 4; memberMask += 1) {
      const sourceIds = ['erp', 'wiki'];
      const grants = (mask) => sourceIds.filter((_sourceId, index) => (mask & (1 << index)) !== 0);
      const members = [{ email: ADMIN, sourceIds: grants(adminMask) }, { email: PERSON, sourceIds: grants(memberMask) }];
      const plan = planTeamAccessChange(request(members), context());
      assert.deepEqual(plan.policies[0].after.include, [{ email: { email: ADMIN } }, { email: { email: PERSON } }]);
      for (const sourceId of sourceIds) {
        const target = plan.policies.find((entry) => entry.sourceId === sourceId);
        const expected = members.filter((member) => member.sourceIds.includes(sourceId)).map((member) => member.email);
        assert.deepEqual(target.after, teamPolicy(expected, sourceId === 'erp' ? 'ERP people' : 'Wiki people'));
        assert.equal(Object.hasOwn(target.after, 'tools'), false);
      }
      assert.deepEqual(plan.nextState.members, members);
    }
  }
});

test('removing one person cannot transfer their former source permissions to a replacement', () => {
  const current = context();
  current.currentMembers = [{ email: ADMIN, sourceIds: [] }, { email: 'departed@example.com', sourceIds: ['erp', 'wiki'] }];
  const plan = planTeamAccessChange(request([{ email: ADMIN, sourceIds: [] }, { email: PERSON, sourceIds: [] }]), current);
  assert.deepEqual(plan.summary, { addedPeople: 1, removedPeople: 1, changedSources: 2 });
  assert.ok(plan.policies.filter((entry) => entry.kind === 'source').every((entry) => entry.after.decision === 'deny'));
  assert.deepEqual(plan.nextState.members, [{ email: ADMIN, sourceIds: [] }, { email: PERSON, sourceIds: [] }]);
});

const FINANCE = 'team-0123456789abcdef';
const LEGAL = 'team-fedcba9876543210';
const FINANCE_GROUP = 'synthetic-finance-group';
const LEGAL_GROUP = 'synthetic-legal-group';

function storedTeam(id, name, memberEmails, sourceIds, accessGroupId) {
  return { id, name, memberEmails, sourceIds, accessGroupId };
}

function teamInput(teams, members = [{ email: ADMIN, sourceIds: ['erp'] }]) {
  return { ...request(members), teams };
}

test('a membership change updates one group and does not rewrite connector policies', () => {
  const current = context();
  current.currentTeams = [storedTeam(FINANCE, 'Finance', [PERSON], ['erp'], FINANCE_GROUP)];
  const plan = planTeamAccessChange(teamInput([{
    id: FINANCE, name: 'Finance', memberEmails: ['other@example.com', PERSON], sourceIds: ['erp'],
  }]), current);
  assert.deepEqual(plan.groupChanges, [{
    op: 'update', teamId: FINANCE, groupId: FINANCE_GROUP, memberEmails: ['other@example.com', PERSON],
  }]);
  assert.deepEqual(plan.policyChanges, []);
  const portal = plan.policies.find((policy) => policy.kind === 'portal');
  assert.deepEqual(portal.after.include.at(-1), { group: { id: FINANCE_GROUP } });
  assert.equal(Object.hasOwn(planTeamAccessChange(request(), context()), 'groupChanges'), false);
  assert.equal(Object.hasOwn(planTeamAccessChange(request(), context()).nextState, 'teams'), false);
  assert.equal(Object.hasOwn(planTeamAccessChange(teamInput([]), context()).nextState, 'teams'), false);
});

test('an allowlist edit changes only the affected connector policy', () => {
  const current = context();
  current.currentTeams = [storedTeam(FINANCE, 'Finance', [PERSON], ['erp'], FINANCE_GROUP)];
  const plan = planTeamAccessChange(teamInput([{
    id: FINANCE, name: 'Finance', memberEmails: [PERSON], sourceIds: ['wiki'],
  }]), current);
  assert.equal(plan.groupChanges, undefined);
  assert.deepEqual(plan.policyChanges.map((policy) => policy.sourceId), ['erp', 'wiki']);
  const erp = plan.policies.find((policy) => policy.sourceId === 'erp');
  const wiki = plan.policies.find((policy) => policy.sourceId === 'wiki');
  assert.equal(erp.after.include.some((rule) => rule.group), false);
  assert.deepEqual(wiki.after.include.at(-1), { group: { id: FINANCE_GROUP } });
  assert.equal(JSON.stringify(plan.policies.find((policy) => policy.kind === 'portal').before),
    JSON.stringify(plan.policies.find((policy) => policy.kind === 'portal').after));
});

test('overlapping teams union group rules and a removed team leaves the other grant and a direct email', () => {
  const current = context();
  current.currentMembers = [{ email: ADMIN, sourceIds: ['erp'] }, { email: PERSON, sourceIds: ['erp'] }];
  current.currentTeams = [
    storedTeam(FINANCE, 'Finance', [PERSON], ['erp', 'wiki'], FINANCE_GROUP),
    storedTeam(LEGAL, 'Legal', [PERSON], ['erp'], LEGAL_GROUP),
  ];
  const kept = planTeamAccessChange(teamInput([
    { id: FINANCE, name: 'Finance', memberEmails: [PERSON], sourceIds: ['erp', 'wiki'] },
    { id: LEGAL, name: 'Legal', memberEmails: [], sourceIds: ['erp'] },
  ], current.currentMembers), current);
  const erp = kept.policies.find((policy) => policy.sourceId === 'erp').after.include;
  assert.deepEqual(erp.filter((rule) => rule.email).map((rule) => rule.email.email), [ADMIN, PERSON]);
  assert.deepEqual(erp.filter((rule) => rule.group).map((rule) => rule.group.id), [FINANCE_GROUP]);
  assert.deepEqual(kept.groupChanges.map((change) => change.op), ['delete']);
  const removed = planTeamAccessChange(teamInput([
    { id: LEGAL, name: 'Legal', memberEmails: [PERSON], sourceIds: ['erp'] },
  ], current.currentMembers), current);
  const after = removed.policies.find((policy) => policy.sourceId === 'erp').after.include;
  assert.ok(after.some((rule) => rule.email?.email === PERSON));
  assert.deepEqual(after.filter((rule) => rule.group).map((rule) => rule.group.id), [LEGAL_GROUP]);
});

test('a new team waits for its group on the portal and the selected connectors', () => {
  const plan = planTeamAccessChange(teamInput([{
    id: FINANCE, name: 'Finance', memberEmails: [PERSON], sourceIds: ['wiki'],
  }]), context());
  assert.deepEqual(plan.groupChanges, [{ op: 'create', teamId: FINANCE, memberEmails: [PERSON] }]);
  const portal = plan.policies.find((policy) => policy.kind === 'portal');
  const wiki = plan.policies.find((policy) => policy.sourceId === 'wiki');
  const erp = plan.policies.find((policy) => policy.sourceId === 'erp');
  assert.deepEqual(portal.unresolvedTeamIds, [FINANCE]);
  assert.deepEqual(wiki.unresolvedTeamIds, [FINANCE]);
  assert.equal(erp.unresolvedTeamIds, undefined);
  assert.equal(wiki.after.include.some((rule) => rule.group), false);
  assert.throws(() => normalizeTeamAccessRequest(teamInput([{
    id: FINANCE, name: 'Finance', memberEmails: [PERSON], sourceIds: ['*'],
  }]), context()), code('team_access_invalid_request'));
});

test('renaming a team does not change its group or connector policies', () => {
  const current = context();
  current.currentTeams = [storedTeam(FINANCE, 'Finance', [PERSON], ['erp'], FINANCE_GROUP)];
  const plan = planTeamAccessChange(teamInput([{
    id: FINANCE, name: 'Finance readers', memberEmails: [PERSON], sourceIds: ['erp'],
  }]), current);
  assert.equal(plan.groupChanges, undefined);
  assert.deepEqual(plan.policyChanges, []);
  assert.equal(plan.nextState.teams[0].name, 'Finance readers');
});

test('an expected group rule matches that group and rejects a different one', () => {
  const expected = teamPolicy([ADMIN], 'ERP people', [FINANCE_GROUP]);
  assert.equal(teamPolicyMatches(observed(expected), expected, 'erp-policy'), true);
  assert.equal(teamPolicyMatches(observed(teamPolicy([ADMIN], 'ERP people', [LEGAL_GROUP])), expected, 'erp-policy'), false);
  assert.equal(teamPolicyMatches(observed(teamPolicy([ADMIN], 'ERP people')), expected, 'erp-policy'), false);
});

