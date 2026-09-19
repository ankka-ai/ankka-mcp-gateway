import { describe, expect, it } from 'vitest';

import { managementTokenCreateLink, managementTokenName } from '../../admin/src/managementTokenLink';
import {
  customerManagementCredentialName, customerManagementCredentialTemplateLink,
} from '../src/customer-management-credential';

// The dashboard offers Cloudflare's create-token link before the approval starts; setup and the paste page offer it
// from the installer's module. One token, one name, one pair of permissions: the two builders must stay equal.
describe('the create-token link', () => {
  it('is the same from the dashboard and from the gateway pages, name included', () => {
    for (const hostname of ['manage.example.com', 'gateway-admin.team.example.org']) {
      expect(managementTokenName(hostname)).toBe(customerManagementCredentialName(hostname));
      expect(managementTokenCreateLink(hostname)).toBe(customerManagementCredentialTemplateLink(hostname));
    }
    const link = new URL(managementTokenCreateLink('manage.example.com'));
    expect(link.origin).toBe('https://dash.cloudflare.com');
    expect(JSON.parse(link.searchParams.get('permissionGroupKeys') ?? 'null')).toEqual([
      { key: 'access', type: 'edit' }, { key: 'mcp_portals', type: 'edit' },
    ]);
  });
});
