import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import {
  CLOUDFLARE_MANAGEMENT_PERMISSION_GROUP_KEYS,
  customerManagementCredentialName,
  customerManagementCredentialTemplateLink,
} from '../src/customer-management-credential';
import { customerSetupPage } from '../src/customer-setup-page';

interface PageEvent { preventDefault(): void }

function element() {
  const listeners = new Map<string, (event?: PageEvent) => void>();
  return {
    textContent: '', value: '', href: '', hidden: false, disabled: false,
    replaceChildren: vi.fn(), append: vi.fn(), focus: vi.fn(), listeners,
    addEventListener: (name: string, callback: (event?: PageEvent) => void) => listeners.set(name, callback),
  };
}

async function openPage(fetch: typeof globalThis.fetch) {
  const html = await customerSetupPage().text();
  const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/u.exec(html)?.[1];
  if (!script) throw new Error('setup script missing');
  const nodes = new Map([...html.matchAll(/\bid="([^"]+)"/gu)].map((match) => [match[1], element()]));
  const node = (id: string) => {
    const value = nodes.get(id);
    if (!value) throw new Error('setup element missing');
    return value;
  };
  for (const id of ['setup', 'review', 'no-domains', 'restart', 'credential', 'credential-note', 'credential-change']) node(id).hidden = true;
  const navigate = vi.fn();
  const history = { replaceState: vi.fn() };
  runInNewContext(script, {
    document: {
      getElementById: node, createElement: element,
      querySelectorAll: () => ['approve', 'edit', 'review-button', 'credential-save', 'credential-skip', 'credential-change'].map(node),
    },
    location: { hash: '', assign: navigate }, history,
    fetch, URL,
  });
  /** Everything the page currently shows or links to. */
  const texts = () => [...nodes.values()].map((shown) => `${shown.textContent}\n${shown.value}\n${shown.href}`).join('\n');
  return { node, navigate, html, history, texts };
}

const reviewed = {
  availableZones: [{ name: 'example.com' }],
  selection: { basics: {
    gatewayName: 'Example team', zoneName: 'example.com',
    managementHostname: 'manage.example.com', portalHostname: 'mcp.example.com',
    adminEmail: 'admin@example.com', additionalAdminEmails: [],
  } },
  plan: { managementAdminEmails: ['admin@example.com'], managementResources: [], gatewayResources: [] },
};

describe('customer setup approval recovery', () => {
  it('offers fresh consent for the same reviewed configuration without authorizing automatically', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ ...reviewed, approvalExpired: true }))
      .mockResolvedValueOnce(Response.json({ authorizationUrl: 'https://dash.cloudflare.com/oauth2/auth' }));
    const page = await openPage(fetch);
    await vi.waitFor(() => expect(page.node('approve').textContent).toBe('Start a fresh approval'));
    expect(page.node('edit').hidden).toBe(true);
    expect(page.node('review').hidden).toBe(false);
    expect(page.node('message').textContent).toContain('these same gateway details');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(page.navigate).not.toHaveBeenCalled();

    page.node('approve').listeners.get('click')?.();
    await vi.waitFor(() => expect(page.navigate).toHaveBeenCalledExactlyOnceWith('https://dash.cloudflare.com/oauth2/auth'));
    expect(fetch).toHaveBeenLastCalledWith('/__ankka/install/oauth/start', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      credentials: 'same-origin', cache: 'no-store',
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('keeps ordinary review editable before its first approval', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(reviewed));
    const page = await openPage(fetch);
    await vi.waitFor(() => expect(page.node('approve').textContent).toBe('Approve and finish setup'));
    expect(page.node('edit').hidden).toBe(false);
    expect(page.navigate).not.toHaveBeenCalled();
  });

  it('does not offer a restart for active or potentially applied work', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ error: 'setup_locked' }, { status: 409 }));
    const page = await openPage(fetch);
    await vi.waitFor(() => expect(page.node('message').textContent).toContain('already started'));
    expect(page.node('review').hidden).toBe(true);
    expect(page.navigate).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('explains full setup expiry without claiming the existing gateway was removed', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ error: 'bootstrap_unavailable' }, { status: 410 }));
    const page = await openPage(fetch);
    await vi.waitFor(() => expect(page.node('message').textContent).toContain('review your deployment before starting again'));
    expect(page.node('review').hidden).toBe(true);
    expect(page.node('restart').hidden).toBe(false);
    expect(page.html).toContain('An unfinished gateway may still exist in your Cloudflare account.');
    expect(page.navigate).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('customer setup management token step', () => {
  // A synthetic value in Cloudflare's account token form, assembled at run time.
  const PASTED_VALUE = `cfat_${'Zt6p'.repeat(10)}${'4b'.repeat(4)}`;
  const step = (state: string | null) => ({
    state, name: customerManagementCredentialName('manage.example.com'),
    createUrl: customerManagementCredentialTemplateLink('manage.example.com'),
  });
  const submit = { preventDefault: () => undefined };

  it('says why the token is needed, who can create it, what it can reach, and that it can wait', async () => {
    const html = await customerSetupPage().text();
    expect(html).toContain('<h2 id="credential-heading">Management token</h2>');
    expect(html).toContain('Adding a source or giving a teammate access writes to your Cloudflare account, and the approvals in this setup are temporary.');
    expect(html).toContain('<strong>Access: Apps and Policies Edit</strong> and <strong>MCP Portals Edit</strong>');
    expect(html).toContain('Creating it needs a Super Administrator or Administrator of your Cloudflare account.');
    expect(html).toContain('Cloudflare cannot limit this token to your gateway: it can edit every Access policy in the account.');
    expect(html).toContain('It never passes through anything Ankka hosts.');
    expect(html).toContain('Without the token, adding sources and managing team access stay disabled. You can add it later in Settings.');
    expect(html).toContain('<button id="credential-skip" type="button" class="secondary">Continue without a token</button>');
    // One paste field: not echoed, not remembered, and without a name no form submission could carry.
    const fields = [...html.matchAll(/<input\b[^>]*>/giu)].map((match) => match[0]).filter((field) => field.includes('credential'));
    expect(fields).toEqual([
      '<input id="credential-value" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="64" required>',
    ]);
    expect(html).not.toMatch(/<form\b[^>]*\b(?:action|method)=/iu);
    // Every id names one element: the script addresses the page by id, and the management address field keeps its own.
    const ids = [...html.matchAll(/\sid="([^"]+)"/gu)].map((match) => match[1]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('management');
    expect(ids).toContain('credential');
    // The page itself carries no link with permissions and no value: both arrive from the gateway or the customer.
    expect(html).not.toContain('permissionGroupKeys');
    expect(html).not.toMatch(/cfat_[A-Za-z0-9]{8,}/u);
  });

  it('keeps the strict page policy: nonce script, no inline handlers, no form target, no referrer', async () => {
    const response = customerSetupPage();
    const html = await response.text();
    const policy = response.headers.get('content-security-policy') ?? '';
    const nonce = /script-src 'nonce-([a-f0-9]{32})'/u.exec(policy)?.[1];
    expect(policy).toBe(`default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`);
    // Any spelling of a script tag counts: the page has exactly the one that carries the nonce.
    expect([...html.matchAll(/<script\b[^>]*>/giu)].map((match) => match[0])).toEqual([`<script nonce="${nonce}">`]);
    expect(html).not.toMatch(/\son[a-z]+\s*=/iu);
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(html).toContain('<meta name="referrer" content="no-referrer">');
  });

  it('shows the exact template link, asks for a choice before the approval, and sends the value once in a POST body', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ ...reviewed, managementCredential: step(null) }))
      .mockResolvedValueOnce(Response.json({ schemaVersion: 1, managementCredential: 'held' }));
    const page = await openPage(fetch);
    await vi.waitFor(() => expect(page.node('credential').hidden).toBe(false));
    const link = new URL(String(page.node('credential-link').href));
    expect(link.href).toBe(customerManagementCredentialTemplateLink('manage.example.com'));
    expect(JSON.parse(link.searchParams.get('permissionGroupKeys') ?? '')).toEqual(CLOUDFLARE_MANAGEMENT_PERMISSION_GROUP_KEYS);
    expect(page.node('credential-name').textContent).toBe('Ankka gateway manage.example.com');
    // Until the customer has chosen, the approval is not offered.
    expect(page.node('approve').hidden).toBe(true);
    expect(page.node('credential-entry').hidden).toBe(false);
    expect(page.node('message').textContent).toBe('Review these details, then add your management token or continue without it.');

    page.node('credential-value').value = `  ${PASTED_VALUE}\n`;
    page.node('credential-form').listeners.get('submit')?.(submit);
    await vi.waitFor(() => expect(page.node('approve').hidden).toBe(false));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenLastCalledWith('/__ankka/install/management-token', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ managementToken: PASTED_VALUE }),
      credentials: 'same-origin', cache: 'no-store',
    });
    // The field is emptied as soon as it is read, and nothing on the page shows the value again.
    expect(page.node('credential-value').value).toBe('');
    expect(page.node('credential-entry').hidden).toBe(true);
    expect(page.node('credential-note').textContent).toContain('keeps it in memory and saves it as an encrypted secret when setup finishes');
    expect(page.node('credential-change').hidden).toBe(false);
    expect(page.node('message').textContent).toBe('Review these details, then approve the final installation in Cloudflare.');
    expect(page.texts()).not.toContain(PASTED_VALUE);
    expect(page.history.replaceState).toHaveBeenCalledExactlyOnceWith(null, '', '/__ankka/install');
    expect(page.navigate).not.toHaveBeenCalled();
  });

  it('continues without a token through the explicit secondary control and says where to add it later', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ ...reviewed, managementCredential: step(null) }))
      .mockResolvedValueOnce(Response.json({ schemaVersion: 1, managementCredential: 'skipped' }));
    const page = await openPage(fetch);
    await vi.waitFor(() => expect(page.node('credential').hidden).toBe(false));
    page.node('credential-value').value = PASTED_VALUE;
    page.node('credential-skip').listeners.get('click')?.();
    await vi.waitFor(() => expect(page.node('approve').hidden).toBe(false));
    expect(fetch).toHaveBeenLastCalledWith('/__ankka/install/management-token', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"skip":true}',
      credentials: 'same-origin', cache: 'no-store',
    });
    expect(page.node('credential-value').value).toBe('');
    expect(page.node('credential-note').textContent).toBe('Continuing without a management token. Adding sources and managing team access stay disabled until you add it in Settings.');
    expect(page.node('credential-change').textContent).toBe('Add a token after all');
    expect(page.texts()).not.toContain(PASTED_VALUE);
  });

  it('answers a refused value with one fixed sentence and keeps the choice open', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ ...reviewed, managementCredential: step(null) }))
      .mockResolvedValueOnce(Response.json({ schemaVersion: 1, error: 'management_token_invalid' }, { status: 400 }));
    const page = await openPage(fetch);
    await vi.waitFor(() => expect(page.node('credential').hidden).toBe(false));
    page.node('credential-value').value = 'not-a-token';
    page.node('credential-form').listeners.get('submit')?.(submit);
    await vi.waitFor(() => expect(page.node('message').textContent).toBe(
      'That is not a Cloudflare account API token. Account tokens start with cfat_. Copy the token exactly as Cloudflare showed it, or continue without it.',
    ));
    expect(page.node('credential-value').value).toBe('');
    expect(page.node('approve').hidden).toBe(true);
    expect(page.node('credential-entry').hidden).toBe(false);
    // An empty field never reaches the gateway.
    page.node('credential-form').listeners.get('submit')?.(submit);
    await vi.waitFor(() => expect(page.node('message').textContent).toBe('Paste the token first, or continue without it.'));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('restores an earlier choice, asks again for a value the gateway no longer holds, and refuses a foreign link', async () => {
    const held = await openPage(vi.fn<typeof globalThis.fetch>()
      .mockResolvedValue(Response.json({ ...reviewed, managementCredential: step('held') })));
    await vi.waitFor(() => expect(held.node('credential').hidden).toBe(false));
    expect(held.node('approve').hidden).toBe(false);
    expect(held.node('credential-entry').hidden).toBe(true);
    held.node('credential-change').listeners.get('click')?.();
    expect(held.node('credential-entry').hidden).toBe(false);
    expect(held.node('approve').hidden).toBe(true);

    const dropped = await openPage(vi.fn<typeof globalThis.fetch>()
      .mockResolvedValue(Response.json({ ...reviewed, approvalExpired: true, managementCredential: step('dropped') })));
    await vi.waitFor(() => expect(dropped.node('credential').hidden).toBe(false));
    expect(dropped.node('approve').hidden).toBe(true);
    expect(dropped.node('credential-entry').hidden).toBe(false);
    expect(dropped.node('credential-note').textContent).toBe('Your gateway no longer holds the token you pasted earlier. Paste it again, or continue without it.');
    expect(dropped.node('message').textContent).toContain('Add your management token again or continue without it, then start a fresh approval.');

    const foreign = await openPage(vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({
      ...reviewed, managementCredential: { ...step(null), createUrl: 'https://dash.cloudflare.com.example/?to=/:account/api-tokens' },
    })));
    await vi.waitFor(() => expect(foreign.node('message').textContent).toBe('The Cloudflare link could not be verified.'));
    expect(foreign.node('credential-link').href).toBe('');
    // The step is withdrawn rather than half shown, and the install itself stays available.
    expect(foreign.node('credential').hidden).toBe(true);
    expect(foreign.node('approve').hidden).toBe(false);
  });
});
