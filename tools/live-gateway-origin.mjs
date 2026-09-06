import * as v from 'valibot';

/** Origin and identity checks shared by the browser runner and the provider reads; no browser dependency. */
export class LiveGatewayBrowserError extends Error {
  constructor(code, status = null) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

export function validateLiveBrowserOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new LiveGatewayBrowserError('origin_invalid'); }
  if (url.protocol !== 'https:' || url.origin !== value || url.username || url.password) {
    throw new LiveGatewayBrowserError('origin_invalid');
  }
  return url.origin;
}

export function validateLiveBootstrapOrigin(provision) {
  if (!/^acg-[a-f0-9]{24}$/u.test(provision?.installId) ||
      provision.workerName !== `ankka-gateway-${provision.installId}`) {
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

