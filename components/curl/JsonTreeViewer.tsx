import React, { useMemo, useState } from 'react';
import { Copy, Minus, Plus } from 'lucide-react';

import { jsonNodeSummary, safeParseJson } from '../../domain/http/responseBody';
import { cn } from '../../lib/utils';

export interface JsonTreeLabels {
  expand?: string;
  collapse?: string;
  copyValue?: string;
}

interface JsonTreeViewerProps {
  text: string;
  className?: string;
  labels?: JsonTreeLabels;
  /** Copies the JSON for a node; the caller owns clipboard + feedback. */
  onCopyValue?: (text: string) => void;
}

interface JsonRowProps {
  label: string | null;
  value: unknown;
  depth: number;
  path: string;
  collapsedPaths: Set<string>;
  onToggle: (path: string) => void;
  labels: JsonTreeLabels;
  onCopyValue?: (text: string) => void;
}

const INDENT_PX = 14;
const MAX_LEAF_CHARS = 400;

const isBranch = (value: unknown): value is Record<string, unknown> | unknown[] =>
  value !== null && typeof value === 'object';

const valueClass = (value: unknown): string => {
  if (value === null) return 'text-muted-foreground';
  switch (typeof value) {
    case 'string':
      return 'text-emerald-600 dark:text-emerald-400';
    case 'number':
      return 'text-sky-600 dark:text-sky-400';
    case 'boolean':
      return 'text-amber-600 dark:text-amber-400';
    default:
      return 'text-foreground';
  }
};

const formatLeaf = (value: unknown): string => {
  if (value === null) return 'null';
  if (typeof value === 'string') {
    const text = value.length > MAX_LEAF_CHARS ? `${value.slice(0, MAX_LEAF_CHARS)}…` : value;
    return JSON.stringify(text);
  }
  return String(value);
};

const copyPayload = (value: unknown): string => (typeof value === 'string' ? value : JSON.stringify(value, null, 2));

const JsonRow: React.FC<JsonRowProps> = ({ label, value, depth, path, collapsedPaths, onToggle, labels, onCopyValue }) => {
  const branch = isBranch(value);
  const collapsed = branch && collapsedPaths.has(path);

  const entries: Array<[string, unknown]> = useMemo(() => {
    if (!branch) return [];
    if (Array.isArray(value)) return value.map((item, index) => [String(index), item]);
    return Object.entries(value as Record<string, unknown>);
  }, [branch, value]);

  return (
    <div>
      <div
        className="group flex items-start gap-1 rounded px-1 py-[1px] hover:bg-muted/60"
        style={{ paddingLeft: depth * INDENT_PX + 4 }}
      >
        {branch ? (
          <button
            type="button"
            onClick={() => onToggle(path)}
            className="mt-[1px] flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border border-border/70 text-muted-foreground hover:text-foreground"
            aria-label={collapsed ? labels.expand ?? 'Expand' : labels.collapse ?? 'Collapse'}
          >
            {collapsed ? <Plus size={10} /> : <Minus size={10} />}
          </button>
        ) : (
          <span className="mt-[1px] h-3.5 w-3.5 shrink-0" />
        )}
        {label !== null ? <span className="shrink-0 text-foreground">{label}:</span> : null}
        {branch ? (
          <span className="text-muted-foreground">
            {Array.isArray(value) ? '[' : '{'}
            {collapsed ? (
              <span className="mx-1 rounded bg-muted px-1 text-[10px]">{jsonNodeSummary(value)}</span>
            ) : null}
            {collapsed ? (Array.isArray(value) ? ']' : '}') : ''}
          </span>
        ) : (
          <span className={cn('break-all', valueClass(value))}>{formatLeaf(value)}</span>
        )}
        {onCopyValue ? (
          <button
            type="button"
            onClick={() => onCopyValue(copyPayload(value))}
            className="ml-auto hidden shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground group-hover:block"
            aria-label={labels.copyValue ?? 'Copy value'}
          >
            <Copy size={11} />
          </button>
        ) : null}
      </div>
      {branch && !collapsed
        ? entries.map(([key, child]) => (
            <JsonRow
              key={`${path}/${key}`}
              label={key}
              value={child}
              depth={depth + 1}
              path={`${path}/${key}`}
              collapsedPaths={collapsedPaths}
              onToggle={onToggle}
              labels={labels}
              onCopyValue={onCopyValue}
            />
          ))
        : null}
    </div>
  );
};

export const JsonTreeViewer: React.FC<JsonTreeViewerProps> = ({ text, className, labels = {}, onCopyValue }) => {
  const parsed = useMemo(() => safeParseJson(text), [text]);
  // Collapsed-by-default paths: every object/array at depth >= 2.
  const initialCollapsed = useMemo(() => {
    const paths = new Set<string>();
    const walk = (value: unknown, depth: number, path: string) => {
      if (!isBranch(value)) return;
      if (depth >= 2) paths.add(path);
      if (Array.isArray(value)) {
        value.forEach((item, index) => walk(item, depth + 1, `${path}/${index}`));
      } else {
        Object.entries(value as Record<string, unknown>).forEach(([key, item]) => walk(item, depth + 1, `${path}/${key}`));
      }
    };
    walk(parsed, 0, '$');
    return paths;
  }, [parsed]);

  // The body can change while the tab stays mounted, so the collapse state is
  // keyed by the text that produced it.
  const [collapseState, setCollapseState] = useState<{ seed: string; paths: Set<string> }>({
    seed: text,
    paths: initialCollapsed,
  });
  const collapsedPaths = collapseState.seed === text ? collapseState.paths : initialCollapsed;

  if (parsed === undefined) {
    return (
      <pre className={cn('whitespace-pre-wrap break-all p-3 font-mono text-xs', className)} data-testid="curl-json-raw">
        {text}
      </pre>
    );
  }

  const toggle = (path: string) => {
    setCollapseState((current) => {
      const base = current.seed === text ? current.paths : initialCollapsed;
      const next = new Set(base);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return { seed: text, paths: next };
    });
  };

  return (
    <div className={cn('p-2 font-mono text-xs', className)} data-testid="curl-json-tree">
      <JsonRow
        label={null}
        value={parsed}
        depth={0}
        path="$"
        collapsedPaths={collapsedPaths}
        onToggle={toggle}
        labels={labels}
        onCopyValue={onCopyValue}
      />
    </div>
  );
};
