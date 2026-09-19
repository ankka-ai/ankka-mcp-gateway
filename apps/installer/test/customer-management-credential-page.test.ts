import { Script } from 'node:vm';

import { customerManagementCredentialPage } from '../src/customer-management-credential-page';

const NOW = 1_800_000_000_000;

function page(overrides: Partial<Parameters<typeof customerManagementCredentialPage>[0]> = {}): Response {
  return customerManagementCredentialPage({
    code: `code_${'e'.repeat(32)}`, state: 's'.repeat(43), managementHostname: 'manage.example.com',
    expiresAt: NOW + 420_000, now: NOW, ...overrides,
  });
}

function scriptOf(html: string): string {
  const script = html.match(/<script nonce="[^"]+">([\s\S]*)<\/script>/u)?.[1];
  if (script === undefined) throw new Error('script missing');
  return script;
}

describe('management token paste page', () => {
  it('keeps callback values inside their JavaScript strings even when called with HTML', async () => {
    const value = '</script><script>throw new Error("injected")</script><!--';
    const html = await page({ code: value, state: value, managementHostname: value }).text();
    expect(html.match(/<script\b/gu)).toHaveLength(1);
    expect(html.match(/<\/script>/gu)).toHaveLength(1);
    expect(html).not.toContain(value);
    const script = scriptOf(html);
    expect(() => new Script(script)).not.toThrow();
    const literals = script.match(/const code=(".*?"),state=(".*?"),link=(".*?"),name=(".*?"),remaining=(\d+);/u);
    expect(JSON.parse(literals?.[1] ?? 'null')).toBe(value);
    expect(JSON.parse(literals?.[2] ?? 'null')).toBe(value);
    expect(JSON.parse(literals?.[4] ?? 'null')).toBe(`Ankka gateway ${value}`);
  });

  it('is a page of the gateway under a strict policy, with one unnamed field and no way for a form to carry it', async () => {
    const response = page();
    expect(response.headers.get('content-security-policy')).toMatch(
      /^default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-[A-Za-z0-9_-]+'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'$/u);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('set-cookie')).toBeNull();
    const html = await response.text();
    expect(html).toContain('class="ankka-setup"');
    expect(html.match(/<input\b/gu)).toHaveLength(1);
    expect(html).toMatch(/<input id="token" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="96" required>/u);
    expect(html).not.toMatch(/<(?:input|form)[^>]*\b(?:name|action|method)=/u);
    // Both permissions, the name, who can create it, where it goes, what it can reach, and what happens to an old token.
    for (const sentence of [
      'Access: Apps and Policies Edit', 'MCP Portals Edit', 'Super Administrator or Administrator',
      'it never passes through anything Ankka hosts', 'it can edit every Access policy in your account',
      'Your gateway cannot delete the earlier one', 'Manage Account → Account API Tokens',
    ]) expect(html).toContain(sentence);
  });

  it('drops the code from the address at once, sends the value once to its own path, and empties the field first', async () => {
    const script = scriptOf(await page().text());
    expect(script.indexOf("history.replaceState(null,'',location.pathname)")).toBeLessThan(script.indexOf('addEventListener'));
    // The field is emptied before anything is awaited or checked.
    expect(script).toContain("let value=field.value.trim();field.value='';");
    expect(script).toContain("fetch(location.pathname,{method:'POST',credentials:'same-origin',cache:'no-store',redirect:'manual'");
    expect(script).toContain('post({code,state,managementToken:value});value=\'\';');
    // Nothing on the page stores anything, builds a URL from the value, or sends it anywhere but its own origin.
    expect(script).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie|sendBeacon|XMLHttpRequest|WebSocket|EventSource/u);
    expect(script.match(/fetch\(/gu)).toHaveLength(1);
    expect(script).toContain("next.origin!==location.origin||next.pathname!=='/settings'");
  });

  it('knows when its approval runs out and says so plainly, without asking the gateway', async () => {
    const live = scriptOf(await page().text());
    expect(live).toContain('remaining=420000;');
    expect(live).toContain('timer=setTimeout(()=>{if(!sent)close(expired)},remaining)');
    expect(live).toContain('Cloudflare’s approval ran out before the token arrived, so nothing was saved. Approvals last only a few minutes. Go back to Settings and start again.');
    expect(live).toContain("result.result==='failed'&&result.reason==='approval_expired'");
    const late = scriptOf(await page({ expiresAt: NOW - 1 }).text());
    expect(late).toContain('remaining=0;');
  });
});
