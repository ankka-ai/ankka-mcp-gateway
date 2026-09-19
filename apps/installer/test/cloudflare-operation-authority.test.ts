import {
  CLOUDFLARE_OAUTH_SCOPE,
  CLOUDFLARE_OPERATION_MUTATIONS,
  CLOUDFLARE_OPERATION_POSTCONDITIONS,
  CUSTOMER_CLOUDFLARE_OPERATIONS,
  FIXED_CLOUDFLARE_OPERATIONS,
  LATER_CUSTOMER_CLOUDFLARE_OPERATIONS,
  exactOperationScopes,
  fixedCloudflareOperationAuthority,
  isCustomerCloudflareOperation,
  isFixedCloudflareOperation,
  uninstallScopesForReceipt,
} from '../src/cloudflare-operation-authority';

describe('fixed Cloudflare OAuth operation authority', () => {
  it('adds zone discovery to Stage 1 without widening release or removal grants', () => {
    const bootstrap = fixedCloudflareOperationAuthority('bootstrap');
    expect(bootstrap).toMatchObject({
      operation: 'bootstrap',
      executor: 'ankka-installer',
      enabled: true,
      scopes: ['workers-scripts.write', 'zone.read'],
      workerRelease: {
        mutationPath: 'direct-script-upload',
        activation: 'implicit-with-direct-upload',
        versionEndpoint: 'read-only',
        deploymentEndpoint: 'read-only',
      },
      credentialLifecycle: {
        storage: 'request-memory-only',
        refreshTokens: false,
        revoke: 'attempt-after-success-or-failure',
        discard: 'always',
        retry: 'fresh-authorization',
      },
    });
    expect(bootstrap.endpointFamilies).toContain('workers-subdomain');
    expect(bootstrap.endpointFamilies).toContain('workers-scripts');
    expect(bootstrap.mutations).toContain('enable-workers-dev');
    expect(bootstrap.mutations).toContain('delete-bootstrap-worker');
    expect(bootstrap.mutations).toContain('delete-bootstrap-admin-state-namespace');
    expect(bootstrap.postconditions).toContain('workers-dev-enabled-temporarily');
  });

  it('has the exhaustive fixed operation catalogue and no generic authority', () => {
    expect(FIXED_CLOUDFLARE_OPERATIONS).toEqual([
      'bootstrap', 'install', 'upgrade', 'rollback', 'source-add', 'bigquery-add', 'source-update',
      'source-remove', 'management-credential', 'uninstall', 'uninstall-finalize', 'gateway-root-finalize',
    ]);
    expect(isFixedCloudflareOperation('install')).toBe(true);
    expect(isFixedCloudflareOperation('source-remove')).toBe(true);
    expect(isFixedCloudflareOperation('uninstall-finalize')).toBe(true);
    expect(isCustomerCloudflareOperation('uninstall')).toBe(true);
    expect(isCustomerCloudflareOperation('uninstall-finalize')).toBe(false);
    expect(isFixedCloudflareOperation('policy-sync')).toBe(false);
    expect(isFixedCloudflareOperation('generic-repair')).toBe(false);
  });

  it('fixes endpoint, ownership, mutation, postcondition, and credential boundaries', () => {
    const install = fixedCloudflareOperationAuthority('install');
    expect(install.endpointFamilies).toEqual(expect.arrayContaining([
      'accounts-list', 'zones-list', 'workers-scripts', 'workers-versions', 'access-applications',
      'access-policies', 'mcp-servers', 'mcp-portals', 'dns-records',
    ]));
    expect(install.workerRelease).toEqual({
      mutationPath: 'direct-script-upload',
      activation: 'implicit-with-direct-upload',
      versionEndpoint: 'read-only',
      deploymentEndpoint: 'read-only',
    });
    expect(install.ownershipStates).toEqual([
      'same-installation-bootstrap', 'same-installation-incomplete', 'receipt-owned',
    ]);
    expect(install.mutations).toEqual(expect.arrayContaining([
      'create-final-resources', 'resume-final-resource-convergence', 'activate-worker-release',
      'disable-workers-dev',
    ]));
    expect(install.postconditions).toEqual(expect.arrayContaining([
      'ownership-receipt-complete', 'bootstrap-surface-dead', 'workers-dev-disabled',
    ]));

    for (const operation of ['source-add', 'source-update', 'source-remove'] as const) {
      const source = fixedCloudflareOperationAuthority(operation);
      expect(source.scopes).toEqual(['zone-access.write', 'mcp-portals.write']);
      expect(source.endpointFamilies).toEqual([
        'accounts-list', 'access-applications', 'mcp-servers', 'mcp-portals',
      ]);
      expect(source.ownershipStates).toEqual(['receipt-owned']);
      expect(source.workerRelease).toEqual({
        mutationPath: 'none',
        activation: 'none',
        versionEndpoint: 'none',
        deploymentEndpoint: 'none',
      });
    }
  });

  it('adds only the demonstrated read scope for zone discovery', () => {
    expect(fixedCloudflareOperationAuthority('install').scopes).toEqual([
      'access-acct.read', 'zone-access.write', 'dns.write', 'mcp-portals.write',
      'workers-routes.read', 'workers-scripts.write', 'zone.read',
    ]);
    const scopes = FIXED_CLOUDFLARE_OPERATIONS.flatMap((operation) =>
      fixedCloudflareOperationAuthority(operation).scopes,
    );
    for (const forbidden of [
      'memberships.read', 'user-details.read', 'account-settings.read',
      'access-acct.write', 'access.write', 'offline_access', 'openid',
    ]) {
      expect(scopes).not.toContain(forbidden);
    }
  });

  it('derives uninstall authority only from receipt-owned resource types', () => {
    expect(uninstallScopesForReceipt([
      'worker', 'durable_object_namespace', 'worker_custom_domain', 'mcp_portal',
      'access_application', 'dns_record',
    ])).toEqual([
      CLOUDFLARE_OAUTH_SCOPE.dnsWrite,
      CLOUDFLARE_OAUTH_SCOPE.mcpPortalsWrite,
      CLOUDFLARE_OAUTH_SCOPE.workersScriptsWrite,
      CLOUDFLARE_OAUTH_SCOPE.accessAppsAndPoliciesWrite,
    ]);
    expect(exactOperationScopes('uninstall', ['worker'])).toEqual(['workers-scripts.write']);
    expect(exactOperationScopes('uninstall')).toEqual([]);
  });

  it('splits customer uninstall from the receipt-bound hosted root finalizer', () => {
    expect(fixedCloudflareOperationAuthority('uninstall')).toMatchObject({
      executor: 'customer-gateway',
      scopes: [
        'zone-access.write', 'dns.write', 'mcp-portals.write', 'workers-scripts.write',
      ],
      mutations: [
        'delete-receipt-resource', 'publish-inert-worker-release',
        'activate-worker-release', 'disable-workers-dev',
      ],
      postconditions: [
        'dependent-receipt-resources-absent', 'inert-worker-release-active',
        'workers-dev-disabled', 'foreign-resources-unchanged',
      ],
    });
    expect(fixedCloudflareOperationAuthority('uninstall-finalize')).toMatchObject({
      executor: 'ankka-installer',
      scopes: ['workers-scripts.write'],
      workerRelease: {
        mutationPath: 'none',
        activation: 'none',
        versionEndpoint: 'none',
        deploymentEndpoint: 'read-only',
      },
      mutations: ['delete-root-worker', 'delete-admin-state-namespace'],
      postconditions: ['receipt-resources-absent', 'foreign-resources-unchanged'],
    });
    expect(fixedCloudflareOperationAuthority('gateway-root-finalize')).toMatchObject({
      executor: 'ankka-installer', scopes: ['workers-scripts.write', 'zone-access.write'],
      workerRelease: { mutationPath: 'direct-script-upload', versionEndpoint: 'read-only' },
      mutations: ['publish-inert-worker-release', 'delete-receipt-resource', 'delete-root-worker', 'delete-admin-state-namespace'],
    });
    expect(isCustomerCloudflareOperation('gateway-root-finalize')).toBe(false);
  });

  it('lets a gateway write its own management secret with the scripts scope and nothing else', () => {
    // The whole entry, not a subset: a second scope, family, mutation or an upload path would widen the consent.
    expect(fixedCloudflareOperationAuthority('management-credential')).toEqual({
      operation: 'management-credential',
      executor: 'customer-gateway',
      enabled: true,
      scopes: [CLOUDFLARE_OAUTH_SCOPE.workersScriptsWrite],
      workerRelease: { mutationPath: 'none', activation: 'none', versionEndpoint: 'none', deploymentEndpoint: 'none' },
      endpointFamilies: ['workers-scripts'],
      ownershipStates: ['receipt-owned'],
      mutations: ['write-worker-secret'],
      postconditions: ['management-secret-write-accepted'],
      credentialLifecycle: {
        storage: 'request-memory-only', refreshTokens: false, revoke: 'attempt-after-success-or-failure',
        discard: 'always', retry: 'fresh-authorization',
      },
    });
    expect(exactOperationScopes('management-credential')).toEqual(['workers-scripts.write']);
    expect(isCustomerCloudflareOperation('management-credential')).toBe(true);
    expect(CUSTOMER_CLOUDFLARE_OPERATIONS).toContain('management-credential');
    expect(LATER_CUSTOMER_CLOUDFLARE_OPERATIONS).toContain('management-credential');
    expect(CLOUDFLARE_OPERATION_MUTATIONS).toContain('write-worker-secret');
    expect(CLOUDFLARE_OPERATION_POSTCONDITIONS).toContain('management-secret-write-accepted');
  });

  it('gives no other customer operation the secret write, and changes none of their consents', () => {
    // The scope sets every consent is derived from, as they were before this operation existed.
    const before = {
      install: ['access-acct.read', 'zone-access.write', 'dns.write', 'mcp-portals.write', 'workers-routes.read', 'workers-scripts.write', 'zone.read'],
      upgrade: ['workers-scripts.write'],
      rollback: ['workers-scripts.write'],
      'source-add': ['zone-access.write', 'mcp-portals.write'],
      'bigquery-add': ['zone-access.write', 'mcp-portals.write', 'workers-scripts.write', 'workers-routes.read'],
      'source-update': ['zone-access.write', 'mcp-portals.write'],
      'source-remove': ['zone-access.write', 'mcp-portals.write'],
    };
    for (const operation of CUSTOMER_CLOUDFLARE_OPERATIONS) {
      if (operation === 'management-credential' || operation === 'uninstall') continue;
      expect(exactOperationScopes(operation), operation).toEqual(before[operation]);
      expect(fixedCloudflareOperationAuthority(operation).mutations, operation).not.toContain('write-worker-secret');
    }
    expect(Object.keys(before).sort()).toEqual(CUSTOMER_CLOUDFLARE_OPERATIONS
      .filter((operation) => operation !== 'management-credential' && operation !== 'uninstall').sort());
  });

  it('freezes every authority boundary', () => {
    for (const operation of FIXED_CLOUDFLARE_OPERATIONS) {
      const authority = fixedCloudflareOperationAuthority(operation);
      expect(Object.isFrozen(authority)).toBe(true);
      expect(Object.isFrozen(authority.scopes)).toBe(true);
      expect(Object.isFrozen(authority.workerRelease)).toBe(true);
      expect(Object.isFrozen(authority.endpointFamilies)).toBe(true);
      expect(Object.isFrozen(authority.ownershipStates)).toBe(true);
      expect(Object.isFrozen(authority.mutations)).toBe(true);
      expect(Object.isFrozen(authority.postconditions)).toBe(true);
      expect(Object.isFrozen(authority.credentialLifecycle)).toBe(true);
    }
  });
});

describe('external runner authority', () => {
  it('reuses every fixed boundary and changes only the executor and credential lifecycle', async () => {
    const { EXTERNAL_RUNNER_OPERATIONS, externalRunnerOperationAuthority, isExternalRunnerOperation,
      OPERATOR_MANAGED_CREDENTIAL_LIFECYCLE } = await import('../src/cloudflare-operation-authority');
    expect(EXTERNAL_RUNNER_OPERATIONS).toEqual(['bootstrap', 'install', 'upgrade', 'uninstall', 'uninstall-finalize', 'gateway-root-finalize']);
    for (const operation of EXTERNAL_RUNNER_OPERATIONS) {
      const fixed = fixedCloudflareOperationAuthority(operation);
      const runner = externalRunnerOperationAuthority(operation);
      expect(runner).toMatchObject({
        operation, executor: 'external-runner', scopes: fixed.scopes, endpointFamilies: fixed.endpointFamilies,
        ownershipStates: fixed.ownershipStates, mutations: fixed.mutations, postconditions: fixed.postconditions,
        credentialLifecycle: {
          storage: 'operator-credential-store', refreshTokens: false, revoke: 'never-by-operation',
          discard: 'at-process-exit', retry: 'operator-resume',
        },
      });
      expect(Object.isFrozen(runner)).toBe(true);
      expect(fixed.credentialLifecycle.storage).toBe('request-memory-only');
    }
    expect(Object.isFrozen(OPERATOR_MANAGED_CREDENTIAL_LIFECYCLE)).toBe(true);
    expect(isExternalRunnerOperation('source-add')).toBe(false);
    expect(isExternalRunnerOperation('rollback')).toBe(false);
  });

  it('keeps management-credential provisioning a runner-only operation on the Workers scripts family', async () => {
    const { EXTERNAL_RUNNER_MANAGEMENT_CREDENTIAL_PROVISIONING } = await import('../src/cloudflare-operation-authority');
    expect(EXTERNAL_RUNNER_MANAGEMENT_CREDENTIAL_PROVISIONING).toMatchObject({
      operation: 'install-management-credential', executor: 'external-runner',
      endpointFamilies: ['workers-scripts'], mutations: ['write-worker-secret'],
      credentialLifecycle: { storage: 'operator-credential-store', revoke: 'never-by-operation' },
    });
    expect(isFixedCloudflareOperation('install-management-credential')).toBe(false);
    expect(isCustomerCloudflareOperation('install-management-credential')).toBe(false);
  });
});
