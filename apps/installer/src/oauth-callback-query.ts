/**
 * Cloudflare's authorization server redirects back with `code` and `state`
 * and echoes the granted `scope` beside them; a denial carries `error` with
 * the standard description fields instead. Nothing else is accepted, and an
 * echoed scope must be exactly the operation's scope set.
 */
const STATE = /^[A-Za-z0-9_-]{43}$/u;
const GRANT_KEYS: ReadonlySet<string> = new Set(['code', 'scope', 'state']);
const DENIAL_KEYS: ReadonlySet<string> = new Set(['error', 'error_description', 'error_uri', 'state']);

export type OauthCallbackQuery =
  | { readonly state: string; readonly code: string; readonly denied: false }
  | { readonly state: string; readonly code: null; readonly denied: true };

/** `undefined` marks a repeated key, which no callback may carry. */
function unique(url: URL, key: string): string | null | undefined {
  const values = url.searchParams.getAll(key);
  return values.length > 1 ? undefined : values[0] ?? null;
}

function echoesExactly(value: string, expectedScopes: readonly string[]): boolean {
  if (value.length > 1_024) return false;
  const values = [...new Set(value.split(/\s+/u).filter(Boolean))].sort();
  const expected = [...expectedScopes].sort();
  return values.length === expected.length && values.every((scope, index) => scope === expected[index]);
}

/** Returns null for any query other than a well-formed grant or denial for `expectedScopes`. */
export function parseOauthCallbackQuery(url: URL, expectedScopes: readonly string[]): OauthCallbackQuery | null {
  const state = unique(url, 'state'), code = unique(url, 'code'), error = unique(url, 'error'), scope = unique(url, 'scope');
  if (state === undefined || code === undefined || error === undefined || scope === undefined) return null;
  if (state === null || !STATE.test(state)) return null;
  const allowed = code !== null ? GRANT_KEYS : DENIAL_KEYS;
  if ([...url.searchParams.keys()].some((key) => !allowed.has(key))) return null;
  if (code !== null) {
    if (code.length < 8 || code.length > 4_096 || (scope !== null && !echoesExactly(scope, expectedScopes))) return null;
    return Object.freeze({ state, code, denied: false });
  }
  if (error === null || error.length < 1 || error.length > 128) return null;
  return Object.freeze({ state, code: null, denied: true });
}
