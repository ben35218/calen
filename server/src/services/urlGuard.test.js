// The SSRF guard on user-influenced outbound fetches (spec: features/kitchen.md,
// "Recipe import fetches are SSRF-guarded"): scheme + credential rules, every
// private/loopback/link-local/metadata range blocked post-RESOLUTION (never by
// hostname string), and redirects re-vetted hop by hop so a public page can't
// bounce the fetch into the network the hostname check already refused.
const { test, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const dns = require('dns');
const axios = require('axios');

const { BlockedUrlError, isBlockedAddress, assertPublicUrl, fetchPublicUrl } = require('./urlGuard');

beforeEach(() => mock.restoreAll());

const stubLookup = (byHost) =>
  mock.method(dns.promises, 'lookup', async (host) => {
    const addresses = byHost[host];
    if (!addresses) throw new Error(`ENOTFOUND ${host}`);
    return addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  });

test('isBlockedAddress: every private, loopback, link-local, and metadata range', () => {
  const blocked = [
    '127.0.0.1', '127.8.8.8',            // loopback /8
    '10.0.0.1', '10.255.255.255',        // RFC1918
    '172.16.0.1', '172.31.255.255',      // RFC1918 /12
    '192.168.0.1', '192.168.255.1',      // RFC1918
    '169.254.169.254', '169.254.0.1',    // link-local incl. the metadata IP
    '100.64.0.1',                        // CGNAT
    '0.0.0.0', '0.1.2.3',                // "this network"
    '224.0.0.1', '255.255.255.255',      // multicast / broadcast
    '::1', '::',                         // v6 loopback / unspecified
    'fc00::1', 'fd12:3456::1',           // fc00::/7
    'fe80::1', 'febf::1',                // fe80::/10
    '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:169.254.169.254', // v4-mapped
    '64:ff9b::a00:1',                    // NAT64
    'not-an-ip', '',                     // garbage is never fetchable
  ];
  for (const ip of blocked) assert.equal(isBlockedAddress(ip), true, `${ip} must be blocked`);

  const allowed = [
    '93.184.216.34', '8.8.8.8', '151.101.1.140',
    '172.15.0.1', '172.32.0.1',  // just outside 172.16/12
    '100.63.0.1', '100.128.0.1', // just outside 100.64/10
    '169.253.0.1', '9.255.255.255', '11.0.0.1',
    '2606:4700::1111', '2001:4860:4860::8888',
  ];
  for (const ip of allowed) assert.equal(isBlockedAddress(ip), false, `${ip} must be allowed`);
});

test('assertPublicUrl: scheme and credential rules', async () => {
  await assert.rejects(assertPublicUrl('ftp://example.com/x'), BlockedUrlError);
  await assert.rejects(assertPublicUrl('file:///etc/passwd'), BlockedUrlError);
  await assert.rejects(assertPublicUrl('javascript:alert(1)'), BlockedUrlError);
  await assert.rejects(assertPublicUrl('not a url at all'), BlockedUrlError);
  await assert.rejects(assertPublicUrl('https://user:pass@example.com/'), BlockedUrlError);
});

test('assertPublicUrl: IP-literal hosts are judged directly', async () => {
  for (const host of ['127.0.0.1', '10.0.0.8', '172.16.5.5', '192.168.1.10', '169.254.169.254', '0.0.0.0', '[::1]', '[fc00::1]', '[fe80::1]']) {
    await assert.rejects(assertPublicUrl(`http://${host}/latest/meta-data`), BlockedUrlError, `${host} must be refused`);
  }
  const ok = await assertPublicUrl('https://93.184.216.34/recipe');
  assert.equal(ok.address, '93.184.216.34');
});

test('assertPublicUrl: hostnames are judged by what they RESOLVE to', async () => {
  stubLookup({
    'public.example': ['93.184.216.34'],
    'internal.example': ['10.0.0.5'],
    'rebind.example': ['93.184.216.34', '169.254.169.254'], // one bad answer poisons all
    'metadata.example': ['169.254.169.254'],
  });
  const ok = await assertPublicUrl('https://public.example/recipe');
  assert.equal(ok.address, '93.184.216.34', 'the vetted address is pinned for the fetch');
  await assert.rejects(assertPublicUrl('https://internal.example/'), BlockedUrlError);
  await assert.rejects(assertPublicUrl('https://metadata.example/'), BlockedUrlError);
  await assert.rejects(assertPublicUrl('https://rebind.example/'), BlockedUrlError);
  await assert.rejects(assertPublicUrl('https://does-not-resolve.example/'), BlockedUrlError);
});

test('fetchPublicUrl: a public host fetches once, with redirects disabled on the wire', async () => {
  stubLookup({ 'public.example': ['93.184.216.34'] });
  const get = mock.method(axios, 'get', async (url, config) => {
    assert.equal(url, 'https://public.example/recipe');
    assert.equal(config.maxRedirects, 0, 'axios must never follow a hop itself');
    assert.equal(typeof config.lookup, 'function', 'the socket pins the vetted address');
    await new Promise((resolve) => config.lookup('public.example', (err, address) => {
      assert.equal(address, '93.184.216.34');
      resolve();
    }));
    return { status: 200, headers: { 'content-type': 'text/html' }, data: '<html>soup</html>' };
  });
  const res = await fetchPublicUrl('https://public.example/recipe');
  assert.equal(res.data, '<html>soup</html>');
  assert.equal(get.mock.callCount(), 1);
});

test('fetchPublicUrl: a redirect to a private target is blocked before it is fetched', async () => {
  stubLookup({ 'public.example': ['93.184.216.34'] });
  const get = mock.method(axios, 'get', async () => ({
    status: 302,
    headers: { location: 'http://169.254.169.254/latest/meta-data/' },
    data: '',
  }));
  await assert.rejects(fetchPublicUrl('https://public.example/recipe'), BlockedUrlError);
  assert.equal(get.mock.callCount(), 1, 'the private hop was never requested');
});

test('fetchPublicUrl: a public → public redirect is followed, each hop vetted', async () => {
  stubLookup({ 'public.example': ['93.184.216.34'], 'cdn.example': ['151.101.1.140'] });
  const calls = [];
  mock.method(axios, 'get', async (url) => {
    calls.push(url);
    if (url === 'https://public.example/recipe') {
      return { status: 301, headers: { location: '/moved' }, data: '' }; // relative hop
    }
    return { status: 200, headers: {}, data: 'ok' };
  });
  // Relative Location resolves against the hop that sent it, then re-vets.
  const res = await fetchPublicUrl('https://public.example/recipe');
  assert.equal(res.data, 'ok');
  assert.deepEqual(calls, ['https://public.example/recipe', 'https://public.example/moved']);
});

test('fetchPublicUrl: redirect loops run out instead of running forever', async () => {
  stubLookup({ 'public.example': ['93.184.216.34'] });
  const get = mock.method(axios, 'get', async () => ({
    status: 302,
    headers: { location: 'https://public.example/again' },
    data: '',
  }));
  await assert.rejects(fetchPublicUrl('https://public.example/x', { maxRedirects: 3 }), BlockedUrlError);
  assert.equal(get.mock.callCount(), 4, 'the original request plus maxRedirects hops');
});
