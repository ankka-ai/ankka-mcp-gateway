// Synthetic local fixture only. Never included in a gateway or installer release.
import { DurableObject } from 'cloudflare:workers';
import { base64UrlDecode, base64UrlEncode } from '../src/crypto';
import { CustomerBootstrapDurableStatePort, initializeCustomerBootstrapSql } from '../src/customer-bootstrap-durable-state';
import {
  consumeCustomerBootstrapCapability, consumeCustomerBootstrapOauthCallback,
  createCustomerBootstrapCapability, CustomerBootstrapStateError,
  initialCustomerBootstrapState, markCustomerBootstrapFinalizing,
  markCustomerBootstrapReady, startCustomerBootstrapOauth,
} from '../src/customer-bootstrap-state';

const now = 1_800_000_000_000;
const bytes = (value: number) => (length: number): Uint8Array => new Uint8Array(length).fill(value);
const sessionSecret = base64UrlEncode(bytes(2)(32));
const oauthState = base64UrlEncode(bytes(3)(32));

interface FixtureEnv { STATE: DurableObjectNamespace }

export class BootstrapFixture extends DurableObject<FixtureEnv> {
  constructor(ctx: DurableObjectState, env: FixtureEnv) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => initializeCustomerBootstrapSql(ctx.storage));
  }

  override async fetch(request: Request): Promise<Response> {
    const port = new CustomerBootstrapDurableStatePort(this.ctx.storage);
    const path = new URL(request.url).pathname;
    try {
      if (path === '/reset') {
        await this.ctx.storage.deleteAll();
        initializeCustomerBootstrapSql(this.ctx.storage);
        return Response.json({ reset: true });
      }
      if (path === '/corrupt') {
        this.ctx.storage.sql.exec('UPDATE ankka_bootstrap_state SET state_json = ?', '{"schemaVersion":1}');
        return Response.json({ corrupted: true });
      }
      if (path === '/rollback') {
        try {
          this.ctx.storage.transactionSync(() => {
            this.ctx.storage.sql.exec('UPDATE ankka_bootstrap_state SET revision = revision + 1');
            throw new Error('synthetic_rollback');
          });
        } catch {
          return Response.json({ rolledBack: true });
        }
      }
      const current = await port.read();
      if (path === '/state') {
        const serialized = JSON.stringify(current);
        return Response.json({
          status: current?.status ?? null, revision: current?.revision ?? null,
          capabilityUnused: current?.capabilityUnused ?? null,
          sessionPresent: current?.session !== null && current?.session !== undefined,
          oauthPhase: current?.oauth?.phase ?? null,
          containsSyntheticSecrets: [base64UrlEncode(bytes(1)(32)), sessionSecret, oauthState]
            .some((secret) => serialized.includes(secret)),
        });
      }
      const capability = await createCustomerBootstrapCapability({ now, randomBytes: bytes(1) });
      if (path === '/seed') {
        const state = initialCustomerBootstrapState({
          installId: `acg-${'a'.repeat(24)}`, ...capability,
        });
        return Response.json({ committed: await port.compareAndSet(null, state) });
      }
      if (!current) return Response.json({ code: 'missing_state' }, { status: 409 });
      if (path === '/race') {
        const contenders = await Promise.all([2, 4].map((value) => consumeCustomerBootstrapCapability({
          current, bootstrapId: capability.bootstrapId, secret: capability.secret,
          now: now + 1, randomBytes: bytes(value),
        })));
        const committed = await Promise.all(contenders.map(({ state }) => port.compareAndSet(current.revision, state)));
        return Response.json({ committed });
      }
      if (path !== '/advance') return Response.json({ code: 'not_found' }, { status: 404 });
      let next;
      if (current.capabilityUnused) {
        next = (await consumeCustomerBootstrapCapability({
          current, bootstrapId: capability.bootstrapId, secret: capability.secret,
          now: now + 1, randomBytes: bytes(2),
        })).state;
      } else if (current.oauth === null) {
        next = (await startCustomerBootstrapOauth({ current, sessionSecret, now: now + 2, randomBytes: bytes(3) })).next;
      } else if (current.oauth.phase === 'authorizing') {
        next = (await consumeCustomerBootstrapOauthCallback({
          current, sessionSecret, attemptId: current.oauth.attemptId, state: oauthState, now: now + 3,
        })).next;
      } else if (current.oauth.phase === 'exchanging') {
        next = markCustomerBootstrapFinalizing({ current, attemptId: current.oauth.attemptId });
      } else {
        next = markCustomerBootstrapReady({ current, attemptId: current.oauth.attemptId, now: now + 4 });
      }
      return Response.json({ committed: await port.compareAndSet(current.revision, next) });
    } catch (error) {
      return Response.json({ code: error instanceof CustomerBootstrapStateError ? error.code : 'fixture_failed' }, { status: 409 });
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/decode') {
      const decoded = base64UrlDecode('YWFh'.repeat(2 * 1024 * 1024));
      return Response.json({ length: decoded.length, first: decoded[0], last: decoded.at(-1) });
    }
    if (url.pathname === '/outbound') return fetch('https://example.com/blocked-fixture');
    // Fixed operations and synthetic values only; no request body is consumed.
    if (!['/state', '/seed', '/advance', '/race', '/rollback', '/corrupt', '/reset'].includes(url.pathname)) {
      return Response.json({ code: 'not_found' }, { status: 404 });
    }
    if (request.method !== (url.pathname === '/state' ? 'GET' : 'POST')) {
      return Response.json({ code: 'method_not_allowed' }, { status: 405 });
    }
    return env.STATE.get(env.STATE.idFromName('synthetic-bootstrap')).fetch(request);
  },
} satisfies ExportedHandler<FixtureEnv>;
