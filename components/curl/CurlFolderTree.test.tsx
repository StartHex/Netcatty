import assert from 'node:assert/strict';
import test from 'node:test';

import { createEmptyCurlRequest, type CurlRequest } from '../../domain/models/http.ts';
import {
  CURL_DRAG_MIME,
  buildCurlFolderTree,
  curlFolderRevealChain,
  decodeCurlDragPayload,
  encodeCurlDragPayload,
  readCurlDragPayload,
} from './CurlFolderTree.tsx';

const request = (id: string, name: string, folder?: string): CurlRequest =>
  createEmptyCurlRequest(id, { name, folder, url: `https://example.test/${id}` });

const fakeDataTransfer = (data: Record<string, string>): DataTransfer => ({
  getData: (format: string) => data[format] ?? '',
}) as unknown as DataTransfer;

test('buildCurlFolderTree nests folders and splits root requests from folder requests', () => {
  const tree = buildCurlFolderTree(
    ['Team', 'Team/Users', 'Archived'],
    [request('1', 'Zeta', 'Team/Users'), request('2', 'alpha'), request('3', 'Beta', 'Team')],
  );

  assert.deepEqual(tree.folders.map((node) => node.path), ['Archived', 'Team']);
  const team = tree.folders[1];
  assert.deepEqual(team.requests.map((item) => item.name), ['Beta']);
  assert.deepEqual(team.children.map((node) => node.path), ['Team/Users']);
  assert.deepEqual(team.children[0].requests.map((item) => item.name), ['Zeta']);
  assert.deepEqual(tree.rootRequests.map((item) => item.name), ['alpha']);
  assert.deepEqual(tree.folders[0].requests, []);
});

test('buildCurlFolderTree creates nodes for request folders missing from the folder list', () => {
  const tree = buildCurlFolderTree([], [request('1', 'Deep', 'a/b/c')]);

  assert.equal(tree.rootRequests.length, 0);
  assert.deepEqual(tree.folders.map((node) => node.path), ['a']);
  assert.deepEqual(tree.folders[0].children.map((node) => node.path), ['a/b']);
  assert.deepEqual(tree.folders[0].children[0].children.map((node) => node.path), ['a/b/c']);
  assert.deepEqual(tree.folders[0].children[0].children[0].requests.map((item) => item.name), ['Deep']);
});

test('buildCurlFolderTree sorts names case-insensitively and keeps folders before requests', () => {
  const tree = buildCurlFolderTree(
    ['beta', 'Alpha'],
    [request('1', 'zulu'), request('2', 'Bravo'), request('3', 'alpha')],
  );

  assert.deepEqual(tree.folders.map((node) => node.name), ['Alpha', 'beta']);
  assert.deepEqual(tree.rootRequests.map((item) => item.name), ['alpha', 'Bravo', 'zulu']);
});

test('buildCurlFolderTree drops folder paths deeper than the supported limit', () => {
  const tree = buildCurlFolderTree([], [request('1', 'Too deep', 'a/b/c/d/e/f/g')]);

  assert.deepEqual(tree.folders, []);
  assert.deepEqual(tree.rootRequests.map((item) => item.name), ['Too deep']);
});

test('encode/decode drag payloads round-trip and reject junk', () => {
  assert.equal(encodeCurlDragPayload({ kind: 'request', id: 'req-1' }), '{"kind":"request","id":"req-1"}');
  assert.deepEqual(decodeCurlDragPayload('{"kind":"request","id":"req-1"}'), { kind: 'request', id: 'req-1' });
  assert.deepEqual(decodeCurlDragPayload('{"kind":"folder","id":" Team//Users "}'), {
    kind: 'folder',
    id: 'Team/Users',
  });

  assert.equal(decodeCurlDragPayload(null), null);
  assert.equal(decodeCurlDragPayload(''), null);
  assert.equal(decodeCurlDragPayload('not json'), null);
  assert.equal(decodeCurlDragPayload('{"kind":"nope","id":"x"}'), null);
  assert.equal(decodeCurlDragPayload('{"kind":"request","id":"   "}'), null);
  assert.equal(decodeCurlDragPayload('{"kind":"folder","id":"///"}'), null);
});

test('readCurlDragPayload prefers the custom MIME type and falls back to text/plain', () => {
  const custom = fakeDataTransfer({
    [CURL_DRAG_MIME]: '{"kind":"folder","id":"Team"}',
    'text/plain': '{"kind":"request","id":"other"}',
  });
  assert.deepEqual(readCurlDragPayload(custom), { kind: 'folder', id: 'Team' });

  const fallback = fakeDataTransfer({ 'text/plain': '{"kind":"request","id":"req-2"}' });
  assert.deepEqual(readCurlDragPayload(fallback), { kind: 'request', id: 'req-2' });

  assert.equal(readCurlDragPayload(null), null);
});

test('curlFolderRevealChain lists ancestors from the root down to the folder itself', () => {
  assert.deepEqual(curlFolderRevealChain('Team/Users/Admin'), ['Team', 'Team/Users', 'Team/Users/Admin']);
  assert.deepEqual(curlFolderRevealChain('Team'), ['Team']);
  assert.deepEqual(curlFolderRevealChain(''), []);
});
