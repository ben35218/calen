// SSRF guard for user-influenced outbound fetches (spec: features/kitchen.md,
// "Recipe import fetches are SSRF-guarded").
//
// Two kitchen routes fetch URLs an outsider chooses: the recipe URL import
// fetches the pasted page, and the photo pipeline then fetches the og:image
// URL that page advertises. Both responses feed the AI extraction — a read-back
// channel — so an unguarded fetch lets a crafted URL (or a public page with a
// crafted og:image) read cloud metadata endpoints, localhost admin ports, or
// anything else on the server's network segment.
//
// The guard: http/https only, no embedded credentials; the hostname is
// DNS-resolved and EVERY resolved address must be public (one private A record
// among many is still a block); the connection is then PINNED to the vetted
// address via a custom `lookup`, so the actual socket cannot re-resolve to a
// different host (DNS rebinding). Redirects are never followed automatically —
// each hop re-runs the full guard before it is fetched, closing the
// public-page-redirects-to-metadata hole. Size and time are always capped.

const dns = require('dns');
const net = require('net');
const axios = require('axios');

// Thrown for any URL the guard refuses (and for redirect overruns). Routes
// branch on `.blocked` to answer 400 instead of 500.
class BlockedUrlError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BlockedUrlError';
    this.blocked = true;
  }
}

// Whether an IP (as a resolver returns it) is anything other than a public
// unicast address. Deny-by-category rather than an allowlist of known-bad
// ranges: multicast/reserved space is as unfetchable as loopback.
function isBlockedAddress(ip) {
  if (typeof ip !== 'string' || !ip) return true;
  if (net.isIPv4(ip)) return isBlockedV4(ip);
  const lower = ip.toLowerCase();
  // IPv4-mapped IPv6 (::ffff:169.254.169.254) is judged as its embedded v4.
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedV4(mapped[1]);
  if (net.isIPv6(ip)) return isBlockedV6(lower);
  return true; // not an IP at all — never fetchable
}

function isBlockedV4(ip) {
  const [a, b] = ip.split('.').map(Number);
  if (a === 0) return true;                      // 0.0.0.0/8 ("this network")
  if (a === 127) return true;                    // loopback
  if (a === 10) return true;                     // RFC1918
  if (a === 172 && b >= 16 && b <= 31) return true;  // RFC1918
  if (a === 192 && b === 168) return true;       // RFC1918
  if (a === 169 && b === 254) return true;       // link-local incl. 169.254.169.254
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT (100.64/10)
  if (a === 192 && b === 0) return true;         // 192.0.0/24 + 192.0.2/24 (protocol/testnet)
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true;                     // multicast, reserved, broadcast
  return false;
}

function isBlockedV6(ip) {
  if (ip === '::' || ip === '::1') return true;  // unspecified, loopback
  if (/^f[cd]/.test(ip)) return true;            // fc00::/7 unique-local
  if (/^fe[89ab]/.test(ip)) return true;         // fe80::/10 link-local
  if (ip.startsWith('64:ff9b:')) return true;    // NAT64 — wraps arbitrary v4
  return false;
}

// Parse + vet one URL: scheme, no credentials, and a resolution in which every
// address is public. Returns { url, address } — the address the fetch must pin.
// The resolver goes through `dns.promises.lookup` at call time (tests stub it).
async function assertPublicUrl(urlString) {
  let url;
  try {
    url = new URL(String(urlString));
  } catch {
    throw new BlockedUrlError('Not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BlockedUrlError('Only http and https URLs can be fetched');
  }
  // user:pass@host is only ever used to confuse parsers/log readers.
  if (url.username || url.password) {
    throw new BlockedUrlError('URLs with embedded credentials are not fetched');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, ''); // bare v6 literal
  let addresses;
  if (net.isIP(hostname)) {
    addresses = [hostname];
  } else {
    try {
      const resolved = await dns.promises.lookup(hostname, { all: true, verbatim: true });
      addresses = resolved.map((r) => r.address);
    } catch {
      throw new BlockedUrlError('Host could not be resolved');
    }
  }
  if (!addresses.length || addresses.some(isBlockedAddress)) {
    throw new BlockedUrlError('URL resolves to a blocked address');
  }
  return { url, address: addresses[0] };
}

// Fetch a vetted URL with redirects stepped MANUALLY: axios follows nothing
// itself; each Location is resolved against the hop that sent it and re-vetted
// before it is fetched. The socket for each hop pins the address that passed
// vetting (custom `lookup`), so the fetch cannot re-resolve behind the guard's
// back. Response size and duration stay capped on every hop.
async function fetchPublicUrl(urlString, {
  timeout = 10_000,
  maxBytes = 5 * 1024 * 1024,
  maxRedirects = 3,
  responseType = 'text',
  headers,
} = {}) {
  let target = urlString;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const { url, address } = await assertPublicUrl(target);
    const family = net.isIPv6(address) ? 6 : 4;
    const res = await axios.get(url.toString(), {
      timeout,
      maxContentLength: maxBytes,
      maxBodyLength: maxBytes,
      responseType,
      headers,
      maxRedirects: 0,
      validateStatus: (s) => (s >= 200 && s < 300) || (s >= 300 && s < 400),
      // Pin the connection to the vetted address. Node's lookup callback may
      // arrive as (host, cb) or (host, options, cb).
      lookup: (host, options, callback) => {
        const cb = typeof options === 'function' ? options : callback;
        cb(null, address, family);
      },
    });
    if (res.status >= 300) {
      const location = res.headers?.location;
      if (!location || hop === maxRedirects) {
        throw new BlockedUrlError('Too many redirects');
      }
      let next;
      try {
        next = new URL(location, url).toString();
      } catch {
        throw new BlockedUrlError('Redirected to an invalid URL');
      }
      target = next; // re-vetted at the top of the next hop
      continue;
    }
    return res;
  }
  throw new BlockedUrlError('Too many redirects');
}

module.exports = { BlockedUrlError, isBlockedAddress, assertPublicUrl, fetchPublicUrl };
