import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createConnectHandler } from '../apps/connect-page/src/handler.mjs';

const template = await readFile(new URL('../apps/connect-page/src/page.html', import.meta.url), 'utf8');
const wordmark = await readFile(new URL('../docs/assets/ankka-wordmark.svg', import.meta.url), 'utf8');
const handler = createConnectHandler(template, wordmark, () => new Response('{"error":"invalid_token"}', {
  status: 401, headers: { 'content-type': 'application/json' },
}));

// A loopback-only UI preview with a synthetic host and no outbound requests.
const server = createServer(async (incoming, outgoing) => {
  const headers = new Headers();
  for (const [key, value] of Object.entries(incoming.headers)) {
    if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
  }
  const request = new Request(`https://connect.example.com${incoming.url}`, { method: incoming.method, headers });
  const response = await handler(request, { MCP_HOSTNAME: 'connect.example.com' });
  outgoing.writeHead(response.status, Object.fromEntries(response.headers));
  outgoing.end(await response.text());
});
server.listen(Number(process.env.PORT ?? 0), '127.0.0.1', () => {
  console.log(`Connect page preview: http://127.0.0.1:${server.address().port}/mcp`);
});
