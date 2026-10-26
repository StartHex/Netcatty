import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildDatabaseConfigFile,
  mergeImported,
  parseDatabaseConfig,
  serializeDatabaseConfig,
} from './connectionTransfer';
import type { DatabaseConnection, JdbcDriver } from '../models/database';

const connections = [
  {
    id: 'c1',
    label: 'prod',
    kind: 'postgresql',
    host: 'db.internal',
    port: 5432,
    database: 'app',
    username: 'reader',
    password: 'secret',
    savePassword: true,
    group: 'Prod',
    createdAt: 1,
    updatedAt: 2,
  },
] as DatabaseConnection[];

const drivers = [
  { id: 'd1', name: 'DM', driverClass: 'com.sitech.dmdb.Driver', jarPaths: ['/tmp/dm.jar'] },
] as JdbcDriver[];

test('exports never contain passwords', () => {
  const file = buildDatabaseConfigFile(connections, drivers, 0);
  assert.equal(file.version, 1);
  assert.equal(file.connections[0].password, '');
  assert.equal(file.connections[0].savePassword, false);
  assert.equal(file.connections[0].host, 'db.internal');
  const text = serializeDatabaseConfig(connections, drivers, 0);
  assert.ok(!text.includes('secret'));
});

test('round-trips through parse', () => {
  const text = serializeDatabaseConfig(connections, drivers);
  const parsed = parseDatabaseConfig(text);
  assert.equal(parsed.ok, true);
  if (parsed.ok !== true) return;
  assert.equal(parsed.value.connections.length, 1);
  assert.equal(parsed.value.drivers.length, 1);
  assert.equal(parsed.value.connections[0].password, '');
});

test('rejects junk and empty payloads', () => {
  assert.deepEqual(parseDatabaseConfig('nope'), { ok: false, error: 'invalid-json' });
  assert.deepEqual(parseDatabaseConfig('[]'), { ok: false, error: 'invalid-shape' });
  assert.deepEqual(parseDatabaseConfig('{"connections":[],"drivers":[]}'), { ok: false, error: 'empty' });
  assert.deepEqual(parseDatabaseConfig('{"connections":[{"label":"x"}],"drivers":[]}'), {
    ok: false,
    error: 'empty',
  });
});

test('merge keeps saved passwords for existing ids', () => {
  const imported = [{ ...connections[0], label: 'prod-renamed', password: '' }];
  const merged = mergeImported(connections, imported);
  assert.equal(merged.updated, 1);
  assert.equal(merged.added, 0);
  assert.equal(merged.items[0].label, 'prod-renamed');
  assert.equal(merged.items[0].password, 'secret');

  const fresh = mergeImported(connections, [{ ...connections[0], id: 'c2' }]);
  assert.equal(fresh.added, 1);
  assert.equal(fresh.items.length, 2);
});
