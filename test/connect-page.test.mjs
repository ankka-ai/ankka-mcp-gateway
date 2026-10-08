import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createConnectHandler } from '../apps/connect-page/src/handler.mjs';

const template = await readFile(new URL('../apps/connect-page/src/page.html', import.meta.url), 'utf8');
const wordmark = await readFile(new URL('../docs/assets/ankka-wordmark.svg', import.meta.url), 'utf8');
const endpoint = 'https://connect.example.com/mcp';
const env = { MCP_HOSTNAME: 'connect.example.com' };
const browserHeaders = { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };

test('browser navigation receives the setup page without contacting the portal', async () => {
  const handler = createConnectHandler(template, wordmark, () => assert.fail('No upstream call for the page'));
  const response = await handler(new Request(endpoint, { headers: browserHeaders }), env);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/html/u);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  const body = await response.text();
  assert.ok(body.includes(`value="${endpoint}"`));
  assert.ok(body.includes(wordmark.match(/<path[^>]+>/u)[0]));
  assert.ok(body.includes('Choose your assistant'));
  assert.ok(!body.includes('{{'));
  const nonce = body.match(/<script nonce="([^"]+)"/u)[1];
  assert.ok(response.headers.get('content-security-policy').includes(`script-src 'nonce-${nonce}'`));
  assert.ok(!/<(?:style|script)>/u.test(body));
  const second = await handler(new Request(endpoint, { headers: browserHeaders }), env);
  assert.notEqual(second.headers.get('content-security-policy'), response.headers.get('content-security-policy'));
});

test('quick-add links prefill only the configured gateway and keep setup sections collapsed', async () => {
  const handler = createConnectHandler(template, wordmark, () => assert.fail('No upstream call'));
  const host = 'another-team.example.com';
  const response = await handler(new Request(`https://${host}/mcp`, { headers: browserHeaders }), { MCP_HOSTNAME: host });
  const body = await response.text();
  const links = [...body.matchAll(/href="([^"]+)"/gu)].map((match) => new URL(match[1].replaceAll('&amp;', '&')));
  const claude = links.find((link) => link.hostname === 'claude.ai');
  assert.equal(claude.origin + claude.pathname, 'https://claude.ai/customize/connectors');
  assert.deepEqual(Object.fromEntries(claude.searchParams), {
    modal: 'add-custom-connector', connectorName: 'Team gateway', connectorUrl: `https://${host}/mcp`,
  });
  const cursor = links.find((link) => link.protocol === 'cursor:');
  assert.equal(cursor.hostname + cursor.pathname, 'anysphere.cursor-deeplink/mcp/install');
  assert.equal(cursor.searchParams.get('name'), 'team-gateway');
  assert.deepEqual(JSON.parse(atob(cursor.searchParams.get('config'))), { url: `https://${host}/mcp` });
  assert.doesNotMatch(body, /<details\b[^>]*\bopen\b/u);
});

test('MCP, ambiguous requests and query strings retain the portal authentication challenge', async () => {
  const challenge = { 'www-authenticate': 'Bearer resource_metadata="https://connect.example.com/.well-known/oauth-protected-resource"' };
  const requests = [
    new Request(endpoint),
    new Request(endpoint, { headers: { accept: '*/*' } }),
    new Request(endpoint, { headers: { accept: 'text/html' } }),
    new Request(endpoint, { headers: { ...browserHeaders, 'sec-fetch-mode': 'cors' } }),
    new Request(endpoint, { headers: { ...browserHeaders, 'sec-fetch-dest': 'iframe' } }),
    new Request(`${endpoint}?session=synthetic`, { headers: browserHeaders }),
    ...['text/event-stream', 'application/json', 'text/html,text/event-stream', 'text/html, application/json;q=0',
      '*/*', 'text/html;q=0', 'text/html;q=0.000', 'text/html;q=invalid', 'text/htmlish'].map((accept) =>
      new Request(endpoint, { headers: { ...browserHeaders, accept } })),
    ...['authorization', 'cf-access-client-id', 'cf-access-client-secret', 'mcp-session-id', 'mcp-protocol-version',
      'last-event-id'].map((name) => new Request(endpoint, { headers: { ...browserHeaders, [name]: 'synthetic' } })),
    ...['POST', 'DELETE', 'OPTIONS', 'HEAD'].map((method) => new Request(endpoint, { method, headers: browserHeaders })),
  ];
  for (const request of requests) {
    let received;
    const upstream = new Response('{"error":"invalid_token"}', { status: 401, headers: challenge });
    const handler = createConnectHandler(template, wordmark, (input) => { received = input; return upstream; });
    const result = await handler(request, env);
    assert.equal(result, upstream);
    assert.equal(result.headers.get('www-authenticate'), challenge['www-authenticate']);
    assert.equal(received.url, request.url);
    assert.equal(received.method, request.method);
    assert.deepEqual([...received.headers], [...request.headers]);
    assert.equal(received.redirect, 'manual');
  }
});

test('POST body, upstream redirects and stream remain untouched', async () => {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  const request = new Request(endpoint, { method: 'POST', headers: { authorization: 'Bearer synthetic',
    'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body });
  const stream = new TransformStream();
  const upstream = new Response(stream.readable, { headers: { 'content-type': 'text/event-stream', 'mcp-session-id': 'synthetic' } });
  const handler = createConnectHandler(template, wordmark, async (input) => {
    assert.equal(await input.text(), body);
    assert.equal(input.headers.get('authorization'), 'Bearer synthetic');
    return upstream;
  });
  const response = await handler(request, env);
  assert.equal(response, upstream);
  assert.equal(response.bodyUsed, false);
  const writer = stream.writable.getWriter();
  const write = writer.write(new TextEncoder().encode('data: {"jsonrpc":"2.0"}\n\n'));
  const reader = response.body.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: {"jsonrpc":"2.0"}\n\n');
  await write;
  await writer.close();
  const redirect = new Response(null, { status: 302, headers: { location: 'https://identity.example.com/authorize' } });
  const redirectHandler = createConnectHandler(template, wordmark, (input) => {
    assert.equal(input.redirect, 'manual');
    return redirect;
  });
  assert.equal(await redirectHandler(new Request(endpoint), env), redirect);
});

test('wrong hosts, paths, schemes and invalid deployment settings cannot proxy', async () => {
  const handler = createConnectHandler(template, wordmark, () => assert.fail('Refused requests must not be forwarded'));
  for (const url of ['https://elsewhere.example.com/mcp', 'https://connect.example.com/mcp/extra',
    'https://connect.example.com/authorize', 'https://connect.example.com/api/status',
    'https://connect.example.com/mcp/', 'https://connect.example.com:444/mcp', 'http://connect.example.com/mcp']) {
    assert.equal((await handler(new Request(url, { headers: browserHeaders }), env)).status, 404);
  }
  for (const host of [undefined, '', 'connect.example.com/evil', 'connect.example.com"><script>', '*.example.com', 'localhost']) {
    assert.equal((await handler(new Request(endpoint, { headers: browserHeaders }), { MCP_HOSTNAME: host })).status, 404);
  }
});

test('HTML media types are case insensitive and honor a nonzero quality', async () => {
  const handler = createConnectHandler(template, wordmark, () => assert.fail('Expected a page'));
  for (const accept of ['TEXT/HTML', 'text/html; q=0.8', 'text/html;q=1.000']) {
    assert.equal((await handler(new Request(endpoint, { headers: { ...browserHeaders, accept } }), env)).status, 200);
  }
});
