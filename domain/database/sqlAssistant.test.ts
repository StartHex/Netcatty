import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSqlAssistantMessages,
  dialectLabel,
  extractSqlFromAnswer,
  looksLikeSqlAnswer,
} from './sqlAssistant';

test('dialectLabel maps kinds and falls back', () => {
  assert.equal(dialectLabel('postgresql'), 'PostgreSQL');
  assert.equal(dialectLabel('sqlserver'), 'SQL Server');
  assert.equal(dialectLabel('duckdb'), 'duckdb');
  assert.equal(dialectLabel(undefined), 'SQL');
});

test('generate prompt includes schema, sql and question', () => {
  const { system, prompt } = buildSqlAssistantMessages({
    mode: 'generate',
    question: 'top 5 orders',
    sql: 'select * from orders',
    schema: 'orders(id, total)',
    dialect: 'mysql',
  });
  assert.match(system, /MySQL/);
  assert.match(prompt, /Available tables and columns:\norders\(id, total\)/);
  assert.match(prompt, /Current SQL:\nselect \* from orders/);
  assert.match(prompt, /top 5 orders/);
});

test('empty question falls back to a mode-specific instruction', () => {
  const explain = buildSqlAssistantMessages({ mode: 'explain', question: '  ', sql: 'select 1' });
  assert.match(explain.prompt, /Explain this SQL\./);
  const optimize = buildSqlAssistantMessages({ mode: 'optimize', question: '', sql: 'select 1' });
  assert.match(optimize.prompt, /Rewrite this SQL/);
});

test('extractSqlFromAnswer unwraps fences and trailing notes', () => {
  assert.equal(extractSqlFromAnswer('```sql\nselect 1 from dual\n```'), 'select 1 from dual');
  assert.equal(
    extractSqlFromAnswer('```\nselect 2\n```\nThis returns a constant.'),
    'select 2',
  );
  assert.equal(extractSqlFromAnswer('select 3'), 'select 3');
});

test('looksLikeSqlAnswer detects statements', () => {
  assert.equal(looksLikeSqlAnswer('```sql\nselect 1\n```'), true);
  assert.equal(looksLikeSqlAnswer('This query selects everything.'), false);
});
