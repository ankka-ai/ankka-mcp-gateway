import * as v from 'valibot';
import { validateLiveBootstrapOrigin } from './live-gateway-browser.mjs';
import { LiveLifecycleError } from './live-gateway-lifecycle.mjs';

function requireCondition(value, code) { if (!value) throw new LiveLifecycleError(code); }
const id = (value) => v.is(v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{1,128}$/u)), value);

/** Read-only provider evidence. No arbitrary URL, grant forwarding, or deletion. */
export function createLiveGatewayProvider({ config, token, transport = fetch }) {
  requireCondition(/^[a-f0-9]{32}$/u.test(config.accountId) && /^[a-f0-9]{32}$/u.test(config.zoneId) && token, 'provider_config_invalid');
  const account = `/accounts/${config.accountId}`;
  const zone = `/zones/${config.zoneId}`;
  async function read(path, allowAbsent = false) {
    requireCondition(path.startsWith(`${account}/`) || path === zone || path.startsWith(`${zone}/`), 'provider_path_invalid');
    requireCondition(new URL(`https://api.cloudflare.com/client/v4${path}`).pathname === `/client/v4${path.split('?')[0]}` &&
      !path.includes('#') && !path.includes('%'), 'provider_path_invalid');
    let response;
    try { response = await transport(`https://api.cloudflare.com/client/v4${path}`, {
      headers: { authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(30_000),
    }); } catch { throw new LiveLifecycleError('provider_read_failed'); }
    if (allowAbsent && response.status === 404) { await response.body?.cancel(); return null; }
    if (!response.ok) { await response.body?.cancel(); throw new LiveLifecycleError('provider_read_rejected'); }
    let body;
    try {
      const reader = response.body.getReader();
      const chunks = []; let size = 0;
      for (;;) {
        const item = await reader.read(); if (item.done) break;
        size += item.value.length;
        if (size > 4 * 1024 * 1024) { await reader.cancel(); throw new Error(); }
        chunks.push(item.value);
      }
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch { throw new LiveLifecycleError('provider_response_invalid'); }
    requireCondition(body?.success === true && (body.errors?.length ?? 0) === 0, 'provider_response_rejected');
    return body;
  }
  async function list(path) {
    const values = [];
    for (let page = 1; page <= 100; page += 1) {
      const response = await read(`${path}${path.includes('?') ? '&' : '?'}page=${page}&per_page=100`);
      requireCondition(Array.isArray(response.result), 'provider_list_invalid');
      values.push(...response.result);
      const info = response.result_info;
      const pages = info?.total_pages ?? (Number.isSafeInteger(info?.total_count) && info?.per_page > 0
        ? Math.max(1, Math.ceil(info.total_count / info.per_page)) : null);
      // Some bounded account endpoints return an unpaginated array. Do not
      // assume a full page with missing metadata is the complete inventory.
      if (pages === null && response.result.length < 100 || pages !== null && page >= pages) return values;
    }
    throw new LiveLifecycleError('provider_pagination_incomplete');
  }
  const portals = () => list(`${account}/access/ai-controls/mcp/portals`);
  const apps = () => list(`${account}/access/apps`);
  const domains = () => list(`${account}/workers/domains`);
  const dns = () => list(`${zone}/dns_records?name.exact=${encodeURIComponent(config.basics.portalHostname)}`);
  async function namespaces(workerName) {
    return (await list(`${account}/workers/durable_objects/namespaces`)).filter((item) => item.script === workerName || item.script_name === workerName);
  }
  function locator(path, item, dependency) {
    requireCondition(id(item.id), 'provider_resource_id_invalid');
    return { path: `${path}/${encodeURIComponent(item.id)}`, dependency };
  }
  async function absent(inventory, dependenciesOnly) {
    requireCondition(inventory?.schemaVersion === 1 && inventory.accountId === config.accountId &&
      inventory.zoneId === config.zoneId && Array.isArray(inventory.resources), 'inventory_invalid');
    validateLiveBootstrapOrigin(inventory.provision);
    for (const item of inventory.resources) {
      if (!dependenciesOnly || item.dependency) requireCondition(await read(item.path, true) === null, 'owned_resource_still_present');
    }
    requireCondition((await portals()).every((item) => item.hostname !== config.basics.portalHostname), 'portal_still_present');
    requireCondition((await dns()).length === 0, 'portal_dns_still_present');
    if (!dependenciesOnly) {
      requireCondition((await domains()).every((item) => item.hostname !== config.basics.managementHostname &&
        item.service !== inventory.provision.workerName), 'management_domain_still_present');
      requireCondition((await namespaces(inventory.provision.workerName)).length === 0, 'worker_namespace_still_present');
    }
  }
  return {
    async metrics(provision) {
      validateLiveBootstrapOrigin(provision);
      const now = Date.now();
      const to = new Date(now).toISOString();
      const from = new Date(now - 30 * 60_000).toISOString();
      const query = `query($accountTag:string!,$scriptName:string!,$from:Time!,$to:Time!){viewer{accounts(filter:{accountTag:$accountTag}){workersInvocationsAdaptive(limit:100,filter:{scriptName:$scriptName,datetime_geq:$from,datetime_leq:$to}){sum{requests errors subrequests}quantiles{cpuTimeP50 cpuTimeP99 memoryUsageBytesP99}}}}}`;
      const response = await transport('https://api.cloudflare.com/client/v4/graphql', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ query, variables: { accountTag: config.accountId, scriptName: provision.workerName, from, to } }),
      });
      if (!response.ok) { await response.body?.cancel(); return null; }
      const reader = response.body.getReader(); const chunks = []; let size = 0;
      for (;;) {
        const item = await reader.read(); if (item.done) break;
        size += item.value.length;
        if (size > 128 * 1024) { await reader.cancel(); return null; }
        chunks.push(item.value);
      }
      const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      return result.errors?.length ? null : result.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive;
    },
    async assertFresh() {
      const target = (await read(zone)).result;
      requireCondition(target?.name === config.basics.zoneName && target.account?.id === config.accountId, 'zone_account_mismatch');
      requireCondition((await portals()).every((item) => item.hostname !== config.basics.portalHostname) &&
        (await apps()).every((item) => ![config.basics.portalHostname, config.basics.managementHostname].includes(item.domain)) &&
        (await domains()).every((item) => item.hostname !== config.basics.managementHostname) && (await dns()).length === 0,
      'fresh_gateway_hostnames_required');
    },
    async assertWorker(provision) {
      validateLiveBootstrapOrigin(provision);
      requireCondition(await read(`${account}/workers/workers/${provision.workerName}`, true) !== null, 'worker_account_mismatch');
    },
    async capture(provision) {
      validateLiveBootstrapOrigin(provision);
      const ownedPortals = (await portals()).filter((item) => item.hostname === config.basics.portalHostname);
      requireCondition(ownedPortals.length === 1 && v.is(v.string(), ownedPortals[0].description), 'portal_inventory_invalid');
      const marker = ownedPortals[0].description.match(/^(acg:v1:[^:]+:)/u)?.[1];
      requireCondition(marker, 'portal_ownership_marker_missing');
      const portal = (await read(`${account}/access/ai-controls/mcp/portals/${encodeURIComponent(ownedPortals[0].id)}`)).result;
      requireCondition(portal?.servers?.length === 1, 'portal_mapping_inventory_invalid');
      const serverId = portal.servers[0].server_id ?? portal.servers[0].id;
      const servers = (await list(`${account}/access/ai-controls/mcp/servers`)).filter((item) => item.id === serverId);
      requireCondition(servers.length === 1 && servers[0].hostname === config.source.url, 'source_inventory_invalid');
      const ownedApps = (await apps()).filter((item) => item.destinations?.some((destination) => destination.mcp_server_id === serverId) ||
        [config.basics.portalHostname, config.basics.managementHostname].includes(item.domain));
      requireCondition(ownedApps.length === 3, 'access_inventory_incomplete');
      const resources = [locator(`${account}/access/ai-controls/mcp/portals`, ownedPortals[0], true),
        ...servers.map((item) => locator(`${account}/access/ai-controls/mcp/servers`, item, true))];
      for (const app of ownedApps) {
        const dependency = app.domain !== config.basics.managementHostname;
        const appPath = `${account}/access/apps/${encodeURIComponent(app.id)}`;
        const policies = await list(`${appPath}/policies`);
        requireCondition(policies.length === 1, 'policy_inventory_incomplete');
        resources.push(...policies.map((item) => locator(`${appPath}/policies`, item, dependency)), locator(`${account}/access/apps`, app, dependency));
      }
      const records = await dns();
      requireCondition(records.length === 1 && records[0].comment?.startsWith(marker), 'dns_inventory_invalid');
      resources.push(locator(`${zone}/dns_records`, records[0], true));
      const managementDomains = (await domains()).filter((item) => item.hostname === config.basics.managementHostname && item.service === provision.workerName);
      requireCondition(managementDomains.length === 1, 'domain_inventory_incomplete');
      resources.push(locator(`${account}/workers/domains`, managementDomains[0], false));
      const storage = await namespaces(provision.workerName);
      requireCondition(storage.length === 1, 'namespace_inventory_incomplete');
      resources.push({ path: `${account}/workers/workers/${provision.workerName}`, dependency: false });
      return { schemaVersion: 1, accountId: config.accountId, zoneId: config.zoneId, provision, resources };
    },
    assertDependenciesAbsent: (inventory) => absent(inventory, true),
    assertAllAbsent: (inventory) => absent(inventory, false),
  };
}
