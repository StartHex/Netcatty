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

test('subsequence matching keeps fuzzy queries useful', () => {
  assert.equal(matchesTableQuery('user_orders', 'usro'), true);
  assert.equal(matchesTableQuery('user_orders', 'zzz'), false);
  assert.deepEqual(
    filterTables(tables, 'usr').map((table) => table.name),
    ['users', 'user_orders'],
  );
});
