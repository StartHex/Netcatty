import test from 'node:test';
import assert from 'node:assert/strict';
import { classifySqlSafety, splitSqlScript } from './sqlSafety.ts';

test('select/with/show are read statements', () => {
  for (const sql of ['select 1', 'with x as (select 1) select * from x', 'show tables', 'explain select 1']) {
    assert.equal(classifySqlSafety(sql).risk, 'read', sql);
  }
});

test('plain writes are write risk', () => {
  assert.equal(classifySqlSafety('insert into t values (1)').risk, 'write');
  assert.equal(classifySqlSafety('update t set a = 1 where id = 2').risk, 'write');
  assert.equal(classifySqlSafety('delete from t where id = 2').risk, 'write');
});

test('drop/truncate and unbounded mutations are destructive', () => {
  assert.equal(classifySqlSafety('drop table t').risk, 'destructive');
  assert.equal(classifySqlSafety('truncate t').risk, 'destructive');
  const report = classifySqlSafety('delete from t');
  assert.equal(report.risk, 'destructive');
  assert.deepEqual(report.reasons, ['delete-without-where']);
  assert.equal(classifySqlSafety('update t set a = 1').risk, 'destructive');
});

test('script risk is the max across statements', () => {
  const report = classifySqlSafety('select 1; delete from t where id = 1; drop table t;');
  assert.equal(report.risk, 'destructive');
  assert.equal(report.statements.length, 3);
});

test('splitSqlScript respects quotes and comments', () => {
  assert.deepEqual(splitSqlScript("select ';' as a; select 2"), ["select ';' as a", 'select 2']);
  assert.deepEqual(splitSqlScript('select 1 -- ; not a split\n; select 2'), ['select 1 -- ; not a split', 'select 2']);
  assert.deepEqual(splitSqlScript('select /* ; */ 1'), ['select /* ; */ 1']);
  assert.deepEqual(splitSqlScript('  '), []);
});

test('unknown statements are treated as writes, never safe', () => {
  assert.equal(classifySqlSafety('merge into t using s on (1=1)').risk, 'write');
  assert.equal(classifySqlSafety('frobnicate everything').risk, 'write');
});
