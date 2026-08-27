/**
 * Guard for the one place this server makes an outbound HTTP request to a URL
 * it did not choose: the RFC 8058 one-click unsubscribe POST.
 *
 * That URL comes out of an email header, which means it is chosen by whoever
 * sent the mail. Without a guard, anyone able to email the account could make
 * the MCP host POST to an address of their choosing — including
 * `http://localhost:…` and RFC 1918 space, which on a developer machine is a
 * server-side request forgery straight into the local network.
 *
 * The rules, deliberately narrow:
 *   - https only (no http, no other scheme)
 *   - the hostname must resolve, and EVERY address it resolves to must be
 *     public — one private answer refuses the whole URL
 *   - redirects are never followed (a 302 to 127.0.0.1 is the obvious bypass)
 *   - 10 second ceiling on the request
 *
 * Known and accepted limitation: this is a check-then-connect, so a DNS name
 * that answers publicly for the check and privately for the connection (DNS
 * rebinding) is not defeated by it. Closing that needs the socket pinned to the
 * validated address, which is more machinery than this one call justifies.
 */
import { promises as dns } from 'dns';

export type LookupFn = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

const defaultLookup: LookupFn = async (hostname) => {
  const results = await dns.lookup(hostname, { all: true, verbatim: true });
  return results.map(r => ({ address: r.address, family: r.family }));
};

/** Parse a dotted-quad into its four octets, or null if it is not one. */
function parseIPv4(address: string): number[] | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    octets.push(n);
  }
  return octets;
}

/**
 * True for any IPv4 address that is not routable public internet: loopback,
 * private, link-local, CGNAT, benchmarking, documentation, multicast, reserved.
 */
function isPrivateIPv4(address: string): boolean {
  const octets = parseIPv4(address);
  if (!octets) return false;
  const [a, b] = octets;

  if (a === 0) return true;                          // 0.0.0.0/8 "this network"
  if (a === 10) return true;                         // 10/8 private
  if (a === 127) return true;                        // 127/8 loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a === 169 && b === 254) return true;           // 169.254/16 link-local
  if (a === 172 && b >= 16 && b <= 31) return true;  // 172.16/12 private
  if (a === 192 && b === 168) return true;           // 192.168/16 private
  if (a === 192 && b === 0 && octets[2] === 0) return true;   // 192.0.0/24 IETF
  if (a === 192 && b === 0 && octets[2] === 2) return true;   // 192.0.2/24 TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true;       // 198.18/15 benchmarking
  if (a === 198 && b === 51 && octets[2] === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && octets[2] === 113) return true;  // TEST-NET-3
  if (a >= 224) return true;                         // 224/4 multicast + 240/4 reserved

  return false;
}

/** True for any IPv6 address that is not routable public internet. */
function isPrivateIPv6(address: string): boolean {
  const addr = address.toLowerCase().split('%')[0]; // drop any zone index

  if (addr === '::' || addr === '::1') return true;

  // IPv4-mapped (::ffff:1.2.3.4) and IPv4-compatible (::1.2.3.4) forms carry a
  // v4 address inside a v6 one — judge them by the v4 rules.
  const embedded = addr.match(/^::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (embedded) return isPrivateIPv4(embedded[1]);

  if (/^f[cd]/.test(addr)) return true;              // fc00::/7 unique local
  if (/^fe[89ab]/.test(addr)) return true;           // fe80::/10 link-local
  if (/^ff/.test(addr)) return true;                 // ff00::/8 multicast
  if (addr.startsWith('2001:db8')) return true;      // 2001:db8::/32 documentation

  return false;
}

/** True for any address that must never be the target of an outbound request. */
export function isPrivateAddress(address: string): boolean {
  return address.includes(':') ? isPrivateIPv6(address) : isPrivateIPv4(address);
}

/**
 * Validate a caller-supplied URL as a safe outbound POST target.
 *
 * Resolves and rejects, rather than returning a boolean, so the refusal reason
 * reaches the caller and can be reported instead of vanishing.
 */
export async function assertPublicHttpsUrl(
  rawUrl: string,
  lookup: LookupFn = defaultLookup,
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`refused: not a valid URL (${rawUrl})`);
  }

  if (url.protocol !== 'https:') {
    throw new Error(`refused: only https:// is allowed, got ${url.protocol}//`);
  }

  // URL.hostname keeps the brackets on an IPv6 literal; DNS does not want them.
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (hostname.length === 0) {
    throw new Error('refused: URL has no hostname');
  }

  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(hostname);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`refused: could not resolve ${hostname} (${reason})`);
  }

  if (addresses.length === 0) {
    throw new Error(`refused: ${hostname} resolved to no addresses`);
  }

  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      throw new Error(
        `refused: ${hostname} resolves to the private/loopback address ${address}`,
      );
    }
  }

  return url;
}
