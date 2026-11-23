import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

const blocked = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 3],
] as const)
  blocked.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
] as const)
  blocked.addSubnet(network, prefix, 'ipv6');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');

function isPublicAddress(address: string) {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, 'ipv4');
  return family === 6 && globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
}

export function publicPageUrl(value: string) {
  if (value.length > 2048 || /[\p{Cc}\s\\]/u.test(value)) return null;
  const url = URL.parse(value);
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    return null;
  }
  const host = url.hostname.replace(/^\[|\]$|\.$/g, '');
  if (isIP(host)) {
    if (!isPublicAddress(host)) return null;
  } else if (
    !host.includes('.') ||
    /\.(localhost|local|internal|home\.arpa|invalid|test)$/i.test(host)
  ) {
    return null;
  }
  url.hash = '';
  return url;
}

export async function isPublicPage(url: URL, signal: AbortSignal) {
  const host = url.hostname.replace(/^\[|\]$|\.$/g, '');
  signal.throwIfAborted();
  if (isIP(host)) return isPublicAddress(host);
  try {
    const addresses = await lookup(host, { all: true });
    signal.throwIfAborted();
    return addresses.length > 0 && addresses.every(({ address }) => isPublicAddress(address));
  } catch {
    signal.throwIfAborted();
    return false;
  }
}

function pathForScope(url: URL) {
  // Ambiguous encoded separators can be interpreted differently by an origin server.
  if (/%(?:25|2f|5c|00|3f|23)/i.test(url.pathname)) return null;
  return (
    url.pathname
      .replace(/%([a-f0-9]{2})/gi, (match, hex: string) => {
        const char = String.fromCharCode(Number.parseInt(hex, 16));
        return /^[a-z0-9._~-]$/i.test(char) ? char : match.toUpperCase();
      })
      .replace(/\/+$/, '') || '/'
  );
}

export function parseCrawlScopes(input: string): string[] | null {
  const entries = [
    ...new Set(
      input
        .split(/\r?\n/)
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
  if (entries.length > 30) return null;
  const result: string[] = [];
  for (const entry of entries) {
    if (entry === '*') {
      result.push(entry);
      continue;
    }
    const url = publicPageUrl(entry);
    const path = url && pathForScope(url);
    if (!url || !path || /[?#]/.test(entry)) return null;
    result.push(url.origin + path);
  }
  return [...new Set(result)];
}

export function pageWithinScope(url: URL, scope: URL) {
  const path = pathForScope(url);
  const prefix = pathForScope(scope);
  return Boolean(
    path &&
    prefix &&
    url.origin === scope.origin &&
    (prefix === '/' || path === prefix || path.startsWith(prefix + '/')),
  );
}

export function crawlAllowed(url: URL, scopes: readonly string[]) {
  if (!pathForScope(url)) return false;
  return scopes.some((scope) => {
    if (scope === '*') return true;
    const parent = publicPageUrl(scope);
    return parent !== null && pageWithinScope(url, parent);
  });
}

export function providerPathPatterns(seed: URL) {
  const path = pathForScope(seed);
  if (!path || path === '/') return undefined;
  const escaped = path.slice(1).replace(/[.*+?^\u0024{}()|[\]\\]/g, '\\$&');
  // Hosted Firecrawl and Firecrawl Local differ in whether the initial slash is present.
  return ['^/?' + escaped + '(/.*)?$'];
}
