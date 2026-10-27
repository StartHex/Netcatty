import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { createDomRenderer, dispatchDomEvent, installDomEnvironment } from '../test-support/renderReactDom.tsx';
import {
  buildLineNumbers,
  countCodeLines,
  LineNumberedPre,
  LineNumberedTextarea,
  readBodySelectionText,
  type LineNumberedPreProps,
} from './JsonCodeView.tsx';

const decodeHtml = (value: string): string =>
  value
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

const elementInner = (markup: string, pattern: RegExp): string => {
  const match = pattern.exec(markup);
  assert.ok(match, `expected markup to contain ${pattern}`);
  return match[1];
};

const renderPre = (props: LineNumberedPreProps): string =>
  renderToStaticMarkup(React.createElement(LineNumberedPre, props));

const GUTTER_OPEN = /<div[^>]*data-testid="json-code-gutter"[^>]*>/;
const gutterInner = (markup: string): string => elementInner(markup, new RegExp(GUTTER_OPEN.source + '([\\s\\S]*?)<\\/div>'));
const gutterText = (markup: string): string => decodeHtml(gutterInner(markup).replace(/<[^>]*>/g, ''));
const gutterTag = (markup: string): string => assertMatch(markup, GUTTER_OPEN);

const assertMatch = (markup: string, pattern: RegExp): string => {
  const match = pattern.exec(markup);
  assert.ok(match, `expected markup to match ${pattern}`);
  return match[0];
};

test('line-numbered pre renders one gutter number per line', () => {
  const text = '{\n  "name": "netcatty",\n  "ok": true\n}';
  const markup = renderPre({ text, 'data-testid': 'code-body' });

  assert.equal(countCodeLines(text), 4);
  assert.equal(gutterText(markup), '1\n2\n3\n4');
  assert.equal(
    decodeHtml(elementInner(markup, /<pre[^>]*data-testid="code-body"[^>]*>([\s\S]*?)<\/pre>/)),
    text,
  );
});

test('gutter is hidden from the pointer, text selection and assistive tech', () => {
  const markup = renderPre({ text: 'a\nb' });
  const tag = gutterTag(markup);

  assert.match(tag, /aria-hidden="true"/);
  assert.match(tag, /select-none/);
  assert.match(tag, /user-select:\s*none/);
  assert.match(tag, /-webkit-user-select:\s*none/);
  assert.match(tag, /pointer-events:\s*none/);
  // The digits live in their own element, never inside the body `<pre>`.
  assert.doesNotMatch(gutterInner(markup), /<pre[^>]*data-testid="code-body"/);
});

test('empty text renders no gutter and no stray line number', () => {
  const markup = renderPre({ text: '', 'data-testid': 'empty-body' });

  assert.equal(countCodeLines(''), 0);
  assert.equal(buildLineNumbers(0), '');
  assert.doesNotMatch(markup, /json-code-gutter/);
  assert.equal(
    decodeHtml(elementInner(markup, /<pre[^>]*data-testid="empty-body"[^>]*>([\s\S]*?)<\/pre>/)),
    '',
  );
});

test('a trailing newline opens a final empty line and gets its own number', () => {
  assert.equal(countCodeLines('a\n'), 2);
  assert.equal(countCodeLines('\n'), 2);
  assert.equal(buildLineNumbers(3), '1\n2\n3');

  const markup = renderPre({ text: 'a\nb\n', 'data-testid': 'trailing-body' });
  assert.equal(gutterText(markup), '1\n2\n3');
  assert.equal(
    decodeHtml(elementInner(markup, /<pre[^>]*data-testid="trailing-body"[^>]*>([\s\S]*?)<\/pre>/)),
    'a\nb\n',
  );
});

test('line-numbered textarea labels every line and keeps the editor contract', () => {
  const markup = renderToStaticMarkup(
    React.createElement(LineNumberedTextarea, {
      value: 'a\nb',
      placeholder: 'Request body',
      'data-testid': 'request-body',
      containerClassName: 'min-h-[200px] flex-1',
    }),
  );

  assert.equal(gutterText(markup), '1\n2');
  assert.equal(
    decodeHtml(elementInner(markup, /<textarea[^>]*data-testid="request-body"[^>]*>([\s\S]*?)<\/textarea>/)),
    'a\nb',
  );
  const textareaTag = assertMatch(markup, /<textarea[^>]*data-testid="request-body"[^>]*>/);
  assert.match(textareaTag, /placeholder="Request body"/);
  // Soft wrapping would desynchronise the numbers from their lines.
  assert.match(textareaTag, /wrap="off"/);
  assert.match(gutterTag(markup), /pointer-events:\s*none/);
});

test('line-numbered textarea still shows line 1 for an empty value', () => {
  const markup = renderToStaticMarkup(React.createElement(LineNumberedTextarea, { value: '' }));

  assert.equal(countCodeLines(''), 0);
  assert.equal(gutterText(markup), '1');
});

test('copy from a gutter-crossing selection only writes the body text', async () => {
  const env = installDomEnvironment();
  const renderer = await createDomRenderer(env.document);
  try {
    const text = '{\n  "a": 1\n}';
    await renderer.render(React.createElement(LineNumberedPre, { text, 'data-testid': 'code-body' }));

    const body = env.document.querySelector('[data-testid="code-body"]');
    const gutter = env.document.querySelector('[data-testid="json-code-gutter"]');
    assert.ok(body instanceof env.window.HTMLElement, 'body pre rendered');
    assert.ok(gutter instanceof env.window.HTMLElement, 'gutter rendered');
    const numbers = gutter.querySelector('pre')?.firstChild;
    const bodyText = body.firstChild;
    assert.ok(numbers instanceof env.window.Text, 'gutter digits rendered');
    assert.ok(bodyText instanceof env.window.Text, 'body text rendered');

    const selection = env.window.getSelection();
    assert.ok(selection, 'selection available');

    // Simulate Ctrl/Cmd+A: the native selection still spans the gutter digits
    // (jsdom does not honour user-select) and must be clipped before copying.
    const range = env.document.createRange();
    range.setStart(numbers, 2);
    range.setEnd(bodyText, 5);
    selection.removeAllRanges();
    selection.addRange(range);

    assert.match(selection.toString(), /2\n3/, 'native selection leaks the numbers');
    assert.equal(readBodySelectionText(body), text.slice(0, 5));

    const written = new Map<string, string>();
    const copyEvent = new env.window.Event('copy', { bubbles: true, cancelable: true, composed: true });
    Object.defineProperty(copyEvent, 'clipboardData', {
      value: {
        setData: (type: string, value: string) => {
          written.set(type, value);
        },
      },
    });
    await dispatchDomEvent(body, copyEvent);

    assert.equal(copyEvent.defaultPrevented, true, 'copy handler takes over the event');
    assert.deepEqual([...written.entries()], [['text/plain', text.slice(0, 5)]]);

    // A selection that stays inside the body is copied untouched.
    const insideRange = env.document.createRange();
    insideRange.setStart(bodyText, 1);
    insideRange.setEnd(bodyText, 4);
    selection.removeAllRanges();
    selection.addRange(insideRange);

    const insideCopy = new env.window.Event('copy', { bubbles: true, cancelable: true, composed: true });
    const insideWritten = new Map<string, string>();
    Object.defineProperty(insideCopy, 'clipboardData', {
      value: {
        setData: (type: string, value: string) => {
          insideWritten.set(type, value);
        },
      },
    });
    await dispatchDomEvent(body, insideCopy);

    assert.equal(insideWritten.get('text/plain'), text.slice(1, 4));
  } finally {
    await renderer.unmount();
    env.cleanup();
  }
});

test('collapsed selections and selections outside the body are left alone', async () => {
  const env = installDomEnvironment();
  const renderer = await createDomRenderer(env.document);
  try {
    await renderer.render(React.createElement(LineNumberedPre, { text: 'a\nb', 'data-testid': 'body' }));
    const body = env.document.querySelector('[data-testid="body"]');
    assert.ok(body instanceof env.window.HTMLElement);
    const selection = env.window.getSelection();
    assert.ok(selection);
    const textNode = body.firstChild;
    assert.ok(textNode instanceof env.window.Text);

    selection.collapse(textNode, 1);
    assert.equal(readBodySelectionText(body), null);

    const outside = env.document.createRange();
    outside.setStart(env.document.body, 0);
    outside.setEnd(env.document.body, 0);
    selection.removeAllRanges();
    selection.addRange(outside);
    assert.equal(readBodySelectionText(body), null);
  } finally {
    await renderer.unmount();
    env.cleanup();
  }
});
