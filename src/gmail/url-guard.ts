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
 *     public — one private answer refuses the whole URL. Addresses are judged
 *     by value, not by spelling: an IPv6 address is expanded to its 16 bytes
 *     first, so the hex form of an IPv4-mapped address (`::ffff:7f00:1`, which
 *     is what Node's resolver actually returns for `[::ffff:127.0.0.1]`) is
 *     judged as the loopback address it is
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

/**
 * Expand any spelling of an IPv6 address into its 16 bytes, or null if it is
 * not a valid address.
 *
 * Matching on the text form is what let `::ffff:7f00:1` — the hex spelling of
 * `::ffff:127.0.0.1`, and the spelling Node's own resolver returns for a
 * bracketed IPv4-mapped literal — past the guard. An address has one value and
 * many spellings, so the comparison has to happen on the value.
 */
function parseIPv6(address: string): number[] | null {
  let addr = address.toLowerCase().split('%')[0]; // drop any zone index
  if (addr.length === 0) return null;

  // A trailing dotted quad (::ffff:127.0.0.1) becomes the last two hextets.
  const lastColon = addr.lastIndexOf(':');
  if (lastColon === -1) return null;
  const tail = addr.slice(lastColon + 1);
  if (tail.includes('.')) {
    const quad = parseIPv4(tail);
    if (!quad) return null;
    const hi = ((quad[0] << 8) | quad[1]).toString(16);
    const lo = ((quad[2] << 8) | quad[3]).toString(16);
    addr = `${addr.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const halves = addr.split('::');
  if (halves.length > 2) return null;

  const groupsOf = (segment: string): number[] | null => {
    if (segment === '') return [];
    const out: number[] = [];
    for (const group of segment.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      out.push(parseInt(group, 16));
    }
    return out;
  };

  let hextets: number[];
  if (halves.length === 2) {
    const head = groupsOf(halves[0]);
    const rest = groupsOf(halves[1]);
    if (!head || !rest) return null;
    const missing = 8 - head.length - rest.length;
    if (missing < 1) return null; // "::" must stand for at least one group
    hextets = [...head, ...new Array<number>(missing).fill(0), ...rest];
  } else {
    const only = groupsOf(halves[0]);
    if (!only || only.length !== 8) return null;
    hextets = only;
  }

  const bytes: number[] = [];
  for (const hextet of hextets) bytes.push(hextet >> 8, hextet & 0xff);
  return bytes;
}

const dotted = (octets: number[]): string => octets.join('.');

/**
 * True for any IPv6 address that is not routable public internet.
 *
 * An unparseable address is treated as private: the only caller is a security
 * gate, and refusing something we cannot understand is the safe direction.
 */
function isPrivateIPv6(address: string): boolean {
  const b = parseIPv6(address);
  if (!b) return true;

  const zeros = (upTo: number): boolean => b.slice(0, upTo).every(byte => byte === 0);

  // ::ffff:a.b.c.d — IPv4-mapped (RFC 4291). This is what Node hands back for a
  // bracketed IPv4-mapped literal, in hex.
  if (zeros(10) && b[10] === 0xff && b[11] === 0xff) {
    return isPrivateIPv4(dotted(b.slice(12)));
  }

  // ::ffff:0:a.b.c.d — IPv4-translated (RFC 6052).
  if (zeros(8) && b[8] === 0xff && b[9] === 0xff && b[10] === 0 && b[11] === 0) {
    return isPrivateIPv4(dotted(b.slice(12)));
  }

  // ::a.b.c.d — IPv4-compatible (deprecated), plus :: and ::1 themselves. The
  // whole /96 is dead space, so none of it is a legitimate request target.
  if (zeros(12)) return true;

  // 64:ff9b::/32 — the NAT64 translation prefixes.
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) {
    // 64:ff9b::/96 (well-known) carries the destination v4 in the low 32 bits.
    if (b.slice(4, 12).every(byte => byte === 0)) return isPrivateIPv4(dotted(b.slice(12)));
    // 64:ff9b:1::/48 (local-use) and the rest of the /32 embed the v4 address
    // at prefix-dependent offsets. A translation prefix is never something this
    // guard can vouch for, so refuse the lot rather than guess the layout.
    return true;
  }

  // 2002::/16 — 6to4 carries the v4 address in bytes 2-5.
  if (b[0] === 0x20 && b[1] === 0x02) return isPrivateIPv4(dotted(b.slice(2, 6)));

  if ((b[0] & 0xfe) === 0xfc) return true;                       // fc00::/7 unique local
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true;      // fe80::/10 link-local
  if (b[0] === 0xff) return true;                                // ff00::/8 multicast
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return true; // 2001:db8::/32
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00) return true; // 2001::/32 Teredo

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
