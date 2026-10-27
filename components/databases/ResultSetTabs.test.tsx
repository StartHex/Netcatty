import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';

import { createDomRenderer, dispatchDomEvent, installDomEnvironment } from '../test-support/renderReactDom.tsx';
import type { DatabaseResultSet } from '../../application/state/useDatabaseWorkbench.ts';

(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
  clear: () => {},
  key: () => null,
  length: 0,
} as unknown as Storage;

const { I18nProvider } = await import('../../application/i18n/I18nProvider.tsx');
const { ResultSetTabs } = await import('./ResultSetTabs.tsx');

const resultSet = (index: number, overrides: Partial<DatabaseResultSet> = {}): DatabaseResultSet => ({
  sql: `SELECT ${index};`,
  index,
  startLine: index * 2 - 1,
  result: {
    columns: [{ name: 'id', type: 'INTEGER' }],
    rows: [[index]],
    rowCount: index,
    truncated: false,
  } as DatabaseResultSet['result'],
  durationMs: 3,
  ...overrides,
});

const renderTabs = async (
  resultSets: DatabaseResultSet[],
  activeIndex: number,
  onSelect: (index: number) => void,
) => {
  const env = installDomEnvironment();
  const renderer = await createDomRenderer(env.document);
  await renderer.render(
    React.createElement(
      I18nProvider,
      { locale: 'en' } as never,
      React.createElement(ResultSetTabs, { resultSets, activeIndex, onSelect }),
    ),
  );
  return { env, renderer };
};

test('renders one tab per statement with row counts', async () => {
  const { env, renderer } = await renderTabs([resultSet(1), resultSet(2), resultSet(3)], 0, () => {});
  try {
    const tabs = env.document.querySelectorAll('[data-testid^="db-result-set-tab-"]');
    assert.equal(tabs.length, 3);
    assert.equal(env.document.querySelectorAll('[role="tab"]').length, 3);

    const first = env.document.querySelector('[data-testid="db-result-set-tab-0"]');
    assert.ok(first, 'first tab rendered');
    assert.match(first.textContent ?? '', /Result 1/);
    assert.match(first.textContent ?? '', /1\b/, 'row count of the first result set');
    assert.equal(first.getAttribute('aria-selected'), 'true');
    assert.equal(first.getAttribute('title'), 'Statement 1, starting on line 1\nSELECT 1;');

    const second = env.document.querySelector('[data-testid="db-result-set-tab-1"]');
    assert.ok(second, 'second tab rendered');
    assert.equal(second.getAttribute('aria-selected'), 'false');
    assert.match(second.textContent ?? '', /Result 2/);
  } finally {
    await renderer.unmount();
    env.cleanup();
  }
});

test('a failed statement is flagged instead of showing a row count', async () => {
  const failed = resultSet(2, { result: undefined, error: 'syntax error', durationMs: 1 });
  const { env, renderer } = await renderTabs([resultSet(1), failed], 0, () => {});
  try {
    const failedTab = env.document.querySelector('[data-testid="db-result-set-tab-1"]');
    assert.ok(failedTab, 'failed tab rendered');
    assert.ok(failedTab.querySelector('[data-testid="db-result-set-failed"]'), 'failure marker rendered');
    assert.equal(failedTab.querySelector('[data-testid="db-result-set-rows"]'), null);
  } finally {
    await renderer.unmount();
    env.cleanup();
  }
});

test('selecting a tab reports its index', async () => {
  const selected: number[] = [];
  const { env, renderer } = await renderTabs([resultSet(1), resultSet(2), resultSet(3)], 0, (index) => {
    selected.push(index);
  });
  try {
    const third = env.document.querySelector('[data-testid="db-result-set-tab-2"]');
    assert.ok(third, 'third tab rendered');
    await dispatchDomEvent(third, new env.window.MouseEvent('click', { bubbles: true }));
    assert.deepEqual(selected, [2]);
  } finally {
    await renderer.unmount();
    env.cleanup();
  }
});
