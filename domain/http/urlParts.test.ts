import assert from 'node:assert/strict';
import test from 'node:test';

import {
  composeHttpUrl,
  httpEffectivePort,
  httpUrlOrigin,
  joinQueryString,
  parseHttpUrl,
  splitQueryString,
  updateHttpUrlParts,
  type HttpUrlParts,
} from './urlParts';

const parts = (input: string): HttpUrlParts => {
  const result = parseHttpUrl(input);
  assert.equal(result.ok, true, `expected ${input} to parse`);
  return (result as Extract<typeof result, { ok: true }>).parts;
};

test('parseHttpUrl splits scheme, host, port, path and query', () => {
  const parsed = parts('https://api.example.com:8443/v1/items?page=2&tag=a&tag=b');
  assert.deepEqual(parsed, {
    scheme: 'https',
    host: 'api.example.com',
    port: 8443,
    path: '/v1/items',
    query: 'page=2&tag=a&tag=b',
  });
});

test('parseHttpUrl defaults the scheme to https and the path to /', () => {
  assert.deepEqual(parts('api.example.com'), {
    scheme: 'https',
    host: 'api.example.com',
    port: null,
    path: '/',
    query: '',
  });
});

test('parseHttpUrl drops default ports and empty ports', () => {
  assert.equal(parts('https://example.com:443/').port, null);
  assert.equal(parts('http://example.com:80/').port, null);
  assert.equal(parts('https://example.com:/').port, null);
  assert.equal(parts('http://example.com:443/').port, 443);
});

test('parseHttpUrl reads IPv6 literals with and without brackets', () => {
  assert.deepEqual(parts('http://[::1]:8080/ping'), {
    scheme: 'http',
    host: '::1',
    port: 8080,
    path: '/ping',
    query: '',
  });
  assert.equal(parts('http://::1/ping').host, '::1');
  assert.equal(parts('http://[2001:db8::1]/').host, '2001:db8::1');
});

test('parseHttpUrl moves userinfo out of the URL text', () => {
  const result = parseHttpUrl('https://alice:s3cret@example.com/private');
  assert.equal(result.ok, true);
  const ok = result as Extract<typeof result, { ok: true }>;
  assert.equal(ok.parts.host, 'example.com');
  assert.deepEqual(ok.notes.userInfo, { username: 'alice', password: 's3cret' });
});

test('parseHttpUrl drops the fragment', () => {
  const result = parseHttpUrl('https://example.com/page#section');
  assert.equal(result.ok, true);
  const ok = result as Extract<typeof result, { ok: true }>;
  assert.equal(ok.parts.path, '/page');
  assert.equal(ok.notes.fragment, 'section');
});

test('parseHttpUrl reports invalid input', () => {
  assert.deepEqual(parseHttpUrl('   '), { ok: false, reason: 'empty' });
  assert.deepEqual(parseHttpUrl('ftp://example.com'), { ok: false, reason: 'unsupported-scheme' });
  assert.deepEqual(parseHttpUrl('https://:443/'), { ok: false, reason: 'invalid-host' });
  assert.deepEqual(parseHttpUrl('https://example.com:abc/'), { ok: false, reason: 'invalid-port' });
  assert.deepEqual(parseHttpUrl('https://example.com:70000/'), { ok: false, reason: 'invalid-port' });
});

test('composeHttpUrl round-trips normalized URLs', () => {
  const cases = [
    'https://api.example.com/v1/items?page=2',
    'http://127.0.0.1:8080/ping',
    'http://[::1]:9000/ipv6',
    'https://example.com:8443/a/b?x=1&y=',
  ];
  for (const input of cases) {
    const once = composeHttpUrl(parts(input));
    const twice = composeHttpUrl(parts(once));
    assert.equal(twice, once, `compose should be idempotent for ${input}`);
  }
  assert.equal(composeHttpUrl(parts('https://example.com')), 'https://example.com/');
});

test('updateHttpUrlParts keeps explicit ports but collapses scheme defaults', () => {
  const base = parts('http://example.com:80/a');
  const switched = updateHttpUrlParts(base, { scheme: 'https' });
  assert.equal(switched.port, null);
  assert.equal(composeHttpUrl(switched), 'https://example.com/a');

  const custom = parts('http://example.com:8080/a');
  const kept = updateHttpUrlParts(custom, { scheme: 'https' });
  assert.equal(kept.port, 8080);
  assert.equal(composeHttpUrl(kept), 'https://example.com:8080/a');
});

test('query helpers preserve order and duplicates', () => {
  const rows = splitQueryString('a=1&b=&c&a=2');
  assert.deepEqual(rows, [
    { key: 'a', value: '1' },
    { key: 'b', value: '' },
    { key: 'c', value: '' },
    { key: 'a', value: '2' },
  ]);
  assert.equal(joinQueryString(rows), 'a=1&b=&c=&a=2');
  assert.equal(joinQueryString([{ key: '', value: '' }, { key: 'q', value: 'a b' }]), 'q=a b');
});

test('port helpers expose effective port and origin', () => {
  assert.equal(httpEffectivePort(parts('https://example.com')), 443);
  assert.equal(httpEffectivePort(parts('http://example.com:8080')), 8080);
  assert.equal(httpUrlOrigin(parts('https://example.com:8443/x')), 'https://example.com:8443');
  assert.equal(httpUrlOrigin(parts('http://[::1]:81/')), 'http://[::1]:81');
});
