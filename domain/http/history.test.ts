import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HTTP_HISTORY_BODY_LIMIT,
  HTTP_HISTORY_LIMIT,
  addHttpHistoryEntry,
  historyEntryHasBody,
  sanitizeHttpHistory,
  type HttpHistoryEntry,
} from './history';

const makeEntry = (overrides: Partial<HttpHistoryEntry> = {}): HttpHistoryEntry => ({
  id: 'hist-1',
  method: 'GET',
  url: 'https://api.example.com/x',
  status: 200,
  durationMs: 12,
  at: 1,
  ...overrides,
});

test('keeps request and response snapshots', () => {
  const [entry] = sanitizeHttpHistory([
    makeEntry({
      request: {
        method: 'POST',
        url: 'https://api.example.com/x',
        headers: [{ key: 'content-type', value: 'application/json' }],
        bodyKind: 'json',
        bodyText: '{"a":1}',
      },
      response: {
        status: 201,
        statusText: 'Created',
        durationMs: 30,
        sizeBytes: 17,
        contentType: 'application/json',
        bodyKind: 'json',
        headers: [{ key: 'server', value: 'nginx' }],
        bodyText: '{"ok":true}',
      },
    }),
  ]);
  assert.equal(entry.request?.method, 'POST');
  assert.equal(entry.request?.bodyText, '{"a":1}');
  assert.equal(entry.response?.status, 201);
  assert.equal(entry.response?.bodyText, '{"ok":true}');
  assert.equal(entry.response?.headers[0].value, 'nginx');
  assert.equal(historyEntryHasBody(entry), true);
});

test('drops oversized bodies but keeps the entry', () => {
  const [entry] = sanitizeHttpHistory([
    makeEntry({
      response: {
        status: 200,
        statusText: 'OK',
        durationMs: 1,
        sizeBytes: 10,
        headers: [],
        bodyText: 'x'.repeat(HTTP_HISTORY_BODY_LIMIT + 1),
      },
    }),
  ]);
  assert.equal(entry.response?.bodyText, undefined);
  assert.equal(entry.response?.bodyOmitted, true);
  assert.equal(historyEntryHasBody(entry), false);
});

test('accepts legacy entries without snapshots', () => {
  const [entry] = sanitizeHttpHistory([{ id: 'h', method: 'GET', url: 'https://a.b', status: 200, durationMs: 3, at: 5 }]);
  assert.equal(entry.request, undefined);
  assert.equal(entry.response, undefined);
});

test('drops entries without a url and caps the list', () => {
  assert.deepEqual(sanitizeHttpHistory([{ method: 'GET' }, null, 'x']), []);
  const many = Array.from({ length: HTTP_HISTORY_LIMIT + 5 }, (_, index) =>
    makeEntry({ id: `h-${index}`, url: `https://a.b/${index}` }),
  );
  assert.equal(sanitizeHttpHistory(many).length, HTTP_HISTORY_LIMIT);
});

test('keeps error snapshots and dedupes by method+url', () => {
  const next = addHttpHistoryEntry(
    [makeEntry({ id: 'old', status: 500 })],
    makeEntry({ id: 'new', status: 0, response: { status: 0, statusText: '', durationMs: 0, sizeBytes: 0, headers: [], error: { code: 'timeout', message: 'timed out' } } }),
  );
  assert.equal(next.length, 1);
  assert.equal(next[0].id, 'new');
  assert.equal(next[0].response?.error?.code, 'timeout');
});
