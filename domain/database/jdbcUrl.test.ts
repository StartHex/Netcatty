import test from 'node:test';
import assert from 'node:assert/strict';

import { parseJdbcEndpoint, rewriteJdbcUrlEndpoint } from './jdbcUrl.ts';

test('parseJdbcEndpoint reads vendor URLs and Oracle thin URLs', () => {
  assert.deepEqual(parseJdbcEndpoint('jdbc:mysql://10.0.0.5:3306/basdb?useSSL=false'), {
    host: '10.0.0.5',
    port: 3306,
  });
  assert.deepEqual(parseJdbcEndpoint('jdbc:dm://10.86.17.201:5236'), {
    host: '10.86.17.201',
    port: 5236,
  });
  assert.deepEqual(parseJdbcEndpoint('jdbc:oracle:thin:@10.1.1.1:1521:ORCL'), {
    host: '10.1.1.1',
    port: 1521,
  });
  assert.equal(parseJdbcEndpoint('jdbc:sqlite:/tmp/a.db'), null);
  assert.equal(parseJdbcEndpoint('not-a-url'), null);
});

test('rewriteJdbcUrlEndpoint keeps the rest of the URL intact', () => {
  assert.equal(
    rewriteJdbcUrlEndpoint('jdbc:mysql://10.0.0.5:3306/basdb?useSSL=false', '127.0.0.1', 54011),
    'jdbc:mysql://127.0.0.1:54011/basdb?useSSL=false',
  );
  assert.equal(
    rewriteJdbcUrlEndpoint('jdbc:sqlserver://db.local:1433;databaseName=x', '127.0.0.1', 54012),
    'jdbc:sqlserver://127.0.0.1:54012;databaseName=x',
  );
  assert.equal(
    rewriteJdbcUrlEndpoint('jdbc:oracle:thin:@10.1.1.1:1521:ORCL', '127.0.0.1', 54013),
    'jdbc:oracle:thin:@127.0.0.1:54013:ORCL',
  );
  assert.equal(
    rewriteJdbcUrlEndpoint('jdbc:oracle:thin:@//10.1.1.1:1521/SVC', '127.0.0.1', 54014),
    'jdbc:oracle:thin:@//127.0.0.1:54014/SVC',
  );
});

test('rewriteJdbcUrlEndpoint leaves URLs without an endpoint alone', () => {
  assert.equal(rewriteJdbcUrlEndpoint('jdbc:sqlite:/tmp/a.db', '127.0.0.1', 1), 'jdbc:sqlite:/tmp/a.db');
  assert.equal(rewriteJdbcUrlEndpoint('', '127.0.0.1', 1), '');
});
