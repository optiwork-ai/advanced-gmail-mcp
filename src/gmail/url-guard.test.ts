import { describe, expect, it } from 'vitest';
import { assertPublicHttpsUrl, isPrivateAddress, type LookupFn } from './url-guard.js';

/** A lookup that always answers with the given addresses. */
function resolvesTo(...addresses: string[]): LookupFn {
  return async () => addresses.map(address => ({ address, family: address.includes(':') ? 6 : 4 }));
}

const publicLookup = resolvesTo('93.184.216.34');

describe('isPrivateAddress — IPv4', () => {
  it.each([
    ['0.0.0.0', 'this network'],
    ['10.0.0.1', 'private'],
    ['10.255.255.255', 'private'],
    ['127.0.0.1', 'loopback'],
    ['127.255.255.254', 'loopback'],
    ['100.64.0.1', 'CGNAT'],
    ['100.127.255.255', 'CGNAT'],
    ['169.254.169.254', 'link-local / cloud metadata'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.168.1.1', 'private'],
    ['192.0.0.1', 'IETF protocol assignments'],
    ['192.0.2.1', 'TEST-NET-1'],
    ['198.18.0.1', 'benchmarking'],
    ['198.51.100.1', 'TEST-NET-2'],
    ['203.0.113.1', 'TEST-NET-3'],
    ['224.0.0.1', 'multicast'],
    ['255.255.255.255', 'broadcast'],
  ])('refuses %s (%s)', (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each([
    '8.8.8.8',
    '93.184.216.34',
    '1.1.1.1',
    '172.32.0.1',
    '100.63.255.255',
    '198.20.0.1',
    '192.1.0.1',
  ])('allows the public address %s', (address) => {
    expect(isPrivateAddress(address)).toBe(false);
  });
});

describe('isPrivateAddress — IPv6', () => {
  it.each([
    '::1',
    '::',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'feb0::1',
    'ff02::1',
    '2001:db8::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
    '::127.0.0.1',
    'fe80::1%en0',
  ])('refuses %s', (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each(['2606:4700:4700::1111', '2a00:1450:4001::200e', '::ffff:8.8.8.8'])(
    'allows the public address %s',
    (address) => {
      expect(isPrivateAddress(address)).toBe(false);
    },
  );
});

describe('isPrivateAddress — IPv6 forms that carry an IPv4 address', () => {
  // The dotted spellings above are only one way to write these. Node's own
  // resolver hands back the HEX form, so the guard has to judge the address,
  // not the spelling.
  it.each([
    ['::ffff:7f00:1', '127.0.0.1 IPv4-mapped, hex spelling'],
    ['::ffff:a9fe:a9fe', '169.254.169.254 cloud metadata, hex spelling'],
    ['::ffff:0a00:1', '10.0.0.1 IPv4-mapped, hex spelling'],
    ['0:0:0:0:0:ffff:7f00:0001', '127.0.0.1 fully expanded'],
    ['::FFFF:7F00:1', 'uppercase hex'],
    ['::ffff:0:127.0.0.1', '127.0.0.1 IPv4-translated (RFC 6052)'],
    ['::ffff:0:7f00:1', '127.0.0.1 IPv4-translated, hex'],
    ['64:ff9b::7f00:1', '127.0.0.1 behind the NAT64 well-known prefix'],
    ['64:ff9b::169.254.169.254', 'metadata behind NAT64'],
    ['64:ff9b:1::7f00:1', '127.0.0.1 behind a local-use NAT64 prefix'],
    ['2002:7f00:1::', '127.0.0.1 as a 6to4 address'],
    ['2002:a9fe:a9fe::1', 'metadata as a 6to4 address'],
    ['::0.0.0.0', 'IPv4-compatible zero'],
    ['0:0:0:0:0:0:0:1', 'loopback fully expanded'],
  ])('refuses %s (%s)', (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each([
    ['::ffff:808:808', '8.8.8.8 IPv4-mapped, hex spelling'],
    ['::ffff:0:8.8.8.8', '8.8.8.8 IPv4-translated'],
    ['64:ff9b::8.8.8.8', '8.8.8.8 behind NAT64'],
    ['2002:808:808::', '8.8.8.8 as a 6to4 address'],
  ])('allows %s (%s)', (address) => {
    expect(isPrivateAddress(address)).toBe(false);
  });

  it('refuses an address it cannot parse rather than assuming it is public', () => {
    expect(isPrivateAddress('::gggg')).toBe(true);
    expect(isPrivateAddress('1:2:3:4:5:6:7:8:9')).toBe(true);
    expect(isPrivateAddress(':::1')).toBe(true);
  });
});

describe('assertPublicHttpsUrl — against the REAL resolver', () => {
  // dns.lookup on an IP literal is answered locally, so this makes no network
  // request. It is here because the stubbed-resolver tests above cannot see
  // what Node actually returns for a bracketed IPv4-mapped literal: the hex
  // form, which is exactly the spelling the guard used to wave through.
  it.each([
    'https://[::ffff:127.0.0.1]/x',
    'https://[::1]/x',
    'https://[::ffff:169.254.169.254]/x',
    'https://127.0.0.1/x',
    'https://[64:ff9b::7f00:1]/x',
  ])('refuses %s', async (raw) => {
    await expect(assertPublicHttpsUrl(raw)).rejects.toThrow(/private\/loopback/);
  });

  it('still allows a public IPv6 literal', async () => {
    const url = await assertPublicHttpsUrl('https://[2606:4700:4700::1111]/x');
    expect(url.protocol).toBe('https:');
  });
});

describe('assertPublicHttpsUrl', () => {
  it('accepts an ordinary https URL that resolves publicly', async () => {
    const url = await assertPublicHttpsUrl('https://example.com/unsub?id=abc', publicLookup);
    expect(url.host).toBe('example.com');
  });

  it('refuses http://', async () => {
    await expect(
      assertPublicHttpsUrl('http://example.com/unsub', publicLookup),
    ).rejects.toThrow(/only https/);
  });

  it.each(['file:///etc/passwd', 'ftp://example.com/x', 'gopher://example.com/'])(
    'refuses the scheme in %s',
    async (raw) => {
      await expect(assertPublicHttpsUrl(raw, publicLookup)).rejects.toThrow(/only https/);
    },
  );

  it('refuses a URL that will not parse', async () => {
    await expect(assertPublicHttpsUrl('not a url', publicLookup)).rejects.toThrow(
      /not a valid URL/,
    );
  });

  it('refuses a loopback hostname', async () => {
    await expect(
      assertPublicHttpsUrl('https://localhost/unsub', resolvesTo('127.0.0.1')),
    ).rejects.toThrow(/private\/loopback address 127\.0\.0\.1/);
  });

  it('refuses a literal private IP', async () => {
    await expect(
      assertPublicHttpsUrl('https://192.168.1.1/unsub', resolvesTo('192.168.1.1')),
    ).rejects.toThrow(/private\/loopback/);
  });

  it('refuses the cloud metadata address', async () => {
    await expect(
      assertPublicHttpsUrl('https://metadata.example/unsub', resolvesTo('169.254.169.254')),
    ).rejects.toThrow(/169\.254\.169\.254/);
  });

  it('refuses a host that resolves to BOTH a public and a private address', async () => {
    await expect(
      assertPublicHttpsUrl('https://split.example/u', resolvesTo('93.184.216.34', '10.0.0.5')),
    ).rejects.toThrow(/10\.0\.0\.5/);
  });

  it('handles a bracketed IPv6 literal', async () => {
    await expect(
      assertPublicHttpsUrl('https://[::1]/unsub', resolvesTo('::1')),
    ).rejects.toThrow(/private\/loopback/);
  });

  it('refuses when the hostname does not resolve', async () => {
    const failing: LookupFn = async () => {
      throw new Error('ENOTFOUND');
    };
    await expect(assertPublicHttpsUrl('https://nope.example/u', failing)).rejects.toThrow(
      /could not resolve/,
    );
  });

  it('refuses when the hostname resolves to nothing', async () => {
    await expect(
      assertPublicHttpsUrl('https://empty.example/u', resolvesTo()),
    ).rejects.toThrow(/no addresses/);
  });
});
