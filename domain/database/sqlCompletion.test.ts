import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildSqlCompletionEntries, sqlCompletionKeywords } from './sqlCompletion';

test('lists tables (sorted, schema-qualified detail) before columns and keywords', () => {
  const entries = buildSqlCompletionEntries({
    tables: [
      { schema: 'public', name: 'users', type: 'table' },
      { schema: 'public', name: 'accounts', type: 'table' },
      { schema: 'reporting', name: 'daily_totals', type: 'view' },
    ],
  });

  const tables = entries.filter((entry) => entry.kind === 'table' || entry.kind === 'view');
  assert.deepEqual(tables.map((entry) => entry.label), ['accounts', 'daily_totals', 'users']);
  assert.equal(tables[1].kind, 'view');
  assert.equal(tables[0].detail, 'public.accounts');

  // Table entries come first, keywords last.
  assert.equal(entries[0].kind, 'table');
  assert.equal(entries[entries.length - 1].kind, 'keyword');
});

test('merges structure columns and result columns without duplicates', () => {
  const entries = buildSqlCompletionEntries({
    tables: [{ schema: 'public', name: 'users', type: 'table' }],
    columns: [
      { name: 'email', type: 'varchar(255)' },
      { name: 'id', type: 'integer' },
    ],
    resultColumns: [
      { name: 'id' },
      { name: 'created_at', type: 'timestamp' },
    ],
  });

  const columns = entries.filter((entry) => entry.kind === 'column').map((entry) => entry.label);
  assert.deepEqual(columns, ['created_at', 'email', 'id']);
  assert.equal(columns.filter((label) => label === 'id').length, 1);

  const email = entries.find((entry) => entry.label === 'email');
  assert.equal(email?.detail, 'varchar(255) · column');
  const createdAt = entries.find((entry) => entry.label === 'created_at');
  assert.equal(createdAt?.detail, 'timestamp · result');
});

test('always offers keywords even without schema metadata', () => {
  const entries = buildSqlCompletionEntries({});
  assert.ok(entries.length > 10);
  assert.ok(entries.every((entry) => entry.kind === 'keyword'));
  assert.deepEqual(
    entries.map((entry) => entry.label),
    sqlCompletionKeywords(),
  );
});
