import { runInNewContext } from 'node:vm';
import * as v from 'valibot';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CUSTOMER_OPERATION_UPDATE_PATH, CUSTOMER_OPERATION_UPDATE_PROGRESS_PATH } from '../src/customer-install-paths';
import { createCustomerOperationRouter } from '../src/customer-operation-router';
import { customerUpdateProgressSchema, type CustomerUpdateProgress } from '../src/customer-update-driver';

const ORIGIN = 'https://manage.example.com';
const ATTEMPT = `attempt_${'a'.repeat(24)}`;
const ACTION_ID = `action_${'k'.repeat(32)}`;
const PREVIOUS = 'gateway-v0.1.34';
const TARGET = 'gateway-v0.1.35';
const HANDOVER = `${ORIGIN}/settings?runtimeAction=${ACTION_ID}&runtimeActionResult=applied`;
const STEPS = ['Verify the running version', 'Fetch and verify the signed release', 'Upload the management assets', 'Upload the new Worker version'];
const SERVING_STEP = 'Wait for Cloudflare to serve the new version';

interface PageNode {
  textContent: string;
  replaceChildren(...children: readonly (PageNode | string)[]): void;
  readonly shown: () => readonly (PageNode | string)[];
}

/** Enough of an element for the page: as in a document, assigning its text replaces its children. */
function element(): PageNode {
  let children: readonly (PageNode | string)[] = [];
  return {
    get textContent() { return children.filter((child) => v.is(v.string(), child)).join(''); },
    set textContent(text: string) { children = [text]; },
    replaceChildren: (...next) => { children = next; },
    shown: () => children,
  };
}

function unused(): never {
  throw new Error('the update page reaches nothing but its progress route');
}

/** The page as the router serves it, its script run against a stand-in document. */
async function openPage(fetch: typeof globalThis.fetch) {
  const router = createCustomerOperationRouter({
    accountId: 'a'.repeat(32), installId: `acg-${'b'.repeat(24)}`, publicClientId: 'c'.repeat(32), managementOrigin: ORIGIN,
    workerName: 'ankka-gateway', workersSubdomain: 'customer', release: PREVIOUS, artifactSha256: 'f'.repeat(64),
  }, {
    attempts: { read: unused, write: unused, clear: unused }, transport: unused, assertOperational: async () => undefined,
    readSourceAction: unused, readRuntimeAction: unused, issueRelayTicket: unused, beginRelay: unused, applySourceAction: unused,
    startRuntimeUpdate: unused, updateView: unused,
  });
  const response = await router.fetch(new Request(`${ORIGIN}${CUSTOMER_OPERATION_UPDATE_PATH}?attempt=${ATTEMPT}`));
  const html = await response.text();
  const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/u.exec(html)?.[1];
  if (!script) throw new Error('update script missing');
  const nodes = new Map(['#steps', '#message', '#loader'].map((selector) => [selector, element()]));
  const node = (selector: string) => {
    const value = nodes.get(selector);
    if (!value) throw new Error('update element missing');
    return value;
  };
  const navigate = vi.fn();
  const listeners = new Map<string, () => void>();
  runInNewContext(script, {
    document: { querySelector: node, createElement: element },
    location: { origin: ORIGIN, replace: navigate },
    fetch, AbortController, setTimeout, clearTimeout, encodeURIComponent,
    addEventListener: (name: string, callback: () => void) => listeners.set(name, callback),
  });
  return {
    response, html, navigate, listeners,
    message: () => node('#message').textContent,
    /** True while the loader is still part of the status line. */
    loading: () => node('#message').shown().includes(node('#loader')),
    steps: () => node('#steps').shown().map((item) => v.is(v.string(), item) ? item : item.textContent),
  };
}

const running: CustomerUpdateProgress = {
  schemaVersion: 1, attemptId: ATTEMPT, status: 'running', stage: 'uploading', result: null, reason: null, redirectUrl: null,
  applied: false, targetRelease: TARGET, servingRelease: PREVIOUS,
};
const applied: CustomerUpdateProgress = { ...running, status: 'settled', stage: null, result: 'applied', redirectUrl: HANDOVER, applied: true };

/** One answer of the progress route, held to the contract the router and the page share. */
function answer(progress: CustomerUpdateProgress): Response {
  return Response.json(v.parse(customerUpdateProgressSchema, progress));
}

/** Answers in order, the last one repeating. */
function answering(...answers: readonly (() => Response | Promise<Response>)[]) {
  let index = 0;
  return vi.fn<typeof globalThis.fetch>(async () => {
    const next = answers[Math.min(index, answers.length - 1)];
    index += 1;
    if (next === undefined) throw new Error('no answer');
    return next();
  });
}

describe('update page handover', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('waits as its own step until the target served two answers in a row, then hands over to the unchanged address', async () => {
    const fetch = answering(
      () => answer(running),
      () => answer(applied),
      () => answer({ ...applied, servingRelease: TARGET }),
      () => answer({ ...applied, servingRelease: TARGET }),
    );
    const page = await openPage(fetch);
    await vi.advanceTimersByTimeAsync(0);
    expect(page.steps()).toEqual([`${STEPS[0]} — Done`, `${STEPS[1]} — Done`, `${STEPS[2]} — Done`, `${STEPS[3]} — In progress…`, SERVING_STEP]);

    // Applied, and the previous release still answers here: the upload's steps are done, the fifth one runs.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(page.steps()).toEqual([...STEPS.map((step) => `${step} — Done`), `${SERVING_STEP} — In progress…`]);
    expect(page.message()).toBe('The upload is complete. Waiting for Cloudflare to serve the new version…');
    expect(page.loading()).toBe(true);
    expect(page.navigate).not.toHaveBeenCalled();

    // One answer from the target is not enough.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(page.steps().at(-1)).toBe(`${SERVING_STEP} — In progress…`);
    expect(page.navigate).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2_000);
    expect(page.steps().at(-1)).toBe(`${SERVING_STEP} — Done`);
    expect(page.message()).toBe('Handing over to your dashboard, which follows the update to its end.');
    expect(page.navigate).toHaveBeenCalledExactlyOnceWith(HANDOVER);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(page.navigate).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]).toEqual([`${CUSTOMER_OPERATION_UPDATE_PROGRESS_PATH}?attempt=${ATTEMPT}`, {
      credentials: 'same-origin', cache: 'no-store', redirect: 'manual', signal: expect.any(AbortSignal),
    }]);
  });

  it('starts counting again when the previous release answers in between or a poll fails', async () => {
    const target = () => answer({ ...applied, servingRelease: TARGET });
    const fetch = answering(
      target, () => answer(applied), target, () => Promise.reject(new Error('connection reset')), target,
      () => new Response(null, { status: 503 }), target, target,
    );
    const page = await openPage(fetch);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(fetch).toHaveBeenCalledTimes(7);
    expect(page.navigate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(page.navigate).toHaveBeenCalledExactlyOnceWith(HANDOVER);
  });

  it('hands over anyway once the bound passes and says that a reload may be needed', async () => {
    // Neither the previous release nor an entrypoint that names none ever confirms the target.
    const fetch = answering(() => answer(applied), () => answer({ ...applied, servingRelease: null }));
    const page = await openPage(fetch);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(page.navigate).not.toHaveBeenCalled();
    expect(page.steps().at(-1)).toBe(`${SERVING_STEP} — In progress…`);
    const polls = fetch.mock.calls.length;

    await vi.advanceTimersByTimeAsync(1_000);
    expect(page.steps().at(-1)).toBe(`${SERVING_STEP} — Not confirmed`);
    expect(page.message()).toBe('Cloudflare is taking longer than usual to serve the new version. Handing over to your dashboard; if it still shows the previous version, reload the page.');
    expect(page.loading()).toBe(false);
    // The sentence stays readable for a moment; the handover it announces is the same address.
    expect(page.navigate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(page.navigate).toHaveBeenCalledExactlyOnceWith(HANDOVER);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetch.mock.calls.length).toBe(polls);
    expect(page.navigate).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['failed', { ...applied, result: 'failed', reason: 'update_failed', applied: false,
      redirectUrl: `${ORIGIN}/settings?runtimeAction=${ACTION_ID}&runtimeActionResult=failed&runtimeActionReason=update_failed` }],
    ['ended without a result in an object that does not run the target', { ...applied, result: null, applied: false,
      redirectUrl: `${ORIGIN}/settings?runtimeAction=${ACTION_ID}` }],
    ['applied before the record named a target', { ...applied, targetRelease: null }],
  ] satisfies [string, CustomerUpdateProgress][])('hands over at once when the attempt %s', async (_name, progress) => {
    const fetch = answering(() => answer(progress));
    const page = await openPage(fetch);
    await vi.advanceTimersByTimeAsync(0);
    expect(page.navigate).toHaveBeenCalledExactlyOnceWith(progress.redirectUrl);
    expect(page.message()).toBe('Handing over to your dashboard, which follows the update to its end.');
    expect(page.steps().at(-1)).toBe(SERVING_STEP);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('hands over at once to an object from before these fields, which a rollback to an older release leaves answering', async () => {
    const { applied: _applied, targetRelease: _target, servingRelease: _serving, ...older } = applied;
    const fetch = answering(() => answer(running), () => Response.json(older));
    const page = await openPage(fetch);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(page.navigate).toHaveBeenCalledExactlyOnceWith(HANDOVER);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('neither waits nor hands over after the page is left', async () => {
    const fetch = answering(() => answer(applied));
    const page = await openPage(fetch);
    await vi.advanceTimersByTimeAsync(4_000);
    page.listeners.get('pagehide')?.();
    const polls = fetch.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetch.mock.calls.length).toBe(polls);
    expect(page.navigate).not.toHaveBeenCalled();
  });

  it('does not follow an address outside the dashboard and keeps its content security policy', async () => {
    const fetch = answering(() => answer({ ...applied, redirectUrl: 'https://other.example.com/settings' }));
    const page = await openPage(fetch);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(page.navigate).not.toHaveBeenCalled();
    expect(page.message()).toBe('The update has ended. Open Settings to see its result.');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(page.response.headers.get('content-security-policy')).toMatch(
      /^default-src 'none'; script-src 'nonce-[a-f0-9]{32}'; connect-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'$/u,
    );
    expect(page.response.headers.get('cache-control')).toBe('no-store');
  });
});
