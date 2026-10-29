import assert from 'node:assert/strict';
import test from 'node:test';

import {
  cellMatchesQuery,
  columnsToTsv,
  compareResultCells,
  findResultMatches,
  sortResultRows,
} from './resultGrid';

const rows = [
  ['b', 2, null],
  ['a', 10, 'x'],
  ['c', 1, 'y'],
  ['a', 2, 'z'],
];

test('compareResultCells puts NULLs last and compares numbers numerically', () => {
  assert.equal(compareResultCells(null, 'a'), 1);
  assert.equal(compareResultCells('a', null), -1);
  assert.equal(compareResultCells(null, undefined), 0);
  assert.ok(compareResultCells(2, 10) < 0);
  assert.ok(compareResultCells('2', '10') < 0);
});

test('sortResultRows is stable and keeps empty cells last in both directions', () => {
  const ascending = sortResultRows(rows, { columnIndex: 0, direction: 'asc' });
  assert.deepEqual(ascending, [1, 3, 0, 2]);
  const descending = sortResultRows(rows, { columnIndex: 0, direction: 'desc' });
  assert.deepEqual(descending, [2, 0, 1, 3]);

  const byNumber = sortResultRows(rows, { columnIndex: 1, direction: 'asc' });
  assert.deepEqual(byNumber, [2, 0, 3, 1]);

  const nullsLast = sortResultRows(rows, { columnIndex: 2, direction: 'desc' });
  assert.deepEqual(nullsLast, [3, 2, 1, 0]);
});

test('sortResultRows without a spec keeps the original order', () => {
  assert.deepEqual(sortResultRows(rows, null), [0, 1, 2, 3]);
});

test('cellMatchesQuery is a substring test, not a fuzzy subsequence', () => {
  assert.equal(cellMatchesQuery('BalanceManagement', 'manage'), true);
  assert.equal(cellMatchesQuery('BalanceManagement', 'bmgt'), false);
  assert.equal(cellMatchesQuery('CF_DYNAMIC_MSISDN', 'sms'), false);
  assert.equal(cellMatchesQuery('BalanceManagement', 'zzz'), false);
  assert.equal(cellMatchesQuery(null, 'a'), false);
  assert.equal(cellMatchesQuery('abc', '   '), false);
});

test('findResultMatches scans all rows and honours the column filter', () => {
  const all = findResultMatches(rows, [], 'a');
  assert.deepEqual(all, [
    { rowIndex: 1, columnIndex: 0 },
    { rowIndex: 3, columnIndex: 0 },
  ]);

  const secondColumn = findResultMatches(rows, [1], '1');
  assert.deepEqual(secondColumn, [
    { rowIndex: 1, columnIndex: 1 },
    { rowIndex: 2, columnIndex: 1 },
  ]);

  assert.deepEqual(findResultMatches(rows, [], ''), []);
});

test('columnsToTsv copies the header plus the selected columns', () => {
  const columns = [{ name: 'name' }, { name: 'amount' }, { name: 'note' }];
  assert.equal(columnsToTsv(columns, rows.slice(0, 2), [0, 1]), 'name\tamount\nb\t2\na\t10');
  assert.equal(columnsToTsv(columns, rows.slice(0, 1), []), 'name\tamount\tnote\nb\t2\t');
  assert.equal(columnsToTsv(columns, rows, [0]).split('\n')[0], 'name');
});
