/**
 * URL validation, applied to every outbound request without exception: the seed
 * URL the user typed, every link the crawler discovers, every redirect hop, and
 * every search result before it is fetched.
 *
 * A note on parsing. Obfuscated hosts — http://2130706433/, http://0177.0.0.1/,
 * http://0x7f000001/ — are all 127.0.0.1. Rather than pattern-match for those
 * forms (and miss one), we let the WHATWG URL parser normalise the host first:
 * it implements the same IPv4 parsing rules browsers do, so all three arrive
 * here already normalised to 127.0.0.1 and are caught by the ordinary address
 * check.
 */
import { promises as dns } from 'node:dns';
import type { NetworkPolicy } from './networkPolicy.js';

export type UrlRejectionCode =
  | 'URL_INVALID'
  | 'URL_SCHEME_UNSUPPORTED'
  | 'URL_CREDENTIALS_FORBIDDEN'
  | 'URL_BLOCKED_PORT'
  | 'URL_BLOCKED_PRIVATE'
  | 'FETCH_DNS_FAILURE';

export interface UrlCheckOk {
  ok: true;
  url: URL;
  /** Every address the hostname resolved to; all of them passed the policy. */
  addresses: string[];
}

export interface UrlCheckError {
  ok: false;
  code: UrlRejectionCode;
  message: string;
}

export type UrlCheckResult = UrlCheckOk | UrlCheckError;

/**
 * How a hostname is resolved. Injected rather than imported so that `core` takes
 * its environment as a parameter — which is what makes the rebinding and
 * split-horizon cases testable without touching real DNS.
 */
export type LookupFn = (hostname: string) => Promise<{ address: string }[]>;

export const systemLookup: LookupFn = async (hostname) =>
  dns.lookup(hostname, { all: true, verbatim: true });

/** Tracking parameters that make two identical pages look like two pages. */
const TRACKING_PARAMS = [
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'gclid', 'fbclid', 'mc_cid', 'mc_eid', 'ref', 'ref_src',
];

/**
 * Canonical form, so the crawler's "have I seen this?" set works and two spellings
 * of the same page are not both fetched.
 */
export function normaliseUrl(input: string | URL, base?: string | URL): URL | null {
  let url: URL;
  try {
    url = new URL(String(input), base ? String(base) : undefined);
  } catch {
    return null;
  }
  url.hash = '';
  url.hostname = url.hostname.toLowerCase();
  for (const param of TRACKING_PARAMS) url.searchParams.delete(param);
  // Collapse duplicate slashes in the path but keep the leading one.
  url.pathname = url.pathname.replace(/\/{2,}/g, '/');
  // A trailing slash on a non-root path is not a different page.
  if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.slice(0, -1);
  }
  if ((url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443')) {
    url.port = '';
  }
  return url;
}

/** Synchronous checks that need no DNS. Separated so they can be unit-tested alone. */
export function checkUrlShape(input: string | URL, policy: NetworkPolicy): UrlCheckResult {
  const url = normaliseUrl(input);
  if (url === null) {
    return { ok: false, code: 'URL_INVALID', message: `not a valid URL: ${String(input)}` };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return {
      ok: false,
      code: 'URL_SCHEME_UNSUPPORTED',
      message: `only http and https are fetched, got ${url.protocol}`,
    };
  }

  // http://user:pass@internal-host/ is a classic way to smuggle credentials or
  // confuse a naive host check. We never need them, so we never accept them.
  if (url.username !== '' || url.password !== '') {
    return {
      ok: false,
      code: 'URL_CREDENTIALS_FORBIDDEN',
      message: 'URLs carrying credentials are not fetched',
    };
  }

  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
  if (!policy.isAllowedPort(port)) {
    return { ok: false, code: 'URL_BLOCKED_PORT', message: `port ${port} is not permitted` };
  }

  // If the host is already a literal IP, judge it now — no DNS needed.
  const literal = hostAsIpLiteral(url.hostname);
  if (literal !== null && !policy.isAllowedAddress(literal)) {
    return {
      ok: false,
      code: 'URL_BLOCKED_PRIVATE',
      message: `${literal} is a private, loopback or reserved address`,
    };
  }

  return { ok: true, url, addresses: literal === null ? [] : [literal] };
}

/** Strip the brackets IPv6 hosts carry in a URL, and detect literal addresses. */
function hostAsIpLiteral(hostname: string): string | null {
  const unbracketed =
    hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  // A hostname with no dots and no colons is a bare name (e.g. "localhost"),
  // which still has to go through DNS to be judged.
  if (/^[0-9.]+$/.test(unbracketed) || unbracketed.includes(':')) return unbracketed;
  return null;
}

/**
 * Full validation: shape, then DNS, then every resolved address.
 *
 * Every address must pass. A hostname with one public A record and one private
 * one is rejected — resolving to a public address on the first lookup and a
 * private one on the second is exactly how a rebinding attack works.
 */
export async function validateUrl(
  input: string | URL,
  policy: NetworkPolicy,
  lookup: LookupFn = systemLookup,
): Promise<UrlCheckResult> {
  const shape = checkUrlShape(input, policy);
  if (!shape.ok) return shape;
  if (shape.addresses.length > 0) return shape; // literal IP, already judged

  let resolved: { address: string }[];
  try {
    resolved = await lookup(shape.url.hostname);
  } catch (error) {
    return {
      ok: false,
      code: 'FETCH_DNS_FAILURE',
      message: `could not resolve ${shape.url.hostname}: ${(error as Error).message}`,
    };
  }

  if (resolved.length === 0) {
    return {
      ok: false,
      code: 'FETCH_DNS_FAILURE',
      message: `${shape.url.hostname} resolved to no addresses`,
    };
  }

  const blocked = resolved.find((r) => !policy.isAllowedAddress(r.address));
  if (blocked !== undefined) {
    return {
      ok: false,
      code: 'URL_BLOCKED_PRIVATE',
      message: `${shape.url.hostname} resolves to ${blocked.address}, which is private, loopback or reserved`,
    };
  }

  return { ok: true, url: shape.url, addresses: resolved.map((r) => r.address) };
}
