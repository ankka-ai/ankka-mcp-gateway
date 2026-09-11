import * as v from 'valibot';
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
export async function lifecycleFailureReport({ events, failureCode, httpStatus, metrics }) {
  const last = events.findLast((event) => stages.has(event.stage));
  const pending = events.findLast((event) => mutations.has(event.stage) && ['started', 'recorded', 'receipt_saved'].includes(event.status));
  const provision = events.findLast((event) => event.provision)?.provision;
  let runtimeMetrics = null;
  if (metrics && provision) {
    try { runtimeMetrics = sanitizeRuntimeMetrics(await metrics(provision)); } catch { /* Diagnosis must not replace the original failure. */ }
  }
  return {
    schemaVersion: 1, httpStatus: Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? httpStatus : null, failedStage: last?.stage ?? 'preflight', failureCode,
    lastMutationStage: pending?.stage ?? null,
    removalReceiptAvailable: events.some((event) => event.stage === 'root_removal' && event.status === 'receipt_saved'),
    rootRemoval: rootRemovalSummary(events),
    recovery: 'inspect_private_journal_before_retry',
    metricsStatus: runtimeMetrics === null ? 'unavailable' : 'available', runtimeMetrics,
  };
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
