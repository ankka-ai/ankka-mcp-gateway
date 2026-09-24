import type { CustomerCloudflareTransport } from '../src/customer-cloudflare-grant';
import { writeCustomerManagementCredentialSecret } from '../src/customer-management-credential-secret';

const ACCOUNT_ID = 'a'.repeat(32);
const GRANT = `grant_${'d'.repeat(32)}`;
// A synthetic value in Cloudflare's account token form, assembled at run time.
const PASTED_VALUE = `cfat_${'Hk3v'.repeat(10)}${'9a'.repeat(4)}`;

function recorder(answer: (request: Request) => Response | Promise<Response>) {
  const requests: { method: string; url: string; body: string; headers: Record<string, string>; redirect: string }[] = [];
  const transport: CustomerCloudflareTransport = async (input, init) => {
    const request = new Request(input, init);
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => { headers[key] = value; });
    requests.push({ method: request.method, url: request.url, body: await request.clone().text(), headers, redirect: request.redirect });
    return answer(request);
  };
  return { requests, transport };
}

function write(transport: CustomerCloudflareTransport, overrides: Partial<Parameters<typeof writeCustomerManagementCredentialSecret>[0]> = {}) {
  return writeCustomerManagementCredentialSecret({
    accessToken: GRANT, accountId: ACCOUNT_ID, workerName: 'ankka-gateway', value: PASTED_VALUE, transport, ...overrides,
  });
}

describe('the one Worker-secret write of a management token change', () => {
  it.each([200, 201])('sends exactly one PUT of the fixed secret and accepts HTTP %i without reading the answer', async (status) => {
    let bodyRead = false;
    const f = recorder(() => new Response(new ReadableStream({
      pull(controller) { bodyRead = true; controller.enqueue(new TextEncoder().encode('{"success":true}')); controller.close(); },
    }, { highWaterMark: 0 }), { status }));
    await expect(write(f.transport)).resolves.toEqual({ written: true });
    expect(f.requests).toEqual([{
      method: 'PUT',
      url: `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/scripts/ankka-gateway/secrets`,
      body: JSON.stringify({ name: 'ANKKA_MANAGEMENT_TOKEN', text: PASTED_VALUE, type: 'secret_text' }),
      headers: { accept: 'application/json', authorization: `Bearer ${GRANT}`, 'content-type': 'application/json' },
      redirect: 'manual',
    }]);
    expect(bodyRead).toBe(false);
  });

  it.each([202, 204, 302, 403, 429, 500])('never retries and keeps only the status of HTTP %i', async (status) => {
    const f = recorder(() => new Response(status === 204 ? null : JSON.stringify({ errors: [{ message: `echo ${PASTED_VALUE}` }] }), { status }));
    const result = await write(f.transport);
    expect(result).toEqual({ written: false, reason: `secret_write_http_${status}` });
    expect(f.requests).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(PASTED_VALUE);
  });

  it('calls a lost answer unconfirmed, without retrying and without keeping the failure', async () => {
    const f = recorder((request) => { throw new Error(`socket closed while sending ${request.url} ${PASTED_VALUE}`); });
    const result = await write(f.transport);
    expect(result).toEqual({ written: false, reason: 'secret_write_unconfirmed' });
    expect(f.requests).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(PASTED_VALUE);
  });

  it('sends nothing for a value that is not an account token, or for a target that is not this gateway’s form', async () => {
    const f = recorder(() => new Response(null, { status: 201 }));
    for (const overrides of [
      { value: `cfut_${'a'.repeat(40)}` }, { value: ` ${PASTED_VALUE}` }, { value: '' },
      { accountId: 'A'.repeat(32) }, { workerName: '../other' }, { workerName: 'Other' },
    ]) {
      await expect(write(f.transport, overrides)).resolves.toEqual({ written: false, reason: 'secret_write_refused' });
    }
    expect(f.requests).toEqual([]);
  });
});
