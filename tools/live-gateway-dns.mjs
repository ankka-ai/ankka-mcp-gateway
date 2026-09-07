import { promises as dns } from 'node:dns';

/**
 * Whether a hostname resolves when asked directly at the configured DNS servers (and Cloudflare's resolver as a
 * fallback), bypassing the operating system's cache. The first system lookup of a hostname whose record is seconds
 * old can return a negative answer that the system caches for the zone's negative TTL; asking the servers directly
 * neither consults nor pollutes that cache.
 */
export async function hostnameResolvesDirectly(hostname, { servers = dns.getServers(), resolver = createResolver } = {}) {
  const candidates = [...new Set([...servers.filter((server) => !server.startsWith('fd') && !server.includes('%')), '1.1.1.1'])];
  for (const server of candidates) {
    const resolve = resolver(server);
    for (const type of ['A', 'AAAA']) {
      try {
        const answers = await resolve(hostname, type);
        if (Array.isArray(answers) && answers.length > 0) return true;
      } catch {
        // NXDOMAIN, timeout or an unreachable server: try the next type or server.
      }
    }
  }
  return false;
}

function createResolver(server) {
  const instance = new dns.Resolver({ timeout: 3_000, tries: 1 });
  instance.setServers([server]);
  return (hostname, type) => type === 'A' ? instance.resolve4(hostname) : instance.resolve6(hostname);
}
