import assert from 'node:assert/strict';
import test from 'node:test';

import {
  base64ToBytes,
  charsetFromContentType,
  decodeBodyBytes,
  decodeResponseBody,
  formatJsonText,
  jsonNodeSummary,
  minifyJsonText,
  normalizeResponseEncoding,
  safeParseJson,
} from './responseBody';

const toBase64 = (bytes: number[]): string => Buffer.from(bytes).toString('base64');

test('normalizes encoding aliases', () => {
  assert.equal(normalizeResponseEncoding('UTF-8'), 'utf-8');
  assert.equal(normalizeResponseEncoding('gbk'), 'gb18030');
  assert.equal(normalizeResponseEncoding('GB2312'), 'gb18030');
  assert.equal(normalizeResponseEncoding('latin1'), 'iso-8859-1');
  assert.equal(normalizeResponseEncoding('nope'), 'auto');
  assert.equal(normalizeResponseEncoding(undefined), 'auto');
});

test('reads charset from a content type', () => {
  assert.equal(charsetFromContentType('application/json; charset=utf-8'), 'utf-8');
  assert.equal(charsetFromContentType('text/html;charset="GBK"'), 'gb18030');
  assert.equal(charsetFromContentType('text/plain'), null);
  assert.equal(charsetFromContentType(undefined), null);
});

test('decodes base64 bytes', () => {
  const bytes = base64ToBytes(toBase64([0x68, 0x69]));
  assert.deepEqual(Array.from(bytes ?? []), [0x68, 0x69]);
  assert.equal(base64ToBytes('%%%%'), null);
});

test('decodes the same bytes with several charsets', () => {
  const utf8 = base64ToBytes(toBase64(Array.from(Buffer.from('中文', 'utf8'))));
  assert.ok(utf8);
  assert.equal(decodeBodyBytes(utf8, 'utf-8'), '中文');
  assert.equal(decodeBodyBytes(utf8, 'auto'), '中文');

  const gbk = Array.from(Buffer.from([0xd6, 0xd0, 0xce, 0xc4]));
  assert.equal(decodeBodyBytes(new Uint8Array(gbk), 'gb18030'), '中文');

  const latin = Array.from(Buffer.from([0x63, 0x61, 0x66, 0xe9]));
  assert.equal(decodeBodyBytes(new Uint8Array(latin), 'iso-8859-1'), 'café');
});

test('decodeResponseBody tolerates missing bodies', () => {
  assert.equal(decodeResponseBody(undefined, 'utf-8'), null);
  assert.equal(decodeResponseBody('', 'utf-8'), null);
  assert.equal(decodeResponseBody(toBase64([0x6f, 0x6b]), 'utf-8'), 'ok');
});

test('formats and minifies JSON', () => {
  const formatted = formatJsonText('{"a":1,"b":[2,3]}');
  assert.equal(formatted.ok, true);
  assert.equal(formatted.ok ? formatted.text : '', '{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}');

  const minified = minifyJsonText('{ "a" : 1 }');
  assert.equal(minified.ok, true);
  assert.equal(minified.ok ? minified.text : '', '{"a":1}');

  const broken = formatJsonText('{"a":}');
  assert.equal(broken.ok, false);
  assert.equal(formatJsonText('').ok, false);
});

test('parses JSON safely and summarizes nodes', () => {
  assert.equal(safeParseJson('nope'), undefined);
  assert.deepEqual(safeParseJson('{"a":1}'), { a: 1 });
  assert.equal(jsonNodeSummary([1, 2, 3]), '3 items');
  assert.equal(jsonNodeSummary({ a: 1 }), '1 key');
  assert.equal(jsonNodeSummary(null), 'null');
  assert.equal(jsonNodeSummary('x'), 'string');
});
