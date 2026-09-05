import { describe, expect, it } from 'vitest';
import { parseCustomerTeardownFailure } from '../src/customer-teardown-failure';

const legacy = { phase: 'root_remove', resourceKind: 'portal', category: 'provider_auth' };

describe('bounded teardown provider diagnostics', () => {
  it('retains legacy failures and independent optional provider fields', () => {
    expect(parseCustomerTeardownFailure(legacy)).toEqual(legacy);
    for (const providerOperation of ['read', 'list', 'delete']) {
      const failure = { ...legacy, providerOperation };
      expect(parseCustomerTeardownFailure(failure)).toEqual(failure);
    }
    for (const providerHttpStatus of [null, 100, 401, 403, 429, 500, 599]) {
      const failure = { ...legacy, providerHttpStatus };
      expect(parseCustomerTeardownFailure(failure)).toEqual(failure);
    }
  });

  it('refuses unbounded HTTP values, unsupported operations, and provider text', () => {
    for (const providerHttpStatus of [99, 600, 403.5, NaN, Infinity, '403', {}, []]) {
      expect(parseCustomerTeardownFailure({ ...legacy, providerHttpStatus })).toBeNull();
    }
    for (const providerOperation of ['', 'GET', 'post', null, 1, {}]) {
      expect(parseCustomerTeardownFailure({ ...legacy, providerOperation })).toBeNull();
    }
    expect(parseCustomerTeardownFailure({ ...legacy, providerOperation: 'delete', providerHttpStatus: 500,
      providerResponse: 'synthetic private provider response' })).toBeNull();
  });
});
