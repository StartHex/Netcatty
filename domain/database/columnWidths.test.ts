import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyWidths,
  clampColumnWidth,
  sanitizeColumnWidths,
  scopeWidths,
  widthScopeKey,
} from './columnWidths';

test('clampColumnWidth bounds values', () => {
  assert.equal(clampColumnWidth(10), 60);
  assert.equal(clampColumnWidth(160.4), 160);
  assert.equal(clampColumnWidth(5000), 1200);
  assert.equal(clampColumnWidth(Number.NaN), 60);
});

test('scope keys prefer the table name', () => {
  assert.equal(widthScopeKey('c1', 'Users', ['a']), 'c1::users');
  assert.equal(widthScopeKey('c1', undefined, ['ID', 'Name']), 'c1::id|name');
  assert.equal(widthScopeKey('c1', '  ', ['ID']), 'c1::id');
});

test('sanitize drops junk and clamps numbers', () => {
  const cleaned = sanitizeColumnWidths({ 'c1::t::id': 10, 'c1::t::name': 'wide', bad: Number.NaN });
  assert.deepEqual(cleaned, { 'c1::t::id': 60 });
});

test('scopeWidths extracts one scope', () => {
  const map = { 'c1::t::id': 120, 'c1::t::name': 300, 'c2::t::id': 90 };
  assert.deepEqual(scopeWidths(map, 'c1::t'), { id: 120, name: 300 });
});

test('applyWidths overrides matching columns case-insensitively', () => {
  const columns = [{ name: 'ID' }, { name: 'Name' }];
  assert.deepEqual(applyWidths([100, 200], columns, { id: 150 }), [150, 200]);
  assert.deepEqual(applyWidths([100, 200], columns, {}), [100, 200]);
});
