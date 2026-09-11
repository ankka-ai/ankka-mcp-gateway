import { promises as dns } from 'node:dns';

/**
 * The zone's authoritative nameserver addresses, found through the system resolver. The zone apex and its
 * nameservers are long-lived names whose answers every resolver already holds positively, so this lookup cannot
 * cache an absence anywhere.
 */
export async function authoritativeServers(zone, { resolveNs = dns.resolveNs, resolve4 = dns.resolve4 } = {}) {
  const addresses = [];
  for (const name of await resolveNs(zone)) {
    try { addresses.push(...await resolve4(name)); } catch { /* A nameserver without a reachable address is skipped. */ }
  }
  return [...new Set(addresses)];
}

/**
 * Whether the zone's authoritative nameservers serve the hostname: every one that answers at all must answer with
 * records, and at least one must answer. Only the authoritative servers are asked. A recursive resolver (the
 * system's, a forwarder in front of it, or a public one) caches a negative answer for the zone's negative TTL, and
 * asking it before the record is served poisons exactly the path the first real lookup takes; the Workers custom
 * domain's record has taken more than ten minutes to be served after its creation.
 */
export async function hostnameResolvesDirectly(hostname, { zone, servers, resolver = createResolver, nameservers = authoritativeServers } = {}) {
  const candidates = servers ?? await nameservers(zone);
  let served = 0;
  for (const server of candidates) {
    const outcome = await answers(resolver(server), hostname);
    if (outcome === 'negative') return false;
    if (outcome === 'records') served += 1;
  }
  return served > 0;
}

const NEGATIVE = new Set(['ENOTFOUND', 'ENODATA']);

/** 'records' when a type answers, 'negative' when the server denies the name for both types, else 'unreachable'. */
async function answers(resolve, hostname) {
  let negative = 0;
  for (const type of ['A', 'AAAA']) {
    try {
      const records = await resolve(hostname, type);
      if (Array.isArray(records) && records.length > 0) return 'records';
      negative += 1;
    } catch (error) {
      if (NEGATIVE.has(error?.code)) negative += 1;
    }
  }
  return negative === 2 ? 'negative' : 'unreachable';
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
export async function awaitSystemResolution(hostname, { zone, notify, seconds = 1_900, direct = hostnameResolvesDirectly, system = systemResolves, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = Date.now } = {}) {
  const deadline = now() + seconds * 1000;
  let noticed = false;
  while (now() < deadline) {
    if (await system(hostname)) return true;
    if (!noticed && await direct(hostname, { zone })) {
      noticed = true;
      notify?.(`${hostname} resolves at the DNS servers but not through this machine's resolver, which cached its absence. ` +
        'Clear the cache to continue now: sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder');
    }
    await sleep(5_000);
  }
  return false;
}
