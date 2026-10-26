import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const { JsonTreeViewer } = await import('./JsonTreeViewer.tsx');

test('renders top-level keys and collapses deeper nodes', () => {
  const markup = renderToStaticMarkup(
    React.createElement(JsonTreeViewer, {
      text: JSON.stringify({ id: 7, name: 'demo', nested: { deep: { value: 1 } } }),
    }),
  );
  assert.match(markup, /curl-json-tree/);
  assert.match(markup, /id/);
  assert.match(markup, /demo/);
  // Objects at depth 2 are collapsed by default and show their key count
  // instead of their children.
  assert.match(markup, /1 key/);
  assert.doesNotMatch(markup, /value/);
});

test('falls back to raw text when the body is not valid JSON', () => {
  const markup = renderToStaticMarkup(React.createElement(JsonTreeViewer, { text: '<html>nope</html>' }));
  assert.match(markup, /curl-json-raw/);
  assert.match(markup, /&lt;html&gt;nope&lt;\/html&gt;/);
});

test('renders collapsed arrays with an item summary', () => {
  const markup = renderToStaticMarkup(
    React.createElement(JsonTreeViewer, { text: JSON.stringify({ outer: { items: [1, 2, 3] } }) }),
  );
  assert.match(markup, /3 items/);
});
