import { describe, expect, it } from 'vitest';
import { parseOauthCallbackQuery } from '../src/oauth-callback-query';

const STATE = 'A'.repeat(43);
const SCOPES = ['workers-scripts.write', 'zone-access.write'] as const;
const callback = (params: Record<string, string | string[]>) => {
  const url = new URL('https://installer.example/oauth/callback');
  for (const [key, value] of Object.entries(params)) for (const item of [value].flat()) url.searchParams.append(key, item);
  return url;
};

describe('parseOauthCallbackQuery', () => {
  it('accepts a grant with or without the echoed exact scope in any order', () => {
    const plain = parseOauthCallbackQuery(callback({ code: 'authorization-code', state: STATE }), SCOPES);
    expect(plain).toEqual({ state: STATE, code: 'authorization-code', denied: false });
    const echoed = parseOauthCallbackQuery(callback({ code: 'authorization-code', scope: 'zone-access.write  workers-scripts.write', state: STATE }), SCOPES);
    expect(echoed).toEqual(plain);
    expect(Object.isFrozen(echoed)).toBe(true);
  });

  it('accepts a denial with the standard fields only', () => {
    const denied = parseOauthCallbackQuery(callback({ error: 'access_denied', error_description: 'The user denied the request.', state: STATE }), SCOPES);
    expect(denied).toEqual({ state: STATE, code: null, denied: true });
  });

  it.each([
    ['a scope echo that is not the exact operation set', { code: 'authorization-code', scope: 'workers-scripts.write', state: STATE }],
    ['a scope echo with a foreign scope', { code: 'authorization-code', scope: 'workers-scripts.write zone-access.write dns.write', state: STATE }],
    ['an unknown parameter beside the code', { code: 'authorization-code', state: STATE, iss: 'https://dash.cloudflare.com' }],
    ['a code beside an error', { code: 'authorization-code', error: 'access_denied', state: STATE }],
    ['neither code nor error', { state: STATE }],
    ['a repeated state', { code: 'authorization-code', state: [STATE, STATE] }],
    ['a repeated scope', { code: 'authorization-code', scope: ['workers-scripts.write zone-access.write', 'workers-scripts.write zone-access.write'], state: STATE }],
    ['a malformed state', { code: 'authorization-code', state: 'short' }],
    ['a short code', { code: 'abc', state: STATE }],
    ['a scope echo beside a denial', { error: 'access_denied', scope: 'workers-scripts.write zone-access.write', state: STATE }],
    ['an overlong error', { error: 'e'.repeat(129), state: STATE }],
  ])('rejects %s', (_label, params) => {
    expect(parseOauthCallbackQuery(callback(params), SCOPES)).toBeNull();
  });
});
