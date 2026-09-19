import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { customerInstallProgressPage } from '../src/customer-install-progress-page';
import type { CustomerBootstrapCallbackOutcome } from '../src/customer-bootstrap-router';

function element() {
  return { textContent: '', href: '', hidden: false, append: vi.fn() };
}

async function openPage(outcome: CustomerBootstrapCallbackOutcome, fetch: typeof globalThis.fetch) {
  const response = customerInstallProgressPage('manage.example.com', outcome, []);
  const html = await response.text();
  const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/u.exec(html)?.[1];
  if (!script) throw new Error('progress script missing');
  const nodes = new Map(['#title', '#message', '#detail', '#credential', '#progress'].map((selector) => [selector, element()]));
  const navigate = vi.fn();
  const listeners = new Map<string, () => void>();
  runInNewContext(script, {
    document: { querySelector: (selector: string) => nodes.get(selector), createElement: element },
    location: { replace: navigate },
    fetch, AbortController, setTimeout, clearTimeout,
    addEventListener: (name: string, callback: () => void) => listeners.set(name, callback),
  });
  return { nodes, navigate, listeners, response };
}

const converging: CustomerBootstrapCallbackOutcome = { status: 'CONVERGING', failureCode: null, failureReason: null };

describe('customer install final navigation', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('automatically opens the fixed management waiting screen on READY', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const page = await openPage({ ...converging, status: 'READY' }, fetch);
    expect(page.navigate).toHaveBeenCalledExactlyOnceWith('https://manage.example.com/?setup=finishing');
    expect(page.nodes.get('#progress')?.hidden).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
    expect(page.response.headers.get('content-security-policy')).toContain("connect-src 'self'");
    expect(page.response.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('continues to management after the temporary address retires without claiming readiness', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error('temporary_address_closed'));
    const page = await openPage(converging, fetch);
    expect(page.nodes.get('#progress')?.hidden).toBe(false);
    // Quick misses are not proof that the temporary address retired: a name that does not exist yet would be cached.
    await vi.advanceTimersByTimeAsync(9_000);
    expect(page.navigate).not.toHaveBeenCalled();
    expect(page.nodes.get('#message')?.textContent).toContain('Still finishing');
    await vi.advanceTimersByTimeAsync(51_000);
    expect(page.navigate).toHaveBeenCalledExactlyOnceWith('https://manage.example.com/?setup=finishing');
    expect(page.nodes.get('#title')?.textContent).toBe('Opening your management page');
    expect(page.nodes.get('#message')?.textContent).toContain('will check that setup finished');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetch).toHaveBeenCalledTimes(20);
    expect(fetch.mock.calls[0]).toEqual(['/__ankka/install/status', {
      credentials: 'same-origin', cache: 'no-store', redirect: 'manual', signal: expect.any(AbortSignal),
    }]);
  });

  it('resets transient failures when convergence is observed and navigates on a later READY', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockRejectedValueOnce(new Error('temporary_failure'))
      .mockResolvedValueOnce(Response.json({ status: 'CONVERGING' }))
      .mockResolvedValueOnce(Response.json({ status: 'READY' }));
    const page = await openPage(converging, fetch);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(page.navigate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(page.navigate).toHaveBeenCalledTimes(1);
  });

  it('does not treat a redirect response as a ready status or follow its destination', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => Response.json(
      { status: 'READY' }, { status: 302, headers: { location: 'https://other.example.com/' } },
    ));
    const page = await openPage(converging, fetch);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(page.navigate).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledExactlyOnceWith('/__ankka/install/status', expect.objectContaining({ redirect: 'manual' }));
  });

  it('stops on an explicit setup failure', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ status: 'INCOMPLETE', failure: { code: 'convergence_failed' } }));
    const page = await openPage(converging, fetch);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(page.navigate).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(page.nodes.get('#title')?.textContent).toBe('Setup did not complete');
    expect(page.nodes.get('#detail')?.textContent).toBe('Reason: convergence_failed');
    expect(page.nodes.get('#progress')?.hidden).toBe(true);
  });

  it('says in one fixed sentence what happens to the management token while the install runs', async () => {
    const answers = [
      { status: 'CONVERGING' },
      { status: 'CONVERGING', managementCredential: 'held' },
      { status: 'CONVERGING', managementCredential: 'skipped' },
      { status: 'CONVERGING', managementCredential: 'dropped' },
      { status: 'CONVERGING', managementCredential: 'installed' },
      { status: 'CONVERGING', managementCredential: 'constructor' },
      { status: 'CONVERGING', managementCredential: '<b>held</b>' },
      { status: 'INCOMPLETE', managementCredential: 'held', failure: { code: 'provider_recovery_required', reason: null } },
    ];
    const fetch = vi.fn<typeof globalThis.fetch>();
    for (const answer of answers) fetch.mockResolvedValueOnce(Response.json(answer));
    const page = await openPage(converging, fetch);
    const shown: (string | undefined)[] = [];
    for (let poll = 0; poll < answers.length; poll += 1) {
      await vi.advanceTimersByTimeAsync(3_000);
      shown.push(page.nodes.get('#credential')?.textContent);
    }
    expect(shown).toEqual([
      '',
      'Your management token is saved as an encrypted secret on your gateway in the last step of setup.',
      'You continued without a management token. Adding sources and managing team access stay disabled until you add it in Settings.',
      'Your gateway no longer held the management token you pasted, so setup is finishing without it. Adding sources and managing team access stay disabled until you add it in Settings.',
      'Your management token is saved as an encrypted secret on your gateway.',
      // Only the four fixed words select a sentence; anything else shows nothing.
      '', '', '',
    ]);
    expect(page.nodes.get('#title')?.textContent).toBe('Setup did not complete');
    expect(page.navigate).not.toHaveBeenCalled();
  });

  it('does not navigate or poll after leaving the page', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error('closed'));
    const page = await openPage(converging, fetch);
    page.listeners.get('pagehide')?.();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(page.navigate).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
