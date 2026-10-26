import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const memory = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => {
    memory.set(key, value);
  },
  removeItem: (key: string) => {
    memory.delete(key);
  },
  clear: () => memory.clear(),
  key: (index: number) => [...memory.keys()][index] ?? null,
  get length() {
    return memory.size;
  },
} as Storage;

const { I18nProvider } = await import('../../application/i18n/I18nProvider.tsx');
const { CurlClientSurface } = await import('./CurlClientSurface.tsx');

test('curl surface renders the empty state without a saved request', () => {
  const markup = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      { locale: 'en' } as never,
      React.createElement(CurlClientSurface, {
        tabId: null,
        requests: [],
        onUpdateRequests: () => {},
      }),
    ),
  );
  assert.match(markup, /No request open/);
});
