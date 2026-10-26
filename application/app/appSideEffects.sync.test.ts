import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const sourcePath = path.join(process.cwd(), 'application/app/AppSideEffects.tsx');

test('cloud sync config forwards database connections and curl requests', async () => {
  const source = await readFile(sourcePath, 'utf8');
  const callIndex = source.indexOf('useAutoSync({');
  assert.ok(callIndex > 0, 'AppSideEffects must configure useAutoSync');
  const callBody = source.slice(callIndex, source.indexOf('});', callIndex));
  for (const field of ['dbConnections', 'curlRequests']) {
    assert.match(
      callBody,
      new RegExp(`\\b${field}\\b`),
      `${field} must be handed to useAutoSync, otherwise the entity never leaves this device`,
    );
  }
  assert.match(source, /dbConnections,/, 'vault runtime must expose dbConnections to the sync config');
});
