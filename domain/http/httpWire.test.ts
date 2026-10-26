import assert from 'node:assert/strict';
import test from 'node:test';

import { createEmptyCurlRequest, type CurlRequest } from '../models/http';
import { base64Utf8, buildHttpWireRequest, classifyResponseBody } from './httpWire';

const make = (overrides: Partial<CurlRequest>): CurlRequest =>
  createEmptyCurlRequest('req-1', {
    name: 'demo',
    url: 'https://api.example.com/v1/items',
    ...overrides,
  });

test('buildHttpWireRequest keeps url, method and enabled headers', () => {
  const result = buildHttpWireRequest(
    make({
      method: 'POST',
      headers: [
        { id: 'h1', key: 'Accept', value: 'application/json', enabled: true },
        { id: 'h2', key: 'X-Skip', value: 'nope', enabled: false },
        { id: 'h3', key: '  ', value: 'empty', enabled: true },
      ],
    })
  );
  assert.equal(result.ok, true);
  const wire = (result as Extract<typeof result, { ok: true }>).wire;
  assert.equal(wire.method, 'POST');
  assert.equal(wire.url, 'https://api.example.com/v1/items');
  assert.deepEqual(wire.headers, [{ key: 'Accept', value: 'application/json' }]);
});

test('buildHttpWireRequest adds cookies and basic auth', () => {
  const result = buildHttpWireRequest(
    make({
      cookies: [
        { id: 'c1', key: 'sid', value: 'abc', enabled: true },
        { id: 'c2', key: 'theme', value: 'dark', enabled: false },
      ],
      auth: { kind: 'basic', username: 'alice', password: 's3cret' },
    })
  );
  assert.equal(result.ok, true);
  const wire = (result as Extract<typeof result, { ok: true }>).wire;
  assert.deepEqual(wire.headers, [
    { key: 'Cookie', value: 'sid=abc' },
    { key: 'Authorization', value: `Basic ${base64Utf8('alice:s3cret')}` },
  ]);
});

test('buildHttpWireRequest honours an explicit authorization header', () => {
  const result = buildHttpWireRequest(
    make({
      headers: [{ id: 'h1', key: 'Authorization', value: 'Token override', enabled: true }],
      auth: { kind: 'bearer', token: 'ignored' },
    })
  );
  const wire = (result as Extract<typeof result, { ok: true }>).wire;
  assert.deepEqual(wire.headers, [{ key: 'Authorization', value: 'Token override' }]);
});

test('buildHttpWireRequest appends api key to the query when asked', () => {
  const result = buildHttpWireRequest(
    make({
      url: 'https://api.example.com/search?q=cats',
      auth: { kind: 'apiKey', apiKeyName: 'api key', apiKeyValue: 'v/1', apiKeyIn: 'query' },
    })
  );
  const wire = (result as Extract<typeof result, { ok: true }>).wire;
  assert.equal(wire.url, 'https://api.example.com/search?q=cats&api%20key=v%2F1');
  assert.deepEqual(wire.headers, []);
});

test('buildHttpWireRequest adds a content type for bodies and drops bodies on GET', () => {
  const json = buildHttpWireRequest(
    make({ method: 'POST', body: { kind: 'json', text: '{"a":1}' } })
  );
  const jsonWire = (json as Extract<typeof json, { ok: true }>).wire;
  assert.equal(jsonWire.bodyText, '{"a":1}');
  assert.deepEqual(jsonWire.headers, [{ key: 'Content-Type', value: 'application/json' }]);

  const form = buildHttpWireRequest(
    make({ method: 'PUT', body: { kind: 'form', text: 'a=1&b=2' } })
  );
  assert.deepEqual((form as Extract<typeof form, { ok: true }>).wire.headers, [
    { key: 'Content-Type', value: 'application/x-www-form-urlencoded' },
  ]);

  const get = buildHttpWireRequest(make({ method: 'GET', body: { kind: 'text', text: 'ignored' } }));
  const getResult = get as Extract<typeof get, { ok: true }>;
  assert.equal(getResult.wire.bodyText, undefined);
  assert.deepEqual(getResult.warnings, ['body-dropped-for-method']);
});

test('buildHttpWireRequest refuses invalid urls and warns about url credentials', () => {
  assert.deepEqual(buildHttpWireRequest(make({ url: '   ' })), { ok: false, reason: 'invalid-url' });

  const withUserInfo = buildHttpWireRequest(make({ url: 'https://u:p@example.com/x' }));
  const result = withUserInfo as Extract<typeof withUserInfo, { ok: true }>;
  assert.equal(result.wire.url, 'https://example.com/x');
  assert.deepEqual(result.warnings, ['url-credentials-ignored']);
});

test('base64Utf8 encodes multi-byte text', () => {
  assert.equal(base64Utf8('a'), 'YQ==');
  assert.equal(base64Utf8('ab'), 'YWI=');
  assert.equal(base64Utf8('abc'), 'YWJj');
  assert.equal(base64Utf8('中文'), Buffer.from('中文', 'utf8').toString('base64'));
});

test('classifyResponseBody maps content types', () => {
  assert.equal(classifyResponseBody('application/json; charset=utf-8'), 'json');
  assert.equal(classifyResponseBody('text/html'), 'html');
  assert.equal(classifyResponseBody('application/xml'), 'xml');
  assert.equal(classifyResponseBody('text/plain'), 'text');
  assert.equal(classifyResponseBody('image/png'), 'binary');
  assert.equal(classifyResponseBody(undefined), 'binary');
});
