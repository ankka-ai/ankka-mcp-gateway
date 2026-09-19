import * as v from 'valibot';

/** Origin and identity checks shared by the browser runner and the provider reads, and the fixed vocabulary of a
 * failed navigation shared with the diagnostics; no browser dependency. */
export class LiveGatewayBrowserError extends Error {
  constructor(code, status = null, navigation = null) {
    super(code);
    this.code = code;
    this.status = status;
    /** Why a `navigation_failed` stop happened, as one of NAVIGATION_FAILURES; null for every other code. */
    this.navigation = navigation;
  }
}

/** The fixed reasons a navigation fails: the page or its target is gone (a tab the browser discarded reads as a
 * closed page), the renderer crashed, the navigation timed out, or anything else. Only these labels leave the runner;
 * the error text, which can carry the URL, never does. */
export const NAVIGATION_FAILURES = Object.freeze(['closed', 'crashed', 'timeout', 'other']);

export function validateLiveBrowserOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new LiveGatewayBrowserError('origin_invalid'); }
  if (url.protocol !== 'https:' || url.origin !== value || url.username || url.password) {
    throw new LiveGatewayBrowserError('origin_invalid');
  }
  return url.origin;
}

export function validateLiveBootstrapOrigin(provision) {
  // A bootstrap-plan shell is `ankka-gateway-<installId>`; a static plan adds the gateway's slug before the marker.
  if (!/^acg-[a-f0-9]{24}$/u.test(provision?.installId) ||
      !/^ankka-gateway-(?:[a-z0-9-]+-)?acg-[a-f0-9]{24}$/u.test(provision.workerName ?? '') ||
      !provision.workerName.endsWith(`-${provision.installId}`)) {
    throw new LiveGatewayBrowserError('bootstrap_identity_invalid');
  }
  // The installer publishes its bootstrap base URL with a root slash.
  // Normalize only that documented form; paths, queries and fragments stay invalid.
  const base = provision.bootstrapOrigin;
  const origin = validateLiveBrowserOrigin(v.is(v.string(), base) && base.endsWith('/') ? base.slice(0, -1) : base);
  const labels = new URL(origin).hostname.split('.');
  if (labels.length !== 4 || labels[0] !== provision.workerName ||
      !/^[a-z0-9-]{1,63}$/u.test(labels[1]) || labels.slice(2).join('.') !== 'workers.dev') {
    throw new LiveGatewayBrowserError('bootstrap_identity_invalid');
  }
  return origin;
}

