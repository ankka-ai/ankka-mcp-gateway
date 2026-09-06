import { CLOUDFLARE_API_ORIGIN } from '../src/constants';
import {
  EXTERNAL_RUNNER_MANAGEMENT_CREDENTIAL_PROVISIONING,
  externalRunnerOperationAuthority,
  type CloudflareApiEndpointFamily,
  type ExternalRunnerOperation,
} from '../src/cloudflare-operation-authority';
import type { FetchTransport } from '../src/oauth';
import type { LifecycleRecord } from '../../../tools/lifecycle-record.mjs';

/**
 * The runner's only path to the network. Provider calls are admitted by the
 * endpoint families of the fixed operations the current stage executes,
 * every call is traced (method, family, status, duration; never a path,
 * token or body), a cancelled job refuses the next mutation before it is
 * sent, and the interruption hook terminates the process abruptly right
 * after a chosen mutation was answered and before any journal records it.
 */
export type RunnerEndpointFamily = CloudflareApiEndpointFamily | 'account-analytics' | 'account-tokens-verify';

export class LifecycleTransportError extends Error {
  constructor(readonly code: 'endpoint_family_refused' | 'origin_refused' | 'job_cancelled', readonly detail: string | null = null) {
    super(code);
    this.name = 'LifecycleTransportError';
  }
}

const ACCOUNT = /^\/client\/v4\/accounts\/[a-f0-9]{32}/u;
const ZONE = /^\/client\/v4\/zones\/[a-f0-9]{32}/u;
const CLASSIFIERS: readonly (readonly [RegExp, RunnerEndpointFamily])[] = [
  [/^\/client\/v4\/accounts\/[a-f0-9]{32}\/tokens\/verify(?:\?|$)/u, 'account-tokens-verify'],
  [/^\/client\/v4\/accounts(?:\?|$)/u, 'accounts-list'],
  [/^\/client\/v4\/zones(?:\?|$)/u, 'zones-list'],
  [/^\/client\/v4\/zones\/[a-f0-9]{32}(?:\?|$)/u, 'zones-list'],
  [/\/dns_records(?:\/|\?|$)/u, 'dns-records'],
  [/\/workers\/subdomain(?:\?|$)/u, 'workers-subdomain'],
  [/\/workers\/scripts\/[^/]+\/subdomain(?:\?|$)/u, 'workers-subdomain'],
  [/\/workers\/domains(?:\/|\?|$)/u, 'workers-custom-domains'],
  [/\/workers\/durable_objects\/namespaces(?:\/|\?|$)/u, 'workers-durable-object-namespaces'],
  [/\/workers\/assets\/|\/assets-upload-session(?:\?|$)/u, 'workers-assets'],
  [/\/workers\/(?:scripts|workers)\/[^/]+\/versions(?:\/|\?|$)/u, 'workers-versions'],
  [/\/workers\/(?:scripts|workers)\/[^/]+\/deployments(?:\/|\?|$)/u, 'workers-deployments'],
  [/\/workers\/(?:scripts|workers)(?:\/|\?|$)/u, 'workers-scripts'],
  [/\/access\/organizations(?:\/|\?|$)/u, 'access-organization'],
  [/\/access\/identity_providers(?:\/|\?|$)/u, 'access-identity-providers'],
  [/\/access\/ai-controls\/mcp\/servers(?:\/|\?|$)/u, 'mcp-servers'],
  [/\/access\/ai-controls\/mcp\/portals(?:\/|\?|$)/u, 'mcp-portals'],
  // Application-attached policies belong to the application family, as the catalogue's source operations expect; reusable policies are their own family.
  [/\/access\/apps\/[^/]+\/policies(?:\/|\?|$)/u, 'access-applications'],
  [/\/access\/policies(?:\/|\?|$)/u, 'access-policies'],
  [/\/access\/apps(?:\/|\?|$)/u, 'access-applications'],
];

export function endpointFamily(url: URL): RunnerEndpointFamily | null {
  const path = `${url.pathname}${url.search}`;
  if (url.pathname === '/client/v4/graphql') return 'account-analytics';
  for (const [pattern, family] of CLASSIFIERS) {
    if (pattern.test(path) && (family === 'accounts-list' || family === 'zones-list' || ACCOUNT.test(path) || ZONE.test(path))) return family;
  }
  return null;
}

/** Families the stage may touch: the union of its fixed operations plus runner-only reads. */
export function stageFamilies(input: {
  readonly operations: readonly ExternalRunnerOperation[];
  readonly provisioning: boolean;
  readonly diagnostics: boolean;
  readonly tokenVerification: boolean;
}): ReadonlySet<RunnerEndpointFamily> {
  const families = new Set<RunnerEndpointFamily>();
  for (const operation of input.operations) {
    for (const family of externalRunnerOperationAuthority(operation).endpointFamilies) families.add(family);
  }
  if (input.provisioning) {
    for (const family of EXTERNAL_RUNNER_MANAGEMENT_CREDENTIAL_PROVISIONING.endpointFamilies) families.add(family);
  }
  if (input.diagnostics) families.add('account-analytics');
  if (input.tokenVerification) families.add('account-tokens-verify');
  return families;
}

export interface GuardedTransportOptions {
  readonly record: LifecycleRecord;
  readonly families: ReadonlySet<RunnerEndpointFamily>;
  /** Extra origins the stage may reach, each with its allowed methods. */
  readonly origins: ReadonlyMap<string, ReadonlySet<string>>;
  /** Answers a request from local material (the control plane served from a publish directory); null to pass through. */
  readonly local: (request: Request) => Promise<Response | null>;
  /** Mutating provider responses to receive before the process terminates itself abruptly; null disables the hook. */
  readonly interruptAfter: number | null;
  readonly realFetch: typeof fetch;
  readonly terminate: () => never;
}

export interface GuardedTransport {
  readonly transport: FetchTransport;
  mutations(): number;
}

const READ_METHODS = new Set(['GET', 'HEAD']);

export function createGuardedTransport(options: GuardedTransportOptions): GuardedTransport {
  let mutations = 0;
  const transport: FetchTransport = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin === CLOUDFLARE_API_ORIGIN) {
      const family = endpointFamily(url);
      if (family === null || !options.families.has(family)) {
        throw new LifecycleTransportError('endpoint_family_refused', family ?? 'unknown');
      }
      const mutating = !READ_METHODS.has(request.method);
      if (mutating && await options.record.cancelRequested()) throw new LifecycleTransportError('job_cancelled');
      const started = performance.now();
      let response: Response;
      try {
        response = await options.realFetch(request);
      } catch (error) {
        await options.record.trace({ method: request.method, family, status: 'transport_error', ms: Math.round(performance.now() - started) });
        throw error;
      }
      await options.record.trace({ method: request.method, family, status: response.status, ms: Math.round(performance.now() - started) });
      if (mutating) {
        mutations += 1;
        if (options.interruptAfter !== null && mutations >= options.interruptAfter) options.terminate();
      }
      return response;
    }
    const local = await options.local(request);
    if (local !== null) return local;
    if (options.origins.get(url.origin)?.has(request.method) === true) return options.realFetch(request);
    throw new LifecycleTransportError('origin_refused');
  };
  return { transport, mutations: () => mutations };
}
