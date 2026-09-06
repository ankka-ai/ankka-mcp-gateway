import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';

import { type BoundaryValue } from '../src/boundary';
import { base64UrlEncode } from '../src/crypto';
import {
  prepareCustomerBootstrapClaimFromPlan,
  submitCustomerBootstrapFromPlan,
} from '../src/customer-bootstrap-request';
import { customerPayloadEnvironment } from '../src/customer-payload-environment';
import { buildStaticDeployPlan, parseDeploySelection } from '../src/schema';
import type { ReleaseManifest, StaticDeployPlan } from '../src/schema';
import { openLiveTestRecord, providerDiagnostic } from '../../../tools/live-test-record.mjs';
import { canonicalJson } from '../src/canonical-json';
import { PUBLIC_ORIGIN } from '../src/constants';

/**
 * Token-mode Stage 2 harness: the converger's real bootstrap request into the
 * shipped payload, in-process, against the real Cloudflare API of the test
 * account with an API token instead of the OAuth grant. Every provider call is
 * traced (method, API family, status, duration; never paths, tokens or bodies). Resources
 * the payload creates are removed afterwards from its own receipt.
 */
const env = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const TOKEN = env('ANKKA_LIVE_TOKEN');
const ACCOUNT_ID = env('ANKKA_LIVE_ACCOUNT_ID');
const ZONE_ID = env('ANKKA_LIVE_ZONE_ID');
const ZONE_NAME = env('ANKKA_LIVE_ZONE_NAME');
const PREFIX = process.env.ANKKA_LIVE_PREFIX ?? 'harness';
const GATEWAY_NAME = process.env.ANKKA_LIVE_GATEWAY_NAME ?? `Ankka ${PREFIX}`;
const ADMIN_EMAIL = env('ANKKA_LIVE_ADMIN_EMAIL');
const MANIFEST_PATH = env('ANKKA_LIVE_MANIFEST');
const RECOVER = process.env.ANKKA_LIVE_RECOVER === '1';
const record = await openLiveTestRecord(env('ANKKA_LIVE_RUN_DIR'), { recover: RECOVER });

const target = Object.freeze({ accountId: ACCOUNT_ID, zoneId: ZONE_ID, zoneName: ZONE_NAME });
const NONCE = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
const KEY = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));

const realFetch = globalThis.fetch;
const counts = { calls: 0, ms: 0 };
// SAFETY: this wrapper preserves the native fetch input and response contract.
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(input, init);
  const started = performance.now();
  let status = 0;
  try { const response = await realFetch(request); status = response.status; return response; }
  finally {
    const diagnostic = providerDiagnostic(request, status, performance.now() - started);
    counts.calls++; counts.ms += diagnostic.ms;
    process.stdout.write(`${JSON.stringify(diagnostic)}\n`);
  }
}) as typeof fetch;

/** Durable Object storage stand-in: the payload only uses get and put. */
class MemoryStorage {
  readonly map = new Map<string, BoundaryValue>(Object.entries(record.state.storage));
  async get(key: string): Promise<BoundaryValue | undefined> { return this.map.get(key); }
  async put(key: string, value: BoundaryValue): Promise<void> { await record.put(key, value); this.map.set(key, structuredClone(value)); }
}

function stageOneEnvironment(plan: StaticDeployPlan) {
  const worker = plan.managementResources.find((resource) => resource.kind === 'management_worker');
  if (!worker) throw new TypeError('plan has no management worker');
  return Object.freeze({
    CLOUDFLARE_ACCOUNT_ID: target.accountId,
    ANKKA_INSTALL_ID: plan.managementOwnershipMarker,
    ANKKA_WORKER_NAME: worker.name,
    ANKKA_GATEWAY_RELEASE: plan.releaseId,
    ANKKA_GATEWAY_RELEASE_SHA256: `sha256:${plan.releaseArtifactSha256}`,
    ANKKA_PLAN_ID: plan.planId,
    ANKKA_PLAN_HASH: plan.planHash,
    ANKKA_BOOTSTRAP_ID: `boot_${'a'.repeat(24)}`,
    ANKKA_BOOTSTRAP_SECRET_SHA256: `sha256:${'b'.repeat(64)}`,
    ANKKA_BOOTSTRAP_EXPIRES_AT: String(Date.now() + 3_600_000),
    ANKKA_BOOTSTRAP_CALLBACK: `https://${worker.name}.example.workers.dev/__ankka/install/oauth/callback`,
    ANKKA_INSTALLER_ORIGIN: PUBLIC_ORIGIN,
    ANKKA_MANAGEMENT_HOSTNAME: plan.gatewayConfiguration.managementHostname,
    ANKKA_UPDATE_CHANNEL: 'canary',
    ANKKA_UPDATE_KEY_ID: 'release-2026-09-dev1',
    ANKKA_UPDATE_PUBLIC_KEY: KEY,
    CLOUDFLARE_CUSTOMER_OAUTH_CLIENT_ID: 'c'.repeat(32),
    CLOUDFLARE_OWNERSHIP_ISSUER_PUBLIC_KEY: KEY,
    CLOUDFLARE_OWNERSHIP_ISSUER_KEY_ID: 'issuer-2026-09',
    ANKKA_GATEWAY_OWNERSHIP_WRAP_KEY: KEY,
    ANKKA_BOOTSTRAP_NONCE: NONCE,
  });
}

const storage = new MemoryStorage();
async function cleanupRecorded() {
  const saved = record.state.recovery;
  if (!saved) throw new Error('ready_receipt_unavailable_keep_private_record');
  if (canonicalJson(saved.target) !== canonicalJson(target)) throw new Error('recovery_target_mismatch');
  const nonceBytes = crypto.getRandomValues(new Uint8Array(32));
  const nonce = base64UrlEncode(nonceBytes);
  const now = Math.floor(Date.now() / 1000);
  const body = canonicalJson({ schemaVersion: 1, requestId: base64UrlEncode(crypto.getRandomValues(new Uint8Array(16))),
    issuedAt: now, expiresAt: now + 300, target: saved.target, release: saved.result.release,
    expected: { configurationHash: saved.result.configurationHash, installationId: saved.result.installationId,
      desiredHash: saved.result.desiredHash, readyReceipt: saved.result.receipt.evidence }, cloudflareAccessToken: TOKEN });
  const key = await crypto.subtle.importKey('raw', nonceBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = `sha256=${Buffer.from(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))).toString('hex')}`;
  const cleanup = await import('../../../payload/worker-cleanup/index.js');
  await record.event('removal', 'started');
  const response = await new cleanup.AdminState({ storage }, { ...saved.environment, ANKKA_UNINSTALL_NONCE: nonce }).fetch(
    new Request('https://admin-state.invalid/uninstall', { method: 'POST', headers: {
      'content-type': 'application/json', 'x-ankka-uninstall-signature': signature }, body }));
  const result = await response.json();
  await record.put('provider-test/cleanup-response', result);
  if (response.status !== 200 || result.status !== 'removed') throw new Error('removal_unverified_keep_private_record');
  await record.event('removal', 'passed');
  process.stdout.write('PASS removal: production cleanup verified provider absence.\n');
}

describe('provider API cycle (no browser or deployed Worker)', () => {
  afterAll(async () => {
    try {
      if (record.state.recovery) await cleanupRecorded();
      else if (RECOVER || storage.map.size) throw new Error('partial_installation_keep_private_record');
    } catch {
      throw new Error('provider_cleanup_failed_keep_private_record');
    } finally {
      globalThis.fetch = realFetch;
      await record.close();
      process.stdout.write(`Provider calls: ${counts.calls}; total request time: ${counts.ms}ms. Browser lifecycle: NOT VALIDATED.\n`);
    }
  });

  it('creates the gateway resources and verifies its own receipt', async () => {
    if (RECOVER) return;
    try {
      await record.event('installation', 'started');
      // SAFETY: the file is a manifest written by build-gateway-release-candidate;
      // buildStaticDeployPlan verifies its integrity before anything uses it.
      const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as ReleaseManifest;
      const selection = parseDeploySelection({
        schemaVersion: 1,
        basics: {
          gatewayName: GATEWAY_NAME,
          zoneName: ZONE_NAME,
          adminEmail: ADMIN_EMAIL,
          additionalAdminEmails: [],
          managementHostname: `manage${PREFIX}.${ZONE_NAME}`,
          portalHostname: `mcp${PREFIX}.${ZONE_NAME}`,
        },
        firstSource: null,
      });
      const nowMs = Date.now();
      const plan = await buildStaticDeployPlan(selection, manifest, nowMs + 30 * 60_000);
      const environment = customerPayloadEnvironment(stageOneEnvironment(plan), target);
      const payload = await import('../../../payload/worker/index.js');
      process.stdout.write('Starting disposable provider installation.\n');

      const result = await submitCustomerBootstrapFromPlan({
        plan,
        target,
        accountWorkersSubdomain: { accountId: ACCOUNT_ID, subdomain: 'harness' },
        bootstrapNonce: NONCE,
        cloudflareAccessToken: TOKEN,
        transport: async (request: Request) => {
          const response: Response = await payload.processBootstrap(request, environment, storage);
          Object.defineProperty(response, 'url', { configurable: true, value: request.url });
          return response;
        },
        timeoutMs: 120_000,
        nowMs,
      });
      await record.recovery({ target, result, environment: {
        CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID, CLOUDFLARE_ZONE_ID: ZONE_ID, CLOUDFLARE_ZONE_NAME: ZONE_NAME,
        ANKKA_INSTALL_ID: plan.managementOwnershipMarker, ANKKA_GATEWAY_RELEASE: plan.releaseId,
        ANKKA_GATEWAY_RELEASE_SHA256: `sha256:${plan.releaseArtifactSha256}`, ZERO_TRUST_READY: 'true',
      } });
      expect(result.status).toBe('ready');

      const claim = await prepareCustomerBootstrapClaimFromPlan({ plan, target, nowMs: Date.now() });
      const verdict = await payload.verifyBootstrapReceiptProviderStateWithReason(
        { ...claim, cloudflareAccessToken: TOKEN }, environment, storage, Date.now(),
      );
      process.stdout.write('Provider receipt checked.\n');
      expect(verdict).toEqual({ verified: true, reason: null });
      await record.event('installation', 'passed');
    } catch {
      await record.event('installation', 'failed');
      throw new Error('provider_installation_failed_check_diagnostics_and_private_record');
    }
  });
});
