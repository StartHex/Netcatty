import assert from 'node:assert/strict';
import test from 'node:test';

import { CONNECTION_IDLE_PROBE_MS, connectivityProbeSql } from './probe';

test('oracle needs a FROM clause, every other driver accepts select 1', () => {
  assert.equal(connectivityProbeSql('oracle'), 'select 1 from dual');
  assert.equal(connectivityProbeSql('mysql'), 'select 1');
  assert.equal(connectivityProbeSql('jdbc'), 'select 1');
  assert.equal(connectivityProbeSql(undefined), 'select 1');
});

test('the idle window matches the requested one minute', () => {
  assert.equal(CONNECTION_IDLE_PROBE_MS, 60_000);
});
