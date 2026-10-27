import assert from 'node:assert/strict';
import test from 'node:test';

import { splitSqlStatements } from './sqlStatements';

const sqlTexts = (input: string): string[] => splitSqlStatements(input).map((entry) => entry.sql);

test('single statement without a trailing separator', () => {
  assert.deepEqual(sqlTexts('SELECT 1'), ['SELECT 1']);
});

test('drops empty segments and trailing separators', () => {
  assert.deepEqual(sqlTexts('  ;;  \n ; '), []);
  assert.deepEqual(sqlTexts('SELECT 1;'), ['SELECT 1']);
  assert.deepEqual(sqlTexts('SELECT 1;; SELECT 2'), ['SELECT 1', 'SELECT 2']);
});

test('splits a multi statement script and keeps the order', () => {
  const script = `SELECT 1;\nUPDATE t SET a = 2;\nDELETE FROM t WHERE a = 3;`;
  assert.deepEqual(sqlTexts(script), [
    'SELECT 1',
    'UPDATE t SET a = 2',
    'DELETE FROM t WHERE a = 3',
  ]);
});

test('does not split on semicolons inside string literals', () => {
  assert.deepEqual(sqlTexts(`INSERT INTO t VALUES ('a;b', 'c''d;e');`), [
    `INSERT INTO t VALUES ('a;b', 'c''d;e')`,
  ]);
});

test('does not split on semicolons inside quoted identifiers', () => {
  assert.deepEqual(sqlTexts('SELECT "we;ird", `al;so` FROM t;'), [
    'SELECT "we;ird", `al;so` FROM t',
  ]);
});

test('ignores separators inside line and block comments', () => {
  const script = `-- header; not a statement\nSELECT 1; /* a;b */ SELECT 2;`;
  assert.deepEqual(sqlTexts(script), ['-- header; not a statement\nSELECT 1', '/* a;b */ SELECT 2']);
});

test('ignores MySQL style hash comments at line start', () => {
  assert.deepEqual(sqlTexts('# comment; here\nSELECT 1;'), ['# comment; here\nSELECT 1']);
});

test('keeps dollar quoted bodies together', () => {
  const script = `CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END; $$ LANGUAGE plpgsql;\nSELECT f();`;
  assert.deepEqual(sqlTexts(script), [
    'CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END; $$ LANGUAGE plpgsql',
    'SELECT f()',
  ]);
});

test('keeps named dollar tags together', () => {
  const script = `DO $body$ BEGIN PERFORM 1; END $body$; SELECT 1;`;
  assert.deepEqual(sqlTexts(script), ['DO $body$ BEGIN PERFORM 1; END $body$', 'SELECT 1']);
});

test('treats a lone dollar sign as plain SQL', () => {
  assert.deepEqual(sqlTexts('SELECT $$ 1'), ['SELECT $$ 1']);
});

test('splits on GO batch separators', () => {
  const script = `SELECT 1\nGO\nSELECT 2\ngo 2\n`;
  assert.deepEqual(sqlTexts(script), ['SELECT 1', 'SELECT 2']);
});

test('a word starting with go is not a separator', () => {
  assert.deepEqual(sqlTexts('SELECT gonzo FROM t;'), ['SELECT gonzo FROM t']);
});

test('reports the 1-based start line of each statement', () => {
  const script = `SELECT 1;\n\n-- note\nSELECT\n  2;`;
  assert.deepEqual(
    splitSqlStatements(script).map((entry) => entry.startLine),
    [1, 4],
  );
});

test('unterminated quote does not throw', () => {
  assert.deepEqual(sqlTexts("SELECT 'abc"), ["SELECT 'abc"]);
});
