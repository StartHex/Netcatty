import React, { useCallback, useEffect, useMemo, useRef } from 'react';

import { cn } from '../../lib/utils';

/**
 * Shared text metrics. The gutter and the code body must use exactly the same
 * font size, line height and block padding, otherwise a number drifts away
 * from the line it labels.
 */
const CODE_TEXT_CLASS = 'font-mono text-xs leading-5';
const CODE_BLOCK_PADDING_CLASS = 'py-3';
const GUTTER_TEST_ID = 'json-code-gutter';

/**
 * Number of rendered lines. A trailing newline opens a final empty line (the
 * same way an editor or a `<pre>` counts it), while empty text has no lines at
 * all so a read-only preview never shows a stray "1".
 */
export const countCodeLines = (text: string): number => (text === '' ? 0 : text.split('\n').length);

/** Gutter payload: "1\n2\n3", one number per rendered line. */
export const buildLineNumbers = (count: number): string => {
  if (count <= 0) return '';
  return Array.from({ length: count }, (_, index) => index + 1).join('\n');
};

/**
 * Selected text clipped to the body element.
 *
 * The gutter is `user-select: none`, which keeps it out of a normal drag
 * selection, but Firefox still folds such nodes into a Ctrl/Cmd+A selection.
 * Clipping the live range to the body makes native copy immune to that: text
 * before the body (the gutter) is dropped, and only the overlap with the body
 * reaches the clipboard. Returns `null` when the component should leave the
 * copy event alone (no body text, collapsed selection, or no overlap).
 */
export const readBodySelectionText = (body: HTMLElement | null): string | null => {
  if (!body || !body.firstChild || typeof window === 'undefined') return null;
  const selection = window.getSelection?.();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  const common = range.commonAncestorContainer;
  const touchesBody =
    body.contains(range.startContainer)
    || body.contains(range.endContainer)
    || body.contains(common)
    || common.contains(body);
  if (!touchesBody) return null;

  const clipped = document.createRange();
  if (body.contains(range.startContainer)) {
    clipped.setStart(range.startContainer, range.startOffset);
  } else {
    clipped.setStart(body, 0);
  }
  if (body.contains(range.endContainer)) {
    clipped.setEnd(range.endContainer, range.endOffset);
  } else {
    clipped.setEnd(body, body.childNodes.length);
  }
  return clipped.toString();
};

interface LineNumberGutterProps {
  lineCount: number;
  className?: string;
}

/**
 * Line-number rail. It is hidden from assistive tech, ignores the pointer and
 * refuses text selection so neither a drag nor Ctrl/Cmd+A can pick the digits
 * up; `readBodySelectionText` is the second line of defence for copy events.
 */
const LineNumberGutter = React.forwardRef<HTMLDivElement, LineNumberGutterProps>(
  ({ lineCount, className }, ref) => (
    <div
      ref={ref}
      aria-hidden="true"
      data-testid={GUTTER_TEST_ID}
      className={cn(
        'shrink-0 select-none overflow-hidden border-r border-border/40 bg-background px-2 text-right text-muted-foreground',
        CODE_BLOCK_PADDING_CLASS,
        'min-w-[2.5rem]',
        CODE_TEXT_CLASS,
        className,
      )}
      style={{ userSelect: 'none', WebkitUserSelect: 'none', pointerEvents: 'none' }}
    >
      <pre className={cn('m-0 whitespace-pre text-right', CODE_TEXT_CLASS)}>{buildLineNumbers(lineCount)}</pre>
    </div>
  ),
);
LineNumberGutter.displayName = 'LineNumberGutter';

/** `data-*` pass-through (data-testid and friends) without an `any` escape. */
type DataAttributes = { [key: `data-${string}`]: string | number | boolean | undefined };

export interface LineNumberedPreProps
  extends Omit<React.HTMLAttributes<HTMLPreElement>, 'children'>,
    DataAttributes {
  /** Read-only body text. Rendered verbatim, one gutter number per line. */
  text: string;
  /** Wrap long lines instead of scrolling horizontally (off by default so
   *  every gutter number stays level with its line). */
  wrap?: boolean;
  /** Extra classes for the scroll container (e.g. `h-full`). */
  containerClassName?: string;
  /** Extra classes for the sticky gutter (e.g. a z-index override). */
  gutterClassName?: string;
}

/**
 * Read-only, line-numbered code block. One scroll container owns the scrolling
 * and pins the gutter to the left edge while the body scrolls horizontally.
 */
export const LineNumberedPre: React.FC<LineNumberedPreProps> = ({
  text,
  wrap = false,
  className,
  containerClassName,
  gutterClassName,
  style,
  ...rest
}) => {
  const bodyRef = useRef<HTMLPreElement>(null);
  const lineCount = useMemo(() => countCodeLines(text), [text]);

  const handleCopy = useCallback((event: React.ClipboardEvent<HTMLDivElement>) => {
    const bodyText = readBodySelectionText(bodyRef.current);
    if (bodyText === null || !event.clipboardData) return;
    event.preventDefault();
    event.clipboardData.setData('text/plain', bodyText);
  }, []);

  return (
    <div
      className={cn('relative flex overflow-auto bg-background', containerClassName)}
      onCopy={handleCopy}
    >
      {lineCount > 0 ? (
        <LineNumberGutter
          lineCount={lineCount}
          className={cn('sticky left-0 z-10', gutterClassName)}
        />
      ) : null}
      <pre
        ref={bodyRef}
        className={cn('m-0 flex-1 p-3', CODE_TEXT_CLASS, className)}
        style={{
          whiteSpace: wrap ? 'pre-wrap' : 'pre',
          wordBreak: wrap ? 'break-word' : undefined,
          ...style,
        }}
        {...rest}
      >
        {text}
      </pre>
    </div>
  );
};

export interface LineNumberedTextareaProps
  extends Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'children'>,
    DataAttributes {
  value: string;
  /** Extra classes for the bordered shell (e.g. `min-h-[200px] flex-1`). */
  containerClassName?: string;
  /** Extra classes for the gutter. */
  gutterClassName?: string;
}

/**
 * Editable, line-numbered body editor. The textarea owns the scrolling; the
 * gutter's `scrollTop` is mirrored from it on every scroll and after value
 * changes (format / minify replace the value) so the numbers always stay level
 * with their lines.
 */
export const LineNumberedTextarea: React.FC<LineNumberedTextareaProps> = ({
  value,
  wrap = 'off',
  className,
  containerClassName,
  gutterClassName,
  onChange,
  onScroll,
  style,
  ...rest
}) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);

  const syncGutterScroll = useCallback(() => {
    const textarea = textareaRef.current;
    const gutter = gutterRef.current;
    if (!textarea || !gutter) return;
    gutter.scrollTop = textarea.scrollTop;
  }, []);

  // Format/minify/patch replace the value, which can reset the textarea
  // scroll position; re-align the gutter with whatever the browser did.
  useEffect(() => {
    syncGutterScroll();
  }, [value, syncGutterScroll]);

  const handleScroll = (event: React.UIEvent<HTMLTextAreaElement>) => {
    syncGutterScroll();
    onScroll?.(event);
  };

  // The gutter ignores pointer events, so wheel gestures over it land on this
  // shell; hand them to the textarea instead of swallowing them.
  const handleWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    const textarea = textareaRef.current;
    if (!textarea || event.target === textarea) return;
    textarea.scrollTop += event.deltaY;
  };

  const lineCount = Math.max(1, countCodeLines(value));

  return (
    <div
      className={cn(
        'relative flex min-h-0 overflow-hidden rounded-md border border-input bg-background',
        containerClassName,
      )}
      onWheel={handleWheel}
    >
      <LineNumberGutter ref={gutterRef} lineCount={lineCount} className={gutterClassName} />
      <textarea
        ref={textareaRef}
        value={value}
        wrap={wrap}
        onChange={onChange}
        onScroll={handleScroll}
        spellCheck={false}
        className={cn(
          'min-h-0 min-w-0 flex-1 resize-none border-0 bg-transparent p-3 text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50',
          CODE_TEXT_CLASS,
          className,
        )}
        style={{ whiteSpace: 'pre', ...style }}
        {...rest}
      />
    </div>
  );
};
