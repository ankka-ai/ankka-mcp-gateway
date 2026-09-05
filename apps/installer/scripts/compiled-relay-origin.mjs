const DECLARATION = "export const CLOUDFLARE_CODE_RELAY_ORIGIN = 'https://auth.ankka.ai';";

/** An isolated installer has a deterministic sibling service below its own hostname. */
export function compiledRelayOrigin(installerOrigin) {
  const url = new URL(installerOrigin);
  if (url.protocol !== 'https:' || url.origin !== installerOrigin || url.username || url.password ||
      !/^[a-z0-9.-]+$/u.test(url.hostname)) throw new Error('relay_origin_invalid');
  if (installerOrigin === 'https://deploy.ankka.ai') return 'https://auth.ankka.ai';
  const hostname = `auth.${url.hostname}`;
  if (hostname.length > 253 || hostname.split('.').some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label))) {
    throw new Error('relay_origin_invalid');
  }
  return `https://${hostname}`;
}

export function compileRelayOrigin(source, installerOrigin) {
  if (source.split(DECLARATION).length !== 2) throw new Error('relay_origin_anchor_invalid');
  return source.replace(DECLARATION,
    `export const CLOUDFLARE_CODE_RELAY_ORIGIN = ${JSON.stringify(compiledRelayOrigin(installerOrigin))};`);
}
