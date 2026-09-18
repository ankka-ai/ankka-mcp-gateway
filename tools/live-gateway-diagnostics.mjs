import * as v from 'valibot';
import { NAVIGATION_FAILURES } from './live-gateway-origin.mjs';
// Only fixed labels and numeric aggregates leave this boundary. Never emit raw
// provider errors, request URLs, headers, cookies, bodies, or resource IDs.
const stages = new Set(['preflight', 'access', 'installer_deployment', 'installation', 'source_draft', 'source_apply',
  'team_grant', 'team_remove', 'inventory', 'update', 'interrupted_removal', 'dependency_removal', 'root_removal', 'recovery']);
const mutations = new Set(['installer_deployment', 'installation', 'source_draft', 'source_apply', 'team_grant', 'team_remove', 'update', 'dependency_removal', 'root_removal']);
const numeric = (value) => v.is(v.pipe(v.number(), v.finite(), v.minValue(0)), value) ? value : null;
export function sanitizeRuntimeMetrics(rows) {
  if (!Array.isArray(rows) || rows.length > 100) return null;
  return rows.map((row) => ({
    requests: numeric(row?.sum?.requests), errors: numeric(row?.sum?.errors), subrequests: numeric(row?.sum?.subrequests),
    cpuTimeP50: numeric(row?.quantiles?.cpuTimeP50), cpuTimeP99: numeric(row?.quantiles?.cpuTimeP99),
    memoryUsageBytesP99: numeric(row?.quantiles?.memoryUsageBytesP99),
  }));
}
export async function lifecycleFailureReport({ events, failureCode, httpStatus, navigation = null, metrics }) {
  const last = events.findLast((event) => stages.has(event.stage));
  const pending = events.findLast((event) => mutations.has(event.stage) && ['started', 'recorded', 'receipt_saved'].includes(event.status));
  const provision = events.findLast((event) => event.provision)?.provision;
  let runtimeMetrics = null;
  if (metrics && provision) {
    try { runtimeMetrics = sanitizeRuntimeMetrics(await metrics(provision)); } catch { /* Diagnosis must not replace the original failure. */ }
  }
  return {
    schemaVersion: 1, httpStatus: Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? httpStatus : null, failedStage: last?.stage ?? 'preflight', failureCode,
    navigation: navigationFailureLabel(navigation),
    lastMutationStage: pending?.stage ?? null,
    removalReceiptAvailable: events.some((event) => event.stage === 'root_removal' && event.status === 'receipt_saved'),
    tabsReopened: tabReopenings(events),
    dependencyRemoval: dependencyRemovalSummary(events),
    rootRemoval: rootRemovalSummary(events),
    recovery: 'inspect_private_journal_before_retry',
    metricsStatus: runtimeMetrics === null ? 'unavailable' : 'available', runtimeMetrics,
  };
}

const label = (value) => v.is(v.pipe(v.string(), v.regex(/^[a-z_]{1,32}$/u)), value) ? value : null;

/** Why a `navigation_failed` stop happened, within the fixed vocabulary; null outside it and for every other stop. */
export const navigationFailureLabel = (value) => NAVIGATION_FAILURES.includes(value) ? value : null;

/** How many times the runner replaced a test tab the browser had discarded or crashed, from the journal. */
export const tabReopenings = (events) => events.filter((event) => event.stage === 'browser' && event.status === 'tab_reopened').length;

/** The consented dependency-removal rounds: how many were opened, the last one's status and fixed failure code,
 * where the test tab landed after it, so a receipt lost on its way can be told from a consent the gateway refused,
 * and whether the runner carried the receipt by API after the edge refused the browser's hop. */
export function dependencyRemovalSummary(events) {
  const rounds = events.filter((event) => event.stage === 'dependency_removal' && event.status === 'recorded').length;
  const last = events.findLast((event) => event.stage === 'dependency_removal' && ['recovery_required', 'failed', 'succeeded'].includes(event.status));
  if (rounds === 0 && last === undefined) return null;
  const landing = last?.landing ?? null;
  return { rounds, lastStatus: last?.status ?? null, lastFailureCode: label(last?.failureCode),
    lastLanding: landing === null ? null : { site: label(landing.site), page: label(landing.page), result: label(landing.result), reason: label(landing.reason) },
    lastReceiptImport: label(last?.receiptImport) };
}

/** The hosted root job's recorded outcome: its status, the steps done, the fixed reason word and the revocation flag; null before any outcome. */
export function rootRemovalSummary(events) {
  const outcome = events.findLast((event) => event.stage === 'root_removal' && ['failed', 'removed_revocation_unconfirmed', 'not_verified', 'passed'].includes(event.status));
  if (outcome === undefined) return null;
  return { status: outcome.status, stepsDone: Number.isInteger(outcome.stepsDone) ? outcome.stepsDone : outcome.status === 'passed' ? 5 : null,
    stepCount: Number.isInteger(outcome.stepCount) ? outcome.stepCount : outcome.status === 'passed' ? 5 : null,
    failureReason: v.is(v.string(), outcome.failureReason) ? outcome.failureReason : null,
    complete: outcome.status === 'passed' || outcome.complete === true, revocationUnconfirmed: outcome.revocationUnconfirmed === true };
}

/** The shell cannot perform browser Access login when certifying its signed
 * configuration. Invalid input must reach the application's JSON rejection. */
export async function checkSignedConfigurationEndpoint(origin, transport = fetch) {
  try {
    const r = await transport(new URL('/api/bootstrap/configure', origin).href, {
      method: 'POST', body: '{}', headers: { 'content-type': 'application/json' },
      redirect: 'manual', signal: AbortSignal.timeout(10_000),
    });
    await r.body?.cancel();
    if (r.status >= 300 && r.status < 400) return 'configuration_endpoint_requires_browser_login';
    if (r.status !== 400 || !r.headers.get('content-type')?.includes('application/json')) return 'configuration_endpoint_unexpected_response';
    return null;
  } catch { return 'configuration_endpoint_unreachable'; }
}
