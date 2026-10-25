import test from 'node:test';
import assert from 'node:assert/strict';
import { JDBC_PRESETS, applyJdbcPresetTemplate, findJdbcPreset } from './jdbcPresets.ts';

test('presets cover the documented vendors with unique ids', () => {
  const ids = JDBC_PRESETS.map((preset) => preset.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ['mysql', 'postgresql', 'oracle', 'sqlserver', 'h2']) {
    assert.ok(findJdbcPreset(id), id);
  }
});

test('templates substitute host, port and database', () => {
  const mysql = findJdbcPreset('mysql')!;
  assert.equal(
    applyJdbcPresetTemplate(mysql, { host: 'db.local', port: 3307, database: 'app' }),
    'jdbc:mysql://db.local:3307/app',
  );
  const h2 = findJdbcPreset('h2')!;
  assert.equal(applyJdbcPresetTemplate(h2, { database: 'demo' }), 'jdbc:h2:mem:demo');
  assert.equal(applyJdbcPresetTemplate(mysql, {}), 'jdbc:mysql://127.0.0.1:3306/mydb');
});
