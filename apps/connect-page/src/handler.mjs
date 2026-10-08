const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const PROTOCOL_HEADERS = ['authorization', 'cf-access-client-id', 'cf-access-client-secret',
  'mcp-protocol-version', 'mcp-session-id', 'last-event-id'];

function acceptsHtml(request) {
  const types = (request.headers.get('accept') ?? '').toLowerCase().split(',').map((entry) => entry.trim());
  // A mixed protocol/HTML request still belongs to the portal, even with q=0.
  if (types.some((entry) => /^(?:text\/event-stream|application\/json)(?:\s*;|$)/u.test(entry))) return false;
  return types.some((entry) => {
    const [type, ...parameters] = entry.split(';').map((part) => part.trim());
    if (type !== 'text/html') return false;
    const quality = parameters.find((part) => part.startsWith('q='));
    return quality === undefined || /^q=(?:1(?:\.0{0,3})?|0\.\d{1,3})$/u.test(quality) && Number(quality.slice(2)) > 0;
  });
}

export function isBrowserNavigation(request) {
  return request.method === 'GET' && request.headers.get('sec-fetch-mode') === 'navigate' &&
    request.headers.get('sec-fetch-dest') === 'document' &&
    !PROTOCOL_HEADERS.some((name) => request.headers.has(name)) && acceptsHtml(request);
}

export function renderConnectPage(template, wordmark, hostname, nonce) {
  const endpoint = `https://${hostname}/mcp`;
  const claudeLink = new URL('https://claude.ai/customize/connectors');
  claudeLink.search = new URLSearchParams({ modal: 'add-custom-connector',
    connectorName: 'Team gateway', connectorUrl: endpoint }).toString();
  const cursorLink = new URL('cursor://anysphere.cursor-deeplink/mcp/install');
  cursorLink.search = new URLSearchParams({ name: 'team-gateway',
    config: btoa(JSON.stringify({ url: endpoint })) }).toString();
  return template.replace('{{WORDMARK}}', wordmark)
    .replaceAll('{{MCP_URL}}', endpoint)
    .replaceAll('{{CLAUDE_INSTALL_URL}}', claudeLink.href.replaceAll('&', '&amp;'))
    .replaceAll('{{CURSOR_INSTALL_URL}}', cursorLink.href.replaceAll('&', '&amp;'))
    .replaceAll('<style>', `<style nonce="${nonce}">`)
    .replaceAll('<script>', `<script nonce="${nonce}">`);
}

export function createConnectHandler(template, wordmark, fetcher = fetch) {
  return async (request, env) => {
    const host = env.MCP_HOSTNAME;
    const url = new URL(request.url);
    // Only the configured portal and path can ever receive a subrequest. In
    // particular, this must not become a general proxy on workers.dev.
    if (!HOSTNAME.test(host ?? '') || url.protocol !== 'https:' || url.host !== host || url.pathname !== '/mcp') {
      return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
    }
    if (url.search === '' && isBrowserNavigation(request)) {
      const nonce = crypto.randomUUID();
      return new Response(renderConnectPage(template, wordmark, host, nonce), {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'private, no-store',
          'vary': 'Accept, Sec-Fetch-Mode, Sec-Fetch-Dest, Authorization, CF-Access-Client-Id, CF-Access-Client-Secret, MCP-Protocol-Version, MCP-Session-Id, Last-Event-ID',
          'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
          'referrer-policy': 'no-referrer',
          'x-content-type-options': 'nosniff',
          'x-frame-options': 'DENY',
          'x-robots-tag': 'noindex, nofollow',
        },
      });
    }
    // A Workers Route fetch reaches the existing origin. Keep the exact URL,
    // method, headers and streaming body. Never follow a redirect with a token.
    return fetcher(new Request(request, { redirect: 'manual' }));
  };
}
