import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as v from 'valibot';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseVerifiedReleaseBundle } from '../src/verified-release-bundle';
import { openLifecycleRecord, type LifecycleRecord } from '../../../tools/lifecycle-record.mjs';
import { sourceActionRuntimeFixture } from './source-action-runtime-fixture';
import { localControlPlane, type LoadedRelease } from '../lifecycle/release';
import { createGuardedTransport, endpointFamily, LifecycleTransportError, stageFamilies } from '../lifecycle/transport';

const ACCOUNT = `https://api.cloudflare.com/client/v4/accounts/${'a'.repeat(32)}`;
const ZONE = `https://api.cloudflare.com/client/v4/zones/${'b'.repeat(32)}`;

describe('lifecycle transport guard', () => {
  let directory: string;
  let record: LifecycleRecord;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'ankka-lifecycle-transport-'));
    await chmod(directory, 0o700);
    record = await openLifecycleRecord(directory, { create: true, holdLock: false, jobId: 'job-test', targetDigest: `sha256:${'0'.repeat(64)}` });
  });
  afterAll(async () => { await record.close(); await rm(directory, { recursive: true, force: true }); });

  it('classifies provider paths into the fixed endpoint families', () => {
    const cases: readonly (readonly [string, string | null])[] = [
      ['https://api.cloudflare.com/client/v4/accounts?per_page=2', 'accounts-list'],
      ['https://api.cloudflare.com/client/v4/zones?account.id=x', 'zones-list'],
      [ZONE, 'zones-list'],
      [`${ZONE}/dns_records?per_page=1`, 'dns-records'],
      [`${ZONE}/access/apps`, 'access-applications'],
      [`${ACCOUNT}/workers/subdomain`, 'workers-subdomain'],
      [`${ACCOUNT}/workers/scripts/ankka-gateway-x/subdomain`, 'workers-subdomain'],
      [`${ACCOUNT}/workers/domains`, 'workers-custom-domains'],
      [`${ACCOUNT}/workers/durable_objects/namespaces`, 'workers-durable-object-namespaces'],
      [`${ACCOUNT}/workers/scripts/ankka-gateway-x/versions/1`, 'workers-versions'],
      [`${ACCOUNT}/workers/scripts/ankka-gateway-x/deployments`, 'workers-deployments'],
      [`${ACCOUNT}/workers/scripts/ankka-gateway-x/secrets`, 'workers-scripts'],
      [`${ACCOUNT}/workers/workers/ankka-gateway-x`, 'workers-scripts'],
      [`${ACCOUNT}/workers/assets/upload?base64=true`, 'workers-assets'],
      [`${ACCOUNT}/access/organizations`, 'access-organization'],
      [`${ACCOUNT}/access/identity_providers`, 'access-identity-providers'],
      [`${ACCOUNT}/access/apps/app/policies/policy`, 'access-applications'],
      [`${ZONE}/access/apps/app/policies`, 'access-applications'],
      [`${ACCOUNT}/access/policies`, 'access-policies'],
      [`${ACCOUNT}/tokens/verify`, 'account-tokens-verify'],
      [`${ACCOUNT}/access/ai-controls/mcp/servers`, 'mcp-servers'],
      [`${ACCOUNT}/access/ai-controls/mcp/portals/x`, 'mcp-portals'],
      ['https://api.cloudflare.com/client/v4/graphql', 'account-analytics'],
      ['https://api.cloudflare.com/client/v4/user/tokens/verify', null],
      [`${ACCOUNT}/tokens`, null],
      ['https://api.cloudflare.com/client/v4/accounts/not-an-id/workers/scripts', null],
    ];
    for (const [url, family] of cases) expect(endpointFamily(new URL(url)), url).toBe(family);
  });

  it('derives stage families from the fixed operations plus runner-only reads', () => {
    const install = stageFamilies({ operations: ['install'], provisioning: false, diagnostics: false, tokenVerification: false });
    expect(install.has('mcp-portals')).toBe(true);
    expect(install.has('dns-records')).toBe(true);
    expect(install.has('account-analytics')).toBe(false);
    expect(install.has('account-tokens-verify')).toBe(false);
    const upgrade = stageFamilies({ operations: ['upgrade'], provisioning: true, diagnostics: true, tokenVerification: true });
    expect(upgrade.has('workers-scripts')).toBe(true);
    expect(upgrade.has('account-analytics')).toBe(true);
    expect(upgrade.has('account-tokens-verify')).toBe(true);
    expect(upgrade.has('mcp-portals')).toBe(false);
  });

  it('forwards admitted calls with a path-free trace, refuses other families and origins', async () => {
    const seen: string[] = [];
    const { transport } = createGuardedTransport({
      record, families: stageFamilies({ operations: ['upgrade'], provisioning: false, diagnostics: false, tokenVerification: false }),
      origins: new Map([['https://source.example.net', new Set(['GET'])]]),
      local: async () => null, interruptAfter: null,
      realFetch: async (input, init) => { seen.push(new Request(input, init).url); return new Response('{}', { status: 200 }); },
      terminate: () => { throw new Error('terminate must not run'); },
    });
    const response = await transport(`${ACCOUNT}/workers/scripts/ankka-gateway-x/settings`, { method: 'GET' });
    expect(response.status).toBe(200);
    await expect(transport(`${ACCOUNT}/access/ai-controls/mcp/portals`)).rejects.toMatchObject({ code: 'endpoint_family_refused', detail: 'mcp-portals' });
    await expect(transport('https://api.cloudflare.com/client/v4/user/tokens/verify')).rejects.toMatchObject({ code: 'endpoint_family_refused', detail: 'unknown' });
    await expect(transport('https://deploy.ankka.ai/api/session')).rejects.toMatchObject({ code: 'origin_refused' });
    await expect(transport('https://source.example.net/mcp', { method: 'POST' })).rejects.toMatchObject({ code: 'origin_refused' });
    expect((await transport('https://source.example.net/mcp')).status).toBe(200);
    expect(seen).toEqual([`${ACCOUNT}/workers/scripts/ankka-gateway-x/settings`, 'https://source.example.net/mcp']);
    const trace = record.state.trace.at(-1);
    expect(trace).toEqual({ method: 'GET', family: 'workers-scripts', status: 200, ms: expect.any(Number) });
    expect(JSON.stringify(record.state.trace)).not.toContain('ankka-gateway-x');
  });

  it('refuses the next mutation once the job is cancelled, but still allows reads', async () => {
    const cancelDirectory = await mkdtemp(join(tmpdir(), 'ankka-lifecycle-cancel-'));
    await chmod(cancelDirectory, 0o700);
    const cancelled = await openLifecycleRecord(cancelDirectory, { create: true, holdLock: false, jobId: 'job-cancel', targetDigest: `sha256:${'1'.repeat(64)}` });
    try {
      await writeFile(join(cancelDirectory, 'cancel'), 'now\n', { mode: 0o600 });
      let mutations = 0;
      const { transport } = createGuardedTransport({
        record: cancelled, families: stageFamilies({ operations: ['upgrade'], provisioning: false, diagnostics: false, tokenVerification: false }),
        origins: new Map(), local: async () => null, interruptAfter: null,
        realFetch: async (input, init) => { if (new Request(input, init).method !== 'GET') mutations += 1; return new Response('{}'); },
        terminate: () => { throw new Error('terminate must not run'); },
      });
      expect((await transport(`${ACCOUNT}/workers/scripts/x/settings`)).status).toBe(200);
      await expect(transport(`${ACCOUNT}/workers/scripts/x`, { method: 'PUT' })).rejects.toMatchObject({ code: 'job_cancelled' });
      expect(mutations).toBe(0);
    } finally { await cancelled.close(); await rm(cancelDirectory, { recursive: true, force: true }); }
  });

  it('terminates abruptly right after the chosen mutating response, before the caller sees it', async () => {
    let terminated = 0;
    const { transport, mutations } = createGuardedTransport({
      record, families: stageFamilies({ operations: ['upgrade'], provisioning: false, diagnostics: false, tokenVerification: false }),
      origins: new Map(), local: async () => null, interruptAfter: 2,
      realFetch: async () => new Response('{}', { status: 200 }),
      terminate: () => { terminated += 1; throw new LifecycleTransportError('origin_refused', 'terminated'); },
    });
    await transport(`${ACCOUNT}/workers/scripts/x/settings`);
    await transport(`${ACCOUNT}/workers/scripts/x`, { method: 'PUT' });
    expect(terminated).toBe(0);
    await expect(transport(`${ACCOUNT}/workers/scripts/x`, { method: 'PUT' })).rejects.toMatchObject({ detail: 'terminated' });
    expect(terminated).toBe(1);
    expect(mutations()).toBe(2);
  });

  it('serves only exact-release routes of a loaded release on the control-plane origin', async () => {
    const fixture = await sourceActionRuntimeFixture({
      accountId: 'a'.repeat(32), actorEmail: 'owner@example.com', managementHostname: 'manage.example.com',
      workerId: 'b'.repeat(32), workerName: 'ankka-gateway-test', workersSubdomain: 'tenant',
    });
    const release: LoadedRelease = {
      pin: { ...fixture.identity }, publishDirectory: '/private/publish', bundle: fixture.bundle,
      parsed: parseVerifiedReleaseBundle(fixture.bundle), finalRuntimeSource: '',
    };
    const origin = fixture.bundle.manifest.controlPlaneOrigin;
    const exact = `${origin}/api/releases/${fixture.bundle.channel}/by-id/${fixture.bundle.manifest.release}/${fixture.bundle.manifest.artifact.treeSha256}`;
    const local = localControlPlane([release]);
    expect(await local(new Request('https://other.example.net/api/releases/canary'))).toBeNull();
    expect((await local(new Request(`${origin}/api/session`)))?.status).toBe(404);
    expect((await local(new Request(exact.replace(fixture.bundle.manifest.release, 'gateway-v9.9.9'))))?.status).toBe(404);
    expect((await local(new Request(exact, { method: 'POST' })))?.status).toBe(404);
    const channel = await local(new Request(exact));
    expect(channel?.status).toBe(200);
    const body = v.parse(v.looseObject({ release: v.looseObject({ id: v.string() }), verification: v.looseObject({ keyId: v.string() }) }), await channel?.json());
    expect(body.release.id).toBe(fixture.bundle.manifest.release);
    expect(body.verification.keyId).toBe(fixture.bundle.keyId);
    const file = await local(new Request(`${exact}/files/payload/worker/index.js`));
    expect(file?.status).toBe(200);
    expect(await file?.text()).toContain('ankka-control-plane-origin');
    expect((await local(new Request(`${exact}/files/payload/worker/missing.js`)))?.status).toBe(404);
  });
});
