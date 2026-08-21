/**
 * URL validation and normalisation for stored targets.
 *
 * A shortener is a redirect primitive, so an unvalidated target turns the
 * service into an open redirect that launders a link's origin — and, worse,
 * lets someone mint a public `https://short/x` that points at
 * `http://169.254.169.254/latest/meta-data/` on a cloud host.
 *
 * Scope note: Kestrel never fetches the target itself, so this checks the URL
 * as written rather than resolving DNS. That blocks literal-address abuse; a
 * hostname that resolves to a private address is out of scope for v1 and is
 * recorded as such in Rules.md §5 rather than silently assumed away.
 */

import { AppError } from './errors.js';

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/** Hostnames that always mean "this machine", whatever DNS says. */
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'metadata',
  'metadata.google.internal',
  'instance-data',
]);

export const MAX_URL_LENGTH = 2048;

function parseIpv4(host: string): [number, number, number, number] | null {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const nums: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    nums.push(n);
  }
  return [nums[0] as number, nums[1] as number, nums[2] as number, nums[3] as number];
}

/** RFC1918, loopback, link-local (incl. the cloud metadata address), CGNAT, and friends. */
function isPrivateIpv4(host: string): boolean {
  const octets = parseIpv4(host);
  if (octets === null) return false;
  const [a, b] = octets;
  if (a === 0) return true; // "this network"
  if (a === 10) return true; // RFC1918
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local, includes 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 192 && b === 0) return true; // IETF protocol assignments
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
}

function isPrivateIpv6(host: string): boolean {
  // URL.hostname keeps IPv6 literals in brackets.
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === '::1' || h === '::') return true;
  if (h.startsWith('fc') || h.startsWith('fd')) return true; // unique local
  if (h.startsWith('fe80')) return true; // link-local
  if (h.startsWith('::ffff:')) {
    // IPv4-mapped IPv6 — check the embedded address rather than trusting the form.
    return isPrivateIpv4(h.slice(7));
  }
  return false;
}

export function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(h)) return true;
  if (h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h.includes(':') || h.startsWith('[')) return isPrivateIpv6(h);
  return isPrivateIpv4(h);
}

export interface UrlValidationOptions {
  /** Local hosts are legitimate targets in development; production leaves this off. */
  allowPrivateHosts?: boolean;
}

/**
 * Validate and normalise a target URL.
 *
 * Returns the normalised href. Throws AppError('UNSAFE_URL' | 'VALIDATION_FAILED')
 * with a message safe to show the caller.
 */
export function normaliseTargetUrl(input: string, options: UrlValidationOptions = {}): string {
  const raw = input.trim();

  if (raw.length === 0) {
    throw new AppError('VALIDATION_FAILED', 'URL is required');
  }
  if (raw.length > MAX_URL_LENGTH) {
    throw new AppError('VALIDATION_FAILED', `URL exceeds ${MAX_URL_LENGTH} characters`);
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError('VALIDATION_FAILED', 'URL is not well-formed. Include the scheme, e.g. https://example.com');
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new AppError('UNSAFE_URL', `Scheme "${url.protocol.replace(':', '')}" is not allowed. Use http or https.`, {
      details: { allowed: ['http', 'https'] },
    });
  }

  if (url.hostname.length === 0) {
    throw new AppError('VALIDATION_FAILED', 'URL is missing a host');
  }

  if (url.username !== '' || url.password !== '') {
    // Credentials in a shortened link are a phishing pattern and would be stored in plaintext.
    throw new AppError('UNSAFE_URL', 'URLs containing credentials are not allowed');
  }

  if (options.allowPrivateHosts !== true && isBlockedHost(url.hostname)) {
    throw new AppError('UNSAFE_URL', 'URLs pointing at private, loopback, or link-local addresses are not allowed', {
      details: { host: url.hostname },
    });
  }

  // `URL` already normalises scheme and host case, punycodes IDNs, and resolves
  // dot segments. We deliberately stop there: query parameter order and path
  // case can be semantically meaningful to the target, so stripping or
  // reordering them would change where the link points.
  //
  // Note this means a bare origin stores with its trailing slash
  // ("https://example.com" -> "https://example.com/"), which is the WHATWG
  // normal form for http(s).
  return url.toString();
}
