import { promises as dns } from 'node:dns';

/**
 * Whether a hostname resolves when asked directly at every configured DNS server, bypassing the operating system's
 * cache; Cloudflare's resolver stands in only when none is configured. The first system lookup of a hostname whose
 * record is seconds old can return a negative answer that the system caches for the zone's negative TTL, and the
 * system asks its configured servers, so all of them must answer before the first lookup is risked: one public
 * resolver answering while a local forwarder still does not was enough to cache the absence for half an hour.
 * Asking the servers directly neither consults nor pollutes that cache.
 */
export async function hostnameResolvesDirectly(hostname, { servers = dns.getServers(), resolver = createResolver } = {}) {
  const configured = [...new Set(servers.filter((server) => !server.startsWith('fd') && !server.includes('%')))];
  const candidates = configured.length > 0 ? configured : ['1.1.1.1'];
  for (const server of candidates) {
    if (!await answers(resolver(server), hostname)) return false;
  }
  return true;
}

async function answers(resolve, hostname) {
  for (const type of ['A', 'AAAA']) {
    try {
      const records = await resolve(hostname, type);
      if (Array.isArray(records) && records.length > 0) return true;
    } catch {
      // NXDOMAIN, timeout or an unreachable server: try the next type.
    }
  }
  return false;
}

function createResolver(server) {
  const instance = new dns.Resolver({ timeout: 3_000, tries: 1 });
  instance.setServers([server]);
  return (hostname, type) => type === 'A' ? instance.resolve4(hostname) : instance.resolve6(hostname);
}

/** Whether the operating system resolver (what browsers and HTTP clients use) currently resolves the hostname. */
export async function systemResolves(hostname, { lookup = dns.lookup } = {}) {
  try { await lookup(hostname); return true; } catch { return false; }
}

/**
 * Waits until the hostname resolves through the system resolver. When the servers already answer but the system
 * does not, the system cached a negative answer; the operator is told how to clear it while the wait continues, up
 * to the zone's negative TTL.
 */
export async function awaitSystemResolution(hostname, { notify, seconds = 1_900, direct = hostnameResolvesDirectly, system = systemResolves, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = Date.now } = {}) {
  const deadline = now() + seconds * 1000;
  let noticed = false;
  while (now() < deadline) {
    if (await system(hostname)) return true;
    if (!noticed && await direct(hostname)) {
      noticed = true;
      notify?.(`${hostname} resolves at the DNS servers but not through this machine's resolver, which cached its absence. ` +
        'Clear the cache to continue now: sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder');
    }
    await sleep(5_000);
  }
  return false;
}
