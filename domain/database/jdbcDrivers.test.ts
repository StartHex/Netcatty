import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findJdbcDriverName,
  jdbcDriverJarPaths,
  sanitizeJdbcDriver,
  sanitizeJdbcDrivers,
} from './jdbcDrivers.ts';

test('sanitize keeps the first jar and the full jar list', () => {
  const driver = sanitizeJdbcDriver({
    id: ' d1 ',
    name: ' MySQL ',
    jarPath: '/jars/mysql.jar',
    jarPaths: ['/jars/mysql.jar', '/jars/protobuf.jar'],
    driverClass: ' com.mysql.cj.jdbc.Driver ',
    presetId: 'mysql',
  });
  assert.ok(driver);
  assert.equal(driver!.id, 'd1');
  assert.equal(driver!.name, 'MySQL');
  assert.equal(driver!.jarPath, '/jars/mysql.jar');
  assert.deepEqual(driver!.jarPaths, ['/jars/mysql.jar', '/jars/protobuf.jar']);
  assert.equal(driver!.driverClass, 'com.mysql.cj.jdbc.Driver');
});

test('sanitize falls back to the legacy single jarPath', () => {
  const driver = sanitizeJdbcDriver({ id: 'd2', name: 'Legacy', jarPath: '/jars/old.jar' });
  assert.ok(driver);
  assert.deepEqual(jdbcDriverJarPaths(driver!), ['/jars/old.jar']);
});

test('sanitize drops entries without id, name or jars and de-duplicates ids', () => {
  const list = sanitizeJdbcDrivers([
    { id: 'a', name: 'A', jarPath: '/a.jar' },
    { id: 'a', name: 'A again', jarPath: '/a2.jar' },
    { id: '', name: 'B', jarPath: '/b.jar' },
    { id: 'c', name: 'C', jarPaths: ['  '] },
    null,
    'nope',
  ]);
  assert.deepEqual(list.map((driver) => driver.id), ['a']);
  assert.equal(list[0].name, 'A');
  assert.deepEqual(sanitizeJdbcDrivers('bad'), []);
});

test('findJdbcDriverName resolves ids', () => {
  const drivers = [{ id: 'd1', name: 'MySQL', jarPath: '/m.jar' }];
  assert.equal(findJdbcDriverName(drivers, 'd1'), 'MySQL');
  assert.equal(findJdbcDriverName(drivers, 'missing'), undefined);
  assert.equal(findJdbcDriverName(drivers, undefined), undefined);
});
