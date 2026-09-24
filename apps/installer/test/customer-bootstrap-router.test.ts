import * as v from 'valibot';

import { base64UrlEncode } from '../src/crypto';
import type { BoundaryValue } from '../src/boundary';
import {
  buildFixedRelayAuthorization,
  relayCloudflareAuthorizationCode,
  relayCloudflareAuthorizationError,
} from '../src/cloudflare-code-relay';
import {
  CUSTOMER_BOOTSTRAP_OAUTH_TTL_MS,
  createCustomerBootstrapCapability,
  type CustomerBootstrapState,
} from '../src/customer-bootstrap-state';
import type { CustomerBootstrapConverge } from '../src/customer-bootstrap-callback';
import { CustomerBootstrapConvergenceDriver } from '../src/customer-bootstrap-convergence-driver';
import {
  createCustomerBootstrapRouter,
  type CustomerBootstrapRouterDependencies,
  type CustomerBootstrapStatePort,
} from '../src/customer-bootstrap-router';
import type { CustomerCloudflareTransport } from '../src/customer-cloudflare-grant';
import type { CustomerGatewayOwnershipStorage } from '../src/customer-gateway-ownership-state';
import {
  CUSTOMER_INSTALL_CONTINUE_PATH,
  CUSTOMER_INSTALL_OAUTH_START_PATH,
  CUSTOMER_INSTALL_STATUS_PATH,
} from '../src/customer-install-paths';
import {
  CLOUDFLARE_MANAGEMENT_PERMISSION_GROUP_KEYS,
  CUSTOMER_INSTALL_MANAGEMENT_STEP_PATH,
  CustomerManagementCredentialHolder,
  createCustomerManagementCredentialStep,
  customerConvergerRunsOnAlarm,
  customerManagementCredentialTemplateLink,
  type CustomerManagementCredentialStep,
} from '../src/customer-management-credential';
import { responseJson } from './boundary';
import { buildStaticDeployPlan, parseDeploySelection } from '../src/schema';
import { manifest, selectionInput } from './fixtures';

const NOW = 1_800_000_000_000;
const ORIGIN = 'https://ankka-gateway-example.customer.workers.dev';
const ACCOUNT_ID = 'a'.repeat(32);
const INSTALL_ID = `acg-${'b'.repeat(24)}`;
const CLIENT_ID = 'c'.repeat(32);
const ACCESS_TOKEN = `token_${'d'.repeat(32)}`;
const RELAY_KEY = base64UrlEncode(new Uint8Array(32).fill(9));
const RELAY_TICKET = `${'r'.repeat(64)}.${'s'.repeat(43)}`;
const HANDOFF = '{"signed":"handoff"}';
const SERIALIZED_PLAN = '{"schemaVersion":1}';
const OWNERSHIP_CERTIFICATE = '{"signed":"certificate"}';
const SESSION_COOKIE = '__Host-ankka_bootstrap_session';
const PKCE_COOKIE = '__Host-ankka_bootstrap_pkce';
const INSTALL_SCOPES = [
  'access-acct.read', 'zone-access.write', 'dns.write', 'mcp-portals.write',
  'workers-routes.read', 'workers-scripts.write', 'zone.read',
];
/** Runs every converger pass inline, the way a host without a per-invocation budget would. */
function inlineConvergence(
  state: CustomerBootstrapStatePort,
  transport: CustomerCloudflareTransport,
  converge: CustomerBootstrapConverge,
  now: () => number = () => NOW + 1,
): CustomerBootstrapRouterDependencies['startConvergence'] {
  const driver = new CustomerBootstrapConvergenceDriver({
    state,
    transport,
    publicClientId: CLIENT_ID,
    converge,
    now,
    schedule: async () => {
      await driver.continue();
    },
  });
  return (input) => driver.start(input);
}

const COMPLETE_CONVERGENCE = Object.freeze({
  verified: true,
  ownershipReceipt: 'complete',
  managementAccess: 'enforced',
  portal: 'converged',
  sourceSet: 'converged',
  finalRuntime: 'active-recovery-capable',
  workersDev: 'disabled',
} as const);

function json(value: BoundaryValue, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function cookieValue(response: Response, name: string): string {
  const values = response.headers.getSetCookie();
  const serialized = values.find((value) => value.startsWith(`${name}=`)) ?? '';
  const pair = serialized.split(';', 1)[0] ?? '';
  if (!pair.startsWith(`${name}=`)) throw new Error(`${name} cookie missing`);
  return pair;
}

function expectPkceCleared(response: Response): void {
  const serialized = response.headers.get('set-cookie') ?? '';
  expect(serialized).toContain(`${PKCE_COOKIE}=; Path=/; Max-Age=0;`);
  expect(serialized).toContain('Secure');
  expect(serialized).toContain('HttpOnly');
  expect(serialized).toContain('SameSite=Lax');
}

function expectSessionCleared(response: Response): void {
  const serialized = response.headers.get('set-cookie') ?? '';
  expect(serialized).toContain(`${SESSION_COOKIE}=; Path=/; Max-Age=0;`);
  expect(serialized).toContain('Secure');
  expect(serialized).toContain('HttpOnly');
  expect(serialized).toContain('SameSite=Lax');
}

interface ArmedAttempt {
  readonly relayState: string;
  readonly stored: () => CustomerBootstrapState | undefined;
  /** Sends the relay's redirect, amended the way a provider or a stray client might, with the attempt's cookies. */
  readonly callback: (location: string, amend: (url: URL) => void) => Promise<Response>;
}

/** Consumes the capability and arms one OAuth attempt: the state a relay callback lands in. */
async function armedAttempt(
  transport: CustomerCloudflareTransport,
  /** Builds the host's convergence start; inline passes that complete at once when absent. */
  convergence?: (state: CustomerBootstrapStatePort) => CustomerBootstrapRouterDependencies['startConvergence'],
): Promise<ArmedAttempt> {
  const capability = await createCustomerBootstrapCapability({ now: NOW });
  let stored: CustomerBootstrapState | undefined;
  const statePort: CustomerBootstrapStatePort = {
    read: async () => stored,
    compareAndSet: async (expectedRevision, state) => {
      if ((stored?.revision ?? null) !== expectedRevision) return false;
      stored = state;
      return true;
    },
  };
  const router = createCustomerBootstrapRouter({
    accountId: ACCOUNT_ID,
    installId: INSTALL_ID,
    bootstrapId: capability.bootstrapId,
    secretCommitment: capability.secretCommitment,
    capabilityExpiresAt: capability.expiresAt,
    publicClientId: CLIENT_ID,
  }, {
    now: () => NOW + 1,
    state: statePort,
    acceptHandoff: async () => undefined,
    issueRelayTicket: async () => ({ relayTicket: RELAY_TICKET, expiresAt: NOW + 120_000 }),
    transport,
    beginRelay: async ({ gatewayState, pkceChallenge, gatewayCallback }) =>
      buildFixedRelayAuthorization({
        clientId: CLIENT_ID,
        relayStateKey: RELAY_KEY,
        gateway: { accountId: ACCOUNT_ID, installId: INSTALL_ID, callback: gatewayCallback },
        operation: 'install', gatewayState, pkceChallenge,
        nonce: base64UrlEncode(new Uint8Array(32).fill(7)), now: NOW + 1,
      }),
    startConvergence: convergence?.(statePort) ?? inlineConvergence(statePort, transport, async () => COMPLETE_CONVERGENCE),
  });
  await router.fetch(new Request(`${ORIGIN}${CUSTOMER_INSTALL_STATUS_PATH}`));
  const continued = await router.fetch(new Request(`${ORIGIN}${CUSTOMER_INSTALL_CONTINUE_PATH}`, {
    method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({
      bootstrapId: capability.bootstrapId,
      secret: capability.secret,
      serializedHandoff: HANDOFF,
      serializedPlan: SERIALIZED_PLAN,
      ownershipCertificate: OWNERSHIP_CERTIFICATE,
    }),
  }));
  const sessionCookie = cookieValue(continued, SESSION_COOKIE);
  const started = await router.fetch(new Request(`${ORIGIN}${CUSTOMER_INSTALL_OAUTH_START_PATH}`, {
    method: 'POST', headers: { origin: ORIGIN, cookie: sessionCookie, 'content-type': 'application/json' },
    body: '{}',
  }));
  const cookies = `${sessionCookie}; ${cookieValue(started, PKCE_COOKIE)}`;
  const { authorizationUrl } = await responseJson(started, v.strictObject({
    schemaVersion: v.literal(1),
    authorizationUrl: v.string(),
  }));
  const relayState = new URL(authorizationUrl).searchParams.get('state');
  if (relayState === null) throw new Error('relay state missing');
  return {
    relayState,
    stored: () => stored,
    callback: (location, amend) => {
      const url = new URL(location);
      amend(url);
      return router.fetch(new Request(url.href, { headers: { cookie: cookies } }));
    },
  };
}

describe('restricted customer bootstrap router', () => {
  it('protects Worker configuration with the consumed session and locks edits during approval', async () => {
    const capability = await createCustomerBootstrapCapability({ now: NOW });
    let stored: CustomerBootstrapState | undefined;
    let clock = NOW + 1;
    let relayStarts = 0;
    const accepted: string[] = [];
    const configured: string[] = [];
    const selection = parseDeploySelection({ ...selectionInput, firstSource: null });
    const publicSetup = { availableZones: [{ id: 'e'.repeat(32), name: 'example.com' }], selection: null, plan: null, expiresAt: capability.expiresAt };
    const router = createCustomerBootstrapRouter({
      accountId: ACCOUNT_ID, installId: INSTALL_ID, bootstrapId: capability.bootstrapId,
      secretCommitment: capability.secretCommitment, capabilityExpiresAt: capability.expiresAt, publicClientId: CLIENT_ID,
    }, {
      now: () => clock,
      state: {
        read: async () => stored,
        compareAndSet: async (revision, next) => {
          if ((stored?.revision ?? null) !== revision) return false;
          stored = next;
          return true;
        },
      },
      transport: async () => { throw new Error('no provider call expected'); },
      acceptHandoff: async () => { throw new Error('no final handoff expected'); },
      acceptSetup: async (permit) => { accepted.push(permit); },
      readSetup: async () => publicSetup,
      configureSetup: async (value) => { configured.push(value.basics.gatewayName); return publicSetup; },
      issueRelayTicket: async () => ({ relayTicket: RELAY_TICKET, expiresAt: clock + 120_000 }),
      beginRelay: async ({ gatewayState, pkceChallenge, gatewayCallback }) => buildFixedRelayAuthorization({
        clientId: CLIENT_ID, relayStateKey: RELAY_KEY,
        gateway: { accountId: ACCOUNT_ID, installId: INSTALL_ID, callback: gatewayCallback }, operation: 'install',
        gatewayState, pkceChallenge, nonce: base64UrlEncode(new Uint8Array(32).fill(++relayStarts)), now: clock,
      }),
      startConvergence: async () => { throw new Error('no grant expected'); },
    });
    expect((await router.fetch(new Request(`${ORIGIN}/__ankka/install/setup`))).status).toBe(403);
    const continued = await router.fetch(new Request(`${ORIGIN}${CUSTOMER_INSTALL_CONTINUE_PATH}`, {
      method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ bootstrapId: capability.bootstrapId, secret: capability.secret, setupPermit: 'signed-permit' }),
    }));
    expect(accepted).toEqual(['signed-permit']);
    const cookie = cookieValue(continued, SESSION_COOKIE);
    const post = (path: string, origin = ORIGIN, body = JSON.stringify(selection)) => router.fetch(new Request(`${ORIGIN}/__ankka/install/${path}`, {
      method: 'POST', headers: { origin, cookie, 'content-type': 'application/json' }, body,
    }));
    expect((await post('configuration', 'https://another.example')).status).toBe(403);
    expect(configured).toHaveLength(0);
    const invalid = await post('configuration', ORIGIN, JSON.stringify({ ...selection, basics: { ...selection.basics, portalHostname: selection.basics.managementHostname } }));
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: 'invalid_configuration', reason: 'gateway_hostnames_invalid' });
    expect((await post('configuration')).status).toBe(200);
    expect(configured).toEqual([selection.basics.gatewayName]);
    const first = await post('oauth/start', ORIGIN, '{}');
    expect(first.status).toBe(200);
    const readSetup = () => router.fetch(new Request(`${ORIGIN}/__ankka/install/setup`, { headers: { cookie } }));
    expect((await readSetup()).status).toBe(409);
    expect((await post('configuration')).status).toBe(409);
    expect(configured).toHaveLength(1);

    // Only a definitely unexchanged, expired attempt can reopen its review.
    const pending = stored;
    if (!pending?.oauth) throw new Error('pending approval missing');
    clock = pending.oauth.expiresAt;
    const expiredApproval = await readSetup();
    expect(expiredApproval.status).toBe(200);
    expect(await expiredApproval.json()).toEqual({ ...publicSetup, approvalExpired: true });
    expect(stored).toEqual(pending);
    expect((await post('configuration')).status).toBe(409);
    expect(configured).toHaveLength(1);

    for (const phase of ['exchanging', 'finalizing'] as const) {
      stored = { ...pending, status: 'CONVERGING', oauth: { ...pending.oauth, phase } };
      const before = structuredClone(stored);
      expect((await readSetup()).status).toBe(409);
      expect((await post('configuration')).status).toBe(409);
      expect(stored).toEqual(before);
    }
    stored = pending;
    const fresh = await post('oauth/start', ORIGIN, '{}');
    expect(fresh.status).toBe(200);
    expect(cookieValue(fresh, PKCE_COOKIE)).not.toBe(cookieValue(first, PKCE_COOKIE));
    expect(stored?.oauth?.attemptId).not.toBe(pending.oauth.attemptId);
    expect(relayStarts).toBe(2);

    // A fresh attempt does not extend the original setup/handoff window.
    clock = capability.expiresAt;
    const beforeExpiryRead = structuredClone(stored);
    expect((await readSetup()).status).toBe(410);
    expect((await post('oauth/start', ORIGIN, '{}')).status).toBe(410);
    expect(stored).toEqual(beforeExpiryRead);
    expect(relayStarts).toBe(2);
  });

  it('runs code relay -> customer exchange -> verify -> revoke and permanently closes bootstrap', async () => {
    const capability = await createCustomerBootstrapCapability({ now: NOW });
    let stored: CustomerBootstrapState | undefined;
    const persisted: string[] = [];
    let convergedWith: string | null = null;
    let revoked = false;
    const transport = async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.endsWith('/oauth2/token')) return json({
        access_token: ACCESS_TOKEN,
        token_type: 'bearer',
        scope: INSTALL_SCOPES.join(' '),
      });
      if (url.startsWith('https://api.cloudflare.com/client/v4/accounts')) {
        return json({ success: true, errors: [], messages: [], result: [{ id: ACCOUNT_ID }] });
      }
      if (url.endsWith('/oauth2/revoke')) {
        revoked = true;
        return json({ revoked: true });
      }
      throw new Error('unexpected request');
    };
    const statePort: CustomerBootstrapStatePort = {
      read: async () => stored,
      compareAndSet: async (expectedRevision, state) => {
        if ((stored?.revision ?? null) !== expectedRevision) return false;
        stored = state;
        persisted.push(JSON.stringify(state));
        return true;
      },
    };
    let managementResolvable = false;
    const resolutions: string[] = [];
    const router = createCustomerBootstrapRouter({
      accountId: ACCOUNT_ID,
      installId: INSTALL_ID,
      bootstrapId: capability.bootstrapId,
      secretCommitment: capability.secretCommitment,
      capabilityExpiresAt: capability.expiresAt,
      publicClientId: CLIENT_ID,
      managementHostname: 'manage.example.com',
    }, {
      now: () => NOW + 1,
      state: statePort,
      transport,
      resolvesManagementHostname: async (hostname) => { resolutions.push(hostname); return managementResolvable; },
      acceptHandoff: async () => undefined,
      issueRelayTicket: async () => ({ relayTicket: RELAY_TICKET, expiresAt: NOW + 120_000 }),
      beginRelay: async ({ gatewayState, pkceChallenge, gatewayCallback }) =>
        buildFixedRelayAuthorization({
          clientId: CLIENT_ID,
          relayStateKey: RELAY_KEY,
          gateway: { accountId: ACCOUNT_ID, installId: INSTALL_ID, callback: gatewayCallback },
          operation: 'install',
          gatewayState,
          pkceChallenge,
          nonce: base64UrlEncode(new Uint8Array(32).fill(8)),
          now: NOW + 1,
        }),
      startConvergence: inlineConvergence(statePort, transport, async (accessToken) => {
        convergedWith = accessToken;
        return COMPLETE_CONVERGENCE;
      }),
    });

    const health = await router.fetch(new Request(`${ORIGIN}${CUSTOMER_INSTALL_STATUS_PATH}`));
    expect(await health.json()).toEqual({ schemaVersion: 1, status: 'INCOMPLETE', canRetry: false });
    const continued = await router.fetch(new Request(`${ORIGIN}${CUSTOMER_INSTALL_CONTINUE_PATH}`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({
        bootstrapId: capability.bootstrapId,
        secret: capability.secret,
        serializedHandoff: HANDOFF,
        serializedPlan: SERIALIZED_PLAN,
        ownershipCertificate: OWNERSHIP_CERTIFICATE,
      }),
    }));
    expect(continued.status).toBe(200);
    const sessionCookie = cookieValue(continued, SESSION_COOKIE);
    const started = await router.fetch(new Request(`${ORIGIN}${CUSTOMER_INSTALL_OAUTH_START_PATH}`, {
      method: 'POST',
      headers: { origin: ORIGIN, cookie: sessionCookie, 'content-type': 'application/json' },
      body: '{}',
    }));
    const startBody = await responseJson(started, v.strictObject({
      schemaVersion: v.literal(1),
      authorizationUrl: v.string(),
    }));
    const pkceSetCookie = started.headers.get('set-cookie') ?? '';
    const pkceCookie = cookieValue(started, PKCE_COOKIE);
    expect(pkceSetCookie).toContain('Path=/');
    expect(pkceSetCookie).toContain('Max-Age=300');
    expect(pkceSetCookie).toContain('Secure');
    expect(pkceSetCookie).toContain('HttpOnly');
    expect(pkceSetCookie).toContain('SameSite=Lax');
    expect(pkceSetCookie).not.toContain('Domain=');
    if (stored?.oauth === null || stored?.oauth === undefined) throw new Error('OAuth attempt missing');
    expect(pkceCookie).toContain(`${PKCE_COOKIE}=${stored.oauth.attemptId}.`);
    expect(persisted.join('\n')).not.toContain('"verifier"');
    const callbackCookies = `${sessionCookie}; ${pkceCookie}`;
    const relayState = new URL(startBody.authorizationUrl).searchParams.get('state');
    if (relayState === null) throw new Error('relay state missing');
    const relayed = await relayCloudflareAuthorizationCode({
      code: `code_${'e'.repeat(32)}`,
      state: relayState,
      relayStateKey: RELAY_KEY,
      now: NOW + 2,
    });
    const callbacks = await Promise.all([
      router.fetch(new Request(relayed.location, { headers: { cookie: callbackCookies } })),
      router.fetch(new Request(relayed.location, { headers: { cookie: callbackCookies } })),
    ]);
    for (const response of callbacks) expectPkceCleared(response);
    const callback = callbacks.find((response) => response.status === 200);
    if (callback === undefined) throw new Error('successful callback missing');
    expect(callback.status).toBe(200);
    expectSessionCleared(callback);
    expect(await callback.json()).toEqual({ schemaVersion: 1, status: 'READY', failureCode: null, failureReason: null });
    expect(callbacks.filter((response) => response.status === 200)).toHaveLength(1);
    expect(callbacks.some((response) => response.status === 404 || response.status === 409)).toBe(true);
    expect(convergedWith).toBe(ACCESS_TOKEN);
    expect(revoked).toBe(true);
    expect(stored?.status).toBe('READY');
    expect(persisted.join('\n')).not.toContain(ACCESS_TOKEN);
    expect(persisted.join('\n')).not.toContain(capability.secret);
    expect(persisted.join('\n')).not.toContain('"verifier"');

    const callbackReplay = await router.fetch(new Request(relayed.location, {
      headers: { cookie: callbackCookies },
    }));
    expect(callbackReplay.status).toBe(404);
    expectPkceCleared(callbackReplay);
    expectSessionCleared(callbackReplay);

    const replay = await router.fetch(new Request(`${ORIGIN}${CUSTOMER_INSTALL_OAUTH_START_PATH}`, {
      method: 'POST',
      headers: { origin: ORIGIN, cookie: sessionCookie, 'content-type': 'application/json' },
      body: '{}',
    }));
    expect(replay.status).toBe(404);
    expect((await router.fetch(new Request(`${ORIGIN}/api/status`))).status).toBe(404);
    // READY is withheld until the management hostname resolves, then remembered.
    expect(await (await router.fetch(new Request(`${ORIGIN}${CUSTOMER_INSTALL_STATUS_PATH}`))).json()).toEqual({
      schemaVersion: 1, status: 'CONVERGING', canRetry: false,
    });
    managementResolvable = true;
    expect(await (await router.fetch(new Request(`${ORIGIN}${CUSTOMER_INSTALL_STATUS_PATH}`))).json()).toEqual({
      schemaVersion: 1, status: 'READY', canRetry: false,
    });
    expect(await (await router.fetch(new Request(`${ORIGIN}${CUSTOMER_INSTALL_STATUS_PATH}`))).json()).toMatchObject({ status: 'READY' });
    expect(resolutions).toEqual(['manage.example.com', 'manage.example.com']);
  });

  it('keeps a multi-account Stage 2 grant INCOMPLETE and revokes it', async () => {
    const capability = await createCustomerBootstrapCapability({ now: NOW });
    let stored: CustomerBootstrapState | undefined;
    let revoked = false;
    let converged = false;
    const statePort: CustomerBootstrapStatePort = {
      read: async () => stored,
      compareAndSet: async (expectedRevision, state) => {
        if ((stored?.revision ?? null) !== expectedRevision) return false;
        stored = state;
        return true;
      },
    };
    const transport: CustomerCloudflareTransport = async (input) => {
      const url = String(input);
      if (url.endsWith('/oauth2/token')) return json({
        access_token: ACCESS_TOKEN, token_type: 'bearer', scope: INSTALL_SCOPES.join(' '),
      });
      if (url.startsWith('https://api.cloudflare.com/client/v4/accounts')) return json({
        success: true,
        errors: [],
        messages: [],
        result: [{ id: ACCOUNT_ID }, { id: 'f'.repeat(32) }],
      });
      if (url.endsWith('/oauth2/revoke')) { revoked = true; return json({ revoked: true }); }
      throw new Error('unexpected request');
    };
    const router = createCustomerBootstrapRouter({
      accountId: ACCOUNT_ID,
      installId: INSTALL_ID,
      bootstrapId: capability.bootstrapId,
      secretCommitment: capability.secretCommitment,
      capabilityExpiresAt: capability.expiresAt,
      publicClientId: CLIENT_ID,
    }, {
      now: () => NOW + 1,
      state: statePort,
      acceptHandoff: async () => undefined,
      issueRelayTicket: async () => ({ relayTicket: RELAY_TICKET, expiresAt: NOW + 120_000 }),
      transport,
      beginRelay: async ({ gatewayState, pkceChallenge, gatewayCallback }) =>
        buildFixedRelayAuthorization({
          clientId: CLIENT_ID,
          relayStateKey: RELAY_KEY,
          gateway: { accountId: ACCOUNT_ID, installId: INSTALL_ID, callback: gatewayCallback },
          operation: 'install', gatewayState, pkceChallenge,
          nonce: base64UrlEncode(new Uint8Array(32).fill(7)), now: NOW + 1,
        }),
      startConvergence: inlineConvergence(statePort, transport, async () => {
        converged = true;
        return COMPLETE_CONVERGENCE;
      }),
    });
    await router.fetch(new Request(`${ORIGIN}${CUSTOMER_INSTALL_STATUS_PATH}`));
    const continued = await router.fetch(new Request(`${ORIGIN}${CUSTOMER_INSTALL_CONTINUE_PATH}`, {
      method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({
        bootstrapId: capability.bootstrapId,
        secret: capability.secret,
        serializedHandoff: HANDOFF,
        serializedPlan: SERIALIZED_PLAN,
        ownershipCertificate: OWNERSHIP_CERTIFICATE,
      }),
    }));
    const sessionCookie = cookieValue(continued, SESSION_COOKIE);
    const started = await router.fetch(new Request(`${ORIGIN}${CUSTOMER_INSTALL_OAUTH_START_PATH}`, {
      method: 'POST', headers: { origin: ORIGIN, cookie: sessionCookie, 'content-type': 'application/json' },
      body: '{}',
    }));
    const pkceCookie = cookieValue(started, PKCE_COOKIE);
    const authorizationUrl = (await responseJson(started, v.strictObject({
      schemaVersion: v.literal(1),
      authorizationUrl: v.string(),
    }))).authorizationUrl;
    const state = new URL(authorizationUrl).searchParams.get('state');
    if (state === null) throw new Error('relay state missing');
    const relayed = await relayCloudflareAuthorizationCode({
      code: `code_${'g'.repeat(32)}`, state, relayStateKey: RELAY_KEY, now: NOW + 2,
    });
    const callback = await router.fetch(new Request(relayed.location, {
      headers: { cookie: `${sessionCookie}; ${pkceCookie}` },
    }));
    expectPkceCleared(callback);
    expect(await callback.json()).toEqual({
      schemaVersion: 1, status: 'INCOMPLETE', failureCode: 'grant_invalid', failureReason: 'grant_account_ambiguous_accounts_2'
    });
    expect(stored).toMatchObject({ status: 'INCOMPLETE', failureCode: 'grant_invalid' });
    expect(revoked).toBe(true);
    expect(converged).toBe(false);
  });

  it('rejects an expired PKCE cookie, clears it, and requires a fresh attempt', async () => {
    const capability = await createCustomerBootstrapCapability({ now: NOW });
    let stored: CustomerBootstrapState | undefined;
    let clock = NOW + 1;
    let relayStarts = 0;
    let tokenExchangeAttempted = false;
    const statePort: CustomerBootstrapStatePort = {
      read: async () => stored,
      compareAndSet: async (expectedRevision, state) => {
        if ((stored?.revision ?? null) !== expectedRevision) return false;
        stored = state;
        return true;
      },
    };
    const transport: CustomerCloudflareTransport = async () => {
      tokenExchangeAttempted = true;
      throw new Error('token exchange must not run for an expired cookie');
    };
    const router = createCustomerBootstrapRouter({
      accountId: ACCOUNT_ID,
      installId: INSTALL_ID,
      bootstrapId: capability.bootstrapId,
      secretCommitment: capability.secretCommitment,
      capabilityExpiresAt: capability.expiresAt,
      publicClientId: CLIENT_ID,
    }, {
      now: () => clock,
      state: statePort,
      acceptHandoff: async () => undefined,
      issueRelayTicket: async () => ({ relayTicket: RELAY_TICKET, expiresAt: clock + 120_000 }),
      transport,
      beginRelay: async ({ gatewayState, pkceChallenge, gatewayCallback }) => {
        relayStarts += 1;
        return buildFixedRelayAuthorization({
          clientId: CLIENT_ID,
          relayStateKey: RELAY_KEY,
          gateway: { accountId: ACCOUNT_ID, installId: INSTALL_ID, callback: gatewayCallback },
          operation: 'install',
          gatewayState,
          pkceChallenge,
          nonce: base64UrlEncode(new Uint8Array(32).fill(relayStarts)),
          now: clock,
        });
      },
      startConvergence: inlineConvergence(statePort, transport, async () => COMPLETE_CONVERGENCE, () => clock),
    });
    await router.fetch(new Request(`${ORIGIN}${CUSTOMER_INSTALL_STATUS_PATH}`));
    const continued = await router.fetch(new Request(`${ORIGIN}${CUSTOMER_INSTALL_CONTINUE_PATH}`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({
        bootstrapId: capability.bootstrapId,
        secret: capability.secret,
        serializedHandoff: HANDOFF,
        serializedPlan: SERIALIZED_PLAN,
        ownershipCertificate: OWNERSHIP_CERTIFICATE,
      }),
    }));
    const sessionCookie = cookieValue(continued, SESSION_COOKIE);
    const started = await router.fetch(new Request(`${ORIGIN}${CUSTOMER_INSTALL_OAUTH_START_PATH}`, {
      method: 'POST',
      headers: { origin: ORIGIN, cookie: sessionCookie, 'content-type': 'application/json' },
      body: '{}',
    }));
    const firstPkceCookie = cookieValue(started, PKCE_COOKIE);
    const authorizationUrl = (await responseJson(started, v.strictObject({
      schemaVersion: v.literal(1),
      authorizationUrl: v.string(),
    }))).authorizationUrl;
    const relayState = new URL(authorizationUrl).searchParams.get('state');
    if (relayState === null) throw new Error('relay state missing');
    const relayed = await relayCloudflareAuthorizationCode({
      code: `code_${'h'.repeat(32)}`,
      state: relayState,
      relayStateKey: RELAY_KEY,
      now: clock + 1,
    });

    clock += CUSTOMER_BOOTSTRAP_OAUTH_TTL_MS + 1;
    const expired = await router.fetch(new Request(relayed.location, {
      headers: { cookie: `${sessionCookie}; ${firstPkceCookie}` },
    }));
    expect(expired.status).toBe(400);
    expectPkceCleared(expired);
    expect(tokenExchangeAttempted).toBe(false);

    const retried = await router.fetch(new Request(`${ORIGIN}${CUSTOMER_INSTALL_OAUTH_START_PATH}`, {
      method: 'POST',
      headers: { origin: ORIGIN, cookie: sessionCookie, 'content-type': 'application/json' },
      body: '{}',
    }));
    expect(retried.status).toBe(200);
    expect(cookieValue(retried, PKCE_COOKIE)).not.toBe(firstPkceCookie);
    expect(relayStarts).toBe(2);
  });

  it('accepts the scope Cloudflare echoes beside the relayed code and rejects any other echo or parameter without spending the attempt', async () => {
    let exchanges = 0;
    const attempt = await armedAttempt(async (input) => {
      const url = String(input);
      if (url.endsWith('/oauth2/token')) {
        exchanges += 1;
        return json({ access_token: ACCESS_TOKEN, token_type: 'bearer', scope: INSTALL_SCOPES.join(' ') });
      }
      if (url.startsWith('https://api.cloudflare.com/client/v4/accounts')) {
        return json({ success: true, errors: [], messages: [], result: [{ id: ACCOUNT_ID }] });
      }
      if (url.endsWith('/oauth2/revoke')) return json({ revoked: true });
      throw new Error('unexpected request');
    });
    const relayed = await relayCloudflareAuthorizationCode({
      code: `code_${'e'.repeat(32)}`, state: attempt.relayState, relayStateKey: RELAY_KEY, now: NOW + 2,
    });
    const armed = attempt.stored()?.oauth;
    expect(armed).toMatchObject({ phase: 'authorizing' });
    for (const amend of [
      (url: URL) => url.searchParams.set('iss', 'https://dash.cloudflare.com'),
      (url: URL) => url.searchParams.set('scope', 'workers-scripts.write'),
      (url: URL) => url.searchParams.set('scope', [...INSTALL_SCOPES, 'workers-routes.write'].join(' ')),
      (url: URL) => url.searchParams.append('state', url.searchParams.get('state') ?? ''),
    ]) {
      const rejected = await attempt.callback(relayed.location, amend);
      expect(rejected.status).toBe(400);
      expect(await rejected.json()).toEqual({ schemaVersion: 1, error: 'oauth_callback_rejected' });
      expectPkceCleared(rejected);
    }
    expect(exchanges).toBe(0);
    expect(attempt.stored()?.oauth).toEqual(armed);

    const accepted = await attempt.callback(relayed.location, (url) => {
      url.searchParams.set('scope', [...INSTALL_SCOPES].reverse().join('  '));
    });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ schemaVersion: 1, status: 'READY', failureCode: null, failureReason: null });
    expect(exchanges).toBe(1);
    expect(attempt.stored()?.status).toBe('READY');
  });

  it('settles the relay denial with the standard error fields beside it and still rejects any other error', async () => {
    const attempt = await armedAttempt(async () => { throw new Error('a denial must not exchange'); });
    const denial = await relayCloudflareAuthorizationError({
      error: 'access_denied', errorDescription: 'The user denied the request.', errorUri: null,
      state: attempt.relayState, relayStateKey: RELAY_KEY, now: NOW + 2,
    });
    const armed = attempt.stored()?.oauth;
    expect(armed).toMatchObject({ phase: 'authorizing' });
    const foreign = await attempt.callback(denial.location, (url) => url.searchParams.set('error', 'access_denied'));
    expect(foreign.status).toBe(400);
    expect(await foreign.json()).toEqual({ schemaVersion: 1, error: 'oauth_callback_rejected' });
    expect(attempt.stored()?.oauth).toEqual(armed);

    const denied = await attempt.callback(denial.location, (url) => {
      url.searchParams.set('error_description', 'The user denied the request.');
      url.searchParams.set('error_uri', 'https://dash.cloudflare.com/');
    });
    expect(denied.status).toBe(200);
    expectPkceCleared(denied);
    expect(await denied.json()).toEqual({ schemaVersion: 1, status: 'INCOMPLETE', failureCode: 'authorization_rejected' });
    expect(attempt.stored()).toMatchObject({ status: 'INCOMPLETE', failureCode: 'authorization_rejected', oauth: null });
  });
});

describe('management token step of setup', () => {
  // Synthetic values in Cloudflare's two account token forms, assembled at run time.
  const SCANNABLE_VALUE = `cfat_${'Qr8w'.repeat(10)}${'2d'.repeat(4)}`;
  const LEGACY_VALUE = 'Hk-_'.repeat(10);
  const STEP = `${ORIGIN}${CUSTOMER_INSTALL_MANAGEMENT_STEP_PATH}`;

  class MemoryStorage implements CustomerGatewayOwnershipStorage {
    readonly values = new Map<string, unknown>();

    async get<Value = unknown>(key: string): Promise<Value | undefined> {
      // SAFETY: the storage contract lets the caller name the stored type; the map holds exactly what put() stored.
      return structuredClone(this.values.get(key)) as Value | undefined;
    }

    async put<Value>(key: string, value: Value): Promise<void> {
      this.values.set(key, structuredClone(value));
    }
  }

  async function reviewedSetup(options: { readonly step?: CustomerManagementCredentialStep | null } = {}) {
    const capability = await createCustomerBootstrapCapability({ now: NOW });
    const selection = parseDeploySelection({ ...selectionInput, firstSource: null });
    const plan = await buildStaticDeployPlan(selection, manifest, NOW + 60 * 60_000);
    const storage = new MemoryStorage();
    const clock = { now: NOW + 1 };
    const holder = new CustomerManagementCredentialHolder(() => clock.now);
    let stored: CustomerBootstrapState | undefined;
    const persisted: string[] = [];
    let configured = false;
    const publicSetup = () => ({
      availableZones: [{ id: 'e'.repeat(32), name: 'example.com' }],
      selection: configured ? selection : null, plan: configured ? plan : null, expiresAt: capability.expiresAt,
    });
    const step = options.step === null ? undefined : options.step ?? createCustomerManagementCredentialStep(holder, storage);
    const dependencies: CustomerBootstrapRouterDependencies = {
      now: () => clock.now,
      state: {
        read: async () => stored,
        compareAndSet: async (revision, next) => {
          if ((stored?.revision ?? null) !== revision) return false;
          stored = next;
          persisted.push(JSON.stringify(next));
          return true;
        },
      },
      transport: async () => { throw new Error('no provider call expected'); },
      acceptHandoff: async () => { throw new Error('no final handoff expected'); },
      acceptSetup: async () => undefined,
      readSetup: async () => publicSetup(),
      configureSetup: async () => { configured = true; return publicSetup(); },
      issueRelayTicket: async () => ({ relayTicket: RELAY_TICKET, expiresAt: clock.now + 120_000 }),
      beginRelay: async ({ gatewayState, pkceChallenge, gatewayCallback }) => buildFixedRelayAuthorization({
        clientId: CLIENT_ID, relayStateKey: RELAY_KEY,
        gateway: { accountId: ACCOUNT_ID, installId: INSTALL_ID, callback: gatewayCallback }, operation: 'install',
        gatewayState, pkceChallenge, nonce: base64UrlEncode(new Uint8Array(32).fill(5)), now: clock.now,
      }),
      startConvergence: async () => { throw new Error('no grant expected'); },
    };
    const router = createCustomerBootstrapRouter({
      accountId: ACCOUNT_ID, installId: INSTALL_ID, bootstrapId: capability.bootstrapId,
      secretCommitment: capability.secretCommitment, capabilityExpiresAt: capability.expiresAt, publicClientId: CLIENT_ID,
    }, step === undefined ? dependencies : { ...dependencies, managementCredential: step });
    // Every answer of the router, bodies and headers, for the leak check at the end.
    const answers: string[] = [];
    const send = async (request: Request): Promise<Response> => {
      const response = await router.fetch(request);
      answers.push(JSON.stringify([...response.headers]), await response.clone().text());
      return response;
    };
    const continued = await send(new Request(`${ORIGIN}${CUSTOMER_INSTALL_CONTINUE_PATH}`, {
      method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ bootstrapId: capability.bootstrapId, secret: capability.secret, setupPermit: 'signed-permit' }),
    }));
    const cookie = cookieValue(continued, SESSION_COOKIE);
    const post = (path: string, body: string) => send(new Request(`${ORIGIN}/__ankka/install/${path}`, {
      method: 'POST', headers: { origin: ORIGIN, cookie, 'content-type': 'application/json' }, body,
    }));
    const paste = (body: BoundaryValue) => post('management-token', JSON.stringify(body));
    const readSetup = () => send(new Request(`${ORIGIN}/__ankka/install/setup`, { headers: { cookie } }));
    return {
      capability, clock, cookie, holder, storage, selection, send, post, paste, readSetup,
      stored: () => stored,
      /** Everything durable or answered so far, as text. */
      observable: () => [...answers, ...persisted, JSON.stringify([...storage.values])].join('\n'),
    };
  }

  it('shows the step with the exact template link once the plan names the management hostname', async () => {
    const test = await reviewedSetup();
    expect(await (await test.readSetup()).json()).toMatchObject({
      plan: null, managementCredential: { state: null, name: null, createUrl: null },
    });
    const configured = await test.post('configuration', JSON.stringify(test.selection));
    expect(configured.status).toBe(200);
    const step = (await responseJson(configured, v.looseObject({
      managementCredential: v.strictObject({ state: v.null(), name: v.string(), createUrl: v.string() }),
    }))).managementCredential;
    expect(step.name).toBe('Ankka gateway manage.example.com');
    expect(step.createUrl).toBe(customerManagementCredentialTemplateLink('manage.example.com'));
    const link = new URL(step.createUrl);
    expect(`${link.origin}${link.pathname}`).toBe('https://dash.cloudflare.com/');
    expect(link.searchParams.get('to')).toBe('/:account/api-tokens');
    expect(JSON.parse(link.searchParams.get('permissionGroupKeys') ?? '')).toEqual(CLOUDFLARE_MANAGEMENT_PERMISSION_GROUP_KEYS);
    expect(link.searchParams.get('name')).toBe(step.name);
  });

  it('takes a well-formed value once under the setup session, answers one fixed word, and echoes nothing', async () => {
    const test = await reviewedSetup();
    await test.post('configuration', JSON.stringify(test.selection));
    const accepted = await test.paste({ managementToken: SCANNABLE_VALUE });
    expect(accepted.status).toBe(200);
    expect(accepted.headers.get('cache-control')).toBe('no-store');
    expect(accepted.headers.get('referrer-policy')).toBe('no-referrer');
    expect(await accepted.json()).toEqual({ schemaVersion: 1, managementCredential: 'held' });
    expect(test.holder.value()).toBe(SCANNABLE_VALUE);
    expect(await (await test.readSetup()).json()).toMatchObject({ managementCredential: { state: 'held' } });
    // Storage keeps one fixed word about the choice; the install state is untouched by the step.
    expect([...test.storage.values]).toEqual([
      ['ankka-mcp-gateway/management-credential-choice/v1', { schemaVersion: 1, choice: 'provided' }],
    ]);
    const before = test.stored();
    // A later paste replaces the value; the legacy 40-character form is accepted too.
    expect(await (await test.paste({ managementToken: LEGACY_VALUE })).json()).toEqual({ schemaVersion: 1, managementCredential: 'held' });
    expect(test.holder.value()).toBe(LEGACY_VALUE);
    expect(test.stored()).toEqual(before);
    for (const value of [SCANNABLE_VALUE, LEGACY_VALUE]) expect(test.observable()).not.toContain(value);
    test.holder.release();
  });

  it('requires a held token before starting the final approval', async () => {
    const test = await reviewedSetup();
    await test.post('configuration', JSON.stringify(test.selection));
    const skipped = await test.paste({ skip: true });
    expect(skipped.status).toBe(400);
    expect(await skipped.json()).toEqual({ schemaVersion: 1, error: 'management_token_invalid' });
    const start = await test.post('oauth/start', '{}');
    expect(start.status).toBe(409);
    expect(await start.json()).toEqual({ schemaVersion: 1, error: 'management_token_required' });
    expect(test.holder.value()).toBeUndefined();
    expect(await (await test.readSetup()).json()).toMatchObject({ managementCredential: { state: null } });
  });

  it('refuses every other body with one fixed error and keeps nothing of it', async () => {
    const test = await reviewedSetup();
    await test.post('configuration', JSON.stringify(test.selection));
    const refused: BoundaryValue[] = [
      { managementToken: `cfut_${'a'.repeat(48)}` },
      { managementToken: `cfk_${'a'.repeat(48)}` },
      { managementToken: `${SCANNABLE_VALUE}-` },
      { managementToken: `cfat_${'a'.repeat(65)}` },
      { managementToken: ` ${LEGACY_VALUE}` },
      { managementToken: `Bearer ${LEGACY_VALUE}` },
      { managementToken: '' },
      { managementToken: 7 },
      { managementToken: [SCANNABLE_VALUE] },
      { managementToken: SCANNABLE_VALUE, skip: true },
      { managementToken: SCANNABLE_VALUE, note: 'extra' },
      { skip: false },
      { skip: 'true' },
      {},
      [SCANNABLE_VALUE],
      SCANNABLE_VALUE,
      null,
    ];
    for (const body of refused) {
      const response = await test.paste(body);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ schemaVersion: 1, error: 'management_token_invalid' });
    }
    for (const raw of ['{', '', `{"managementToken":"${SCANNABLE_VALUE}"}${' '.repeat(600)}`]) {
      const response = await test.post('management-token', raw);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ schemaVersion: 1, error: 'management_token_invalid' });
    }
    expect(test.holder.value()).toBeUndefined();
    expect(test.storage.values.size).toBe(0);
    expect(await (await test.readSetup()).json()).toMatchObject({ managementCredential: { state: null } });
    expect(test.observable()).not.toContain(SCANNABLE_VALUE);
    expect(test.observable()).not.toContain(LEGACY_VALUE);
  });

  it('requires the same origin, a JSON body, the setup session, and an address without a query', async () => {
    const test = await reviewedSetup();
    await test.post('configuration', JSON.stringify(test.selection));
    const body = JSON.stringify({ managementToken: SCANNABLE_VALUE });
    const json = { 'content-type': 'application/json' };
    for (const [headers, status, error] of [
      [{ ...json, cookie: test.cookie, origin: 'https://another.example' }, 403, 'forbidden'],
      [{ ...json, cookie: test.cookie }, 403, 'forbidden'],
      [{ ...json, cookie: test.cookie, origin: ORIGIN, 'sec-fetch-site': 'cross-site' }, 403, 'forbidden'],
      [{ cookie: test.cookie, origin: ORIGIN, 'content-type': 'text/plain' }, 403, 'forbidden'],
      [{ ...json, origin: ORIGIN }, 403, 'bootstrap_session_required'],
      [{ ...json, origin: ORIGIN, cookie: `${SESSION_COOKIE}=${'z'.repeat(43)}` }, 409, 'bootstrap_unavailable'],
    ] as const) {
      const response = await test.send(new Request(STEP, { method: 'POST', headers, body }));
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ error });
    }
    // The value has no place in an address: a query is not routed, and neither is a read.
    const session = { ...json, cookie: test.cookie, origin: ORIGIN };
    expect((await test.send(new Request(`${STEP}?managementToken=${SCANNABLE_VALUE}`, { method: 'POST', headers: session, body }))).status).toBe(404);
    expect((await test.send(new Request(STEP, { headers: { cookie: test.cookie } }))).status).toBe(404);
    expect(test.holder.value()).toBeUndefined();
    expect(test.storage.values.size).toBe(0);
    expect(test.observable()).not.toContain(SCANNABLE_VALUE);
  });

  it('locks while an approval or an install runs, reopens with an expired approval, and ends with the setup window', async () => {
    const test = await reviewedSetup();
    await test.post('configuration', JSON.stringify(test.selection));
    await test.paste({ managementToken: SCANNABLE_VALUE });
    expect((await test.post('oauth/start', '{}')).status).toBe(200);
    for (const body of [{ managementToken: LEGACY_VALUE }, { skip: true }]) {
      const locked = await test.paste(body);
      expect(locked.status).toBe(409);
      expect(await locked.json()).toEqual({ schemaVersion: 1, error: 'setup_locked' });
    }
    // The running approval uploads what was chosen before it started.
    expect(test.holder.value()).toBe(SCANNABLE_VALUE);
    const pending = test.stored();
    if (!pending?.oauth) throw new Error('pending approval missing');
    test.clock.now = pending.oauth.expiresAt;
    expect(await (await test.readSetup()).json()).toMatchObject({ approvalExpired: true, managementCredential: { state: 'held' } });
    expect(await (await test.paste({ managementToken: LEGACY_VALUE })).json()).toEqual({ schemaVersion: 1, managementCredential: 'held' });
    expect(test.holder.value()).toBe(LEGACY_VALUE);
    test.clock.now = test.capability.expiresAt;
    const expired = await test.paste({ managementToken: SCANNABLE_VALUE });
    expect(expired.status).toBe(410);
    expect(await expired.json()).toEqual({ schemaVersion: 1, error: 'bootstrap_unavailable' });
    expect(test.holder.value()).toBe(LEGACY_VALUE);
    for (const value of [SCANNABLE_VALUE, LEGACY_VALUE]) expect(test.observable()).not.toContain(value);
    test.holder.release();
  });

  it('never lets a keep-alive tick run a pass while a callback is still exchanging its code', async () => {
    // While a value is held the shell wakes itself by alarm. Such a tick can land inside the callback's exchange,
    // when the state already says CONVERGING and the driver has no grant yet: a pass then would settle the attempt
    // as one whose grant was lost. `unguarded` shows that hazard; the shell's rule closes it.
    for (const guarded of [false, true]) {
      const drivers: CustomerBootstrapConvergenceDriver[] = [];
      let ticks = 0;
      const transport: CustomerCloudflareTransport = async (input) => {
        const url = String(input);
        if (url.endsWith('/oauth2/token')) {
          // The alarm fires here: the code is being exchanged and no grant exists yet.
          const driver = drivers[0];
          if (driver === undefined) throw new Error('driver missing');
          ticks += 1;
          expect(driver.holdsGrant).toBe(false);
          if (!guarded || customerConvergerRunsOnAlarm(true, driver.holdsGrant)) await driver.continue();
          return json({ access_token: ACCESS_TOKEN, token_type: 'bearer', scope: INSTALL_SCOPES.join(' ') });
        }
        if (url.startsWith('https://api.cloudflare.com/client/v4/accounts')) {
          return json({ success: true, errors: [], messages: [], result: [{ id: ACCOUNT_ID }] });
        }
        if (url.endsWith('/oauth2/revoke')) return json({ revoked: true });
        throw new Error('unexpected request');
      };
      const attempt = await armedAttempt(transport, (statePort) => {
        const driver = new CustomerBootstrapConvergenceDriver({
          state: statePort, transport, publicClientId: CLIENT_ID, converge: async () => COMPLETE_CONVERGENCE,
          now: () => NOW + 1, schedule: async () => { await driver.continue(); },
        });
        drivers.push(driver);
        return (input) => driver.start(input);
      });
      const relayed = await relayCloudflareAuthorizationCode({
        code: `code_${'k'.repeat(32)}`, state: attempt.relayState, relayStateKey: RELAY_KEY, now: NOW + 2,
      });
      const callback = await attempt.callback(relayed.location, () => undefined);
      expect(ticks).toBe(1);
      expect(callback.status).toBe(200);
      if (guarded) {
        expect(await callback.json()).toMatchObject({ status: 'READY', failureCode: null });
        expect(attempt.stored()).toMatchObject({ status: 'READY' });
      } else {
        expect(await callback.json()).toMatchObject({ status: 'INCOMPLETE', failureReason: 'grant_lost' });
      }
      expect(drivers[0]?.holdsGrant).toBe(false);
    }
    // The converger's own alarms always run a pass; a tick does only once the driver holds a grant.
    expect([[false, false], [false, true], [true, false], [true, true]]
      .map(([tick, held]) => customerConvergerRunsOnAlarm(tick === true, held === true)))
      .toEqual([true, true, false, true]);
  });

  it('answers a failing host with the fixed unavailable error, and offers no step where the host has none', async () => {
    const failing = await reviewedSetup({ step: {
      accept: async () => { throw new Error(`storage refused ${SCANNABLE_VALUE}`); },
      word: async () => undefined,
    } });
    const response = await failing.paste({ managementToken: SCANNABLE_VALUE });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ schemaVersion: 1, error: 'bootstrap_unavailable' });
    expect(failing.observable()).not.toContain(SCANNABLE_VALUE);

    const without = await reviewedSetup({ step: null });
    expect((await without.paste({ managementToken: SCANNABLE_VALUE })).status).toBe(404);
    expect(await (await without.readSetup()).json()).not.toHaveProperty('managementCredential');
    expect(without.observable()).not.toContain(SCANNABLE_VALUE);
  });
});
