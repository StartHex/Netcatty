import test from 'node:test';
import assert from 'node:assert/strict';

import { filterTables, matchesTableQuery } from './tableFilter.ts';

const tables = [
  { name: 'users' },
  { name: 'user_orders' },
  { name: 'BILL_BAK_01' },
  { name: 'orders' },
];

test('empty query keeps every table', () => {
  assert.deepEqual(
    filterTables(tables, '   ').map((table) => table.name),
    ['users', 'user_orders', 'BILL_BAK_01', 'orders'],
  );
});

test('substring matching is case-insensitive', () => {
  assert.deepEqual(
    filterTables(tables, 'bAk').map((table) => table.name),
    ['BILL_BAK_01'],
  );
  assert.equal(matchesTableQuery('USER_ORDERS', 'orders'), true);
});

test('matching is a plain substring test, not a fuzzy subsequence', () => {
  assert.equal(matchesTableQuery('user_orders', 'orders'), true);
  assert.equal(matchesTableQuery('user_orders', 'usro'), false);
  assert.equal(matchesTableQuery('user_orders', 'zzz'), false);
  // Users expect "sms" to mean "contains sms", not "contains s...m...s".
  assert.equal(matchesTableQuery('CF_DYNAMIC_MSISDN', 'sms'), false);
  assert.equal(matchesTableQuery('SMS_BILL', 'sms'), true);
  assert.deepEqual(
    filterTables(tables, 'user').map((table) => table.name),
    ['users', 'user_orders'],
  );
});
