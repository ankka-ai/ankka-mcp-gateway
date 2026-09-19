import { promises as dns } from 'node:dns';
import { connect as connectTcp } from 'node:net';

/**
 * The zone's authoritative nameserver addresses, found through the system resolver. The zone apex and its
 * nameservers are long-lived names whose answers every resolver already holds positively, so this lookup cannot
 * cache an absence anywhere.
 */
export async function authoritativeServers(zone, { resolveNs = dns.resolveNs, resolve4 = dns.resolve4, cache = nameserverCache, now = Date.now } = {}) {
  // A zone's nameservers do not change during a run; one lookup serves the whole wait, and a transient failure of
  // that lookup means "not known yet", never a thrown error out of a wait loop.
  const cached = cache.get(zone);
  if (cached !== undefined && cached.until > now()) return cached.addresses;
  let names;
  try { names = await resolveNs(zone); } catch { return []; }
  const addresses = [];
  for (const name of names) {
    try { addresses.push(...await resolve4(name)); } catch { /* A nameserver without a reachable address is skipped. */ }
  }
  const unique = [...new Set(addresses)];
  if (unique.length > 0) cache.set(zone, { addresses: unique, until: now() + 10 * 60_000 });
  return unique;
}

const nameserverCache = new Map();

/**
 * Whether the zone's authoritative nameservers serve the hostname: every one that answers at all must answer with
 * records, and at least one must answer. Only the authoritative servers are asked. A recursive resolver (the
 * system's, a forwarder in front of it, or a public one) caches a negative answer for the zone's negative TTL, and
 * asking it before the record is served poisons exactly the path the first real lookup takes; the Workers custom
 * domain's record has taken more than ten minutes to be served after its creation.
 */
export async function hostnameResolvesDirectly(hostname, { zone, servers, resolver = createResolver, tcpResolver = createTcpResolver, nameservers = authoritativeServers } = {}) {
  const candidates = servers ?? await nameservers(zone);
  let served = 0;
  for (const server of candidates) {
    let outcome = await answers(resolver(server), hostname);
    // A network that drops UDP port 53 to anything but its own resolver leaves every authoritative server unreachable
    // over UDP while TCP still reaches it; the same question is asked over TCP before the server counts as unreachable.
    if (outcome === 'unreachable') outcome = await answers(tcpResolver(server), hostname);
    if (outcome === 'negative') return false;
    if (outcome === 'records') served += 1;
  }
  return served > 0;
}

/** A resolver bound to one server, asked once with a short timeout; exported so the default path stays under test. */
export function createResolver(server) {
  const instance = new dns.Resolver({ timeout: 3_000, tries: 1 });
  instance.setServers([server]);
  return (hostname, type) => type === 'A' ? instance.resolve4(hostname) : instance.resolve6(hostname);
}

const RECORD_TYPES = { A: 1, AAAA: 28 };
const LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u;

function dnsError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

/** One DNS question in wire format, framed with the two-byte length prefix TCP transport requires. */
export function encodeDnsQuery(hostname, type, id) {
  const labels = hostname.split('.').filter((label) => label !== '');
  if (!(type in RECORD_TYPES) || labels.length === 0 || hostname.length > 253 || labels.some((label) => !LABEL.test(label)) ||
      !Number.isInteger(id) || id < 0 || id > 0xffff) throw dnsError('EBADQUERY');
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(0x0100, 2); // A standard query; recursion desired is ignored by an authoritative server.
  header.writeUInt16BE(1, 4);
  const name = Buffer.concat([...labels.map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label, 'ascii')])), Buffer.from([0])]);
  const question = Buffer.alloc(4);
  question.writeUInt16BE(RECORD_TYPES[type], 0);
  question.writeUInt16BE(1, 2);
  const message = Buffer.concat([header, name, question]);
  const framed = Buffer.alloc(2 + message.length);
  framed.writeUInt16BE(message.length, 0);
  message.copy(framed, 2);
  return framed;
}

/** The answer count of a response to the query with this id; throws the resolver's own codes for a denied name
 * (`ENOTFOUND`), a name without records of the type (`ENODATA`), and any other outcome. */
export function decodeDnsAnswer(message, id) {
  if (!Buffer.isBuffer(message) || message.length < 12 || message.readUInt16BE(0) !== id) throw dnsError('EBADRESP');
  const flags = message.readUInt16BE(2);
  if ((flags & 0x8000) === 0 || (flags & 0x0200) !== 0) throw dnsError('EBADRESP');
  const rcode = flags & 0x000f;
  if (rcode === 3) throw dnsError('ENOTFOUND');
  if (rcode !== 0) throw dnsError('ESERVFAIL');
  const count = message.readUInt16BE(6);
  if (count === 0) throw dnsError('ENODATA');
  return count;
}

/** The same one-shot question over TCP port 53, for a network that drops UDP to the authoritative servers. It resolves
 * to one placeholder per answer record and rejects with the codes the UDP resolver uses, so both answer alike. */
export function createTcpResolver(server, { connect = connectTcp, timeoutMs = 3_000, nextId = () => Math.floor(Math.random() * 0x10000) } = {}) {
  return (hostname, type) => new Promise((resolve, reject) => {
    const id = nextId();
    let query;
    try { query = encodeDnsQuery(hostname, type, id); } catch (error) { reject(error); return; }
    const socket = connect({ host: server, port: 53 });
    const chunks = [];
    let settled = false;
    const finish = (error, count) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error); else resolve(Array.from({ length: count }, () => type));
    };
    socket.setTimeout(timeoutMs, () => finish(dnsError('ETIMEOUT')));
    socket.on('error', () => finish(dnsError('ECONNREFUSED')));
    socket.on('close', () => finish(dnsError('ECONNRESET')));
    socket.on('connect', () => socket.write(query));
    socket.on('data', (chunk) => {
      chunks.push(chunk);
      const buffered = Buffer.concat(chunks);
      if (buffered.length < 2 || buffered.length < 2 + buffered.readUInt16BE(0)) return;
      try { finish(null, decodeDnsAnswer(buffered.subarray(2, 2 + buffered.readUInt16BE(0)), id)); } catch (error) { finish(error); }
    });
  });
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
