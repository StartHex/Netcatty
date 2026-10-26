import type { Monaco } from '@monaco-editor/react';

import type { SqlCompletionEntry } from '../../domain/database/sqlCompletion';

type CompletionDisposable = { dispose: () => void };

export type SqlCompletionSource = () => SqlCompletionEntry[];

/**
 * Register a Monaco completion provider for SQL.
 *
 * The provider reads `source()` on every invocation, so schema/result changes
 * do not need a re-registration (and must not: disposing mid-edit breaks the
 * widget). Call the returned `dispose` when the editor unmounts.
 */
export function registerSqlMonacoCompletionProvider(
  monaco: Monaco,
  source: SqlCompletionSource,
): CompletionDisposable {
  const kinds = monaco.languages.CompletionItemKind;
  const kindByEntry: Record<SqlCompletionEntry['kind'], number> = {
    table: kinds.Struct,
    view: kinds.Struct,
    column: kinds.Field,
    keyword: kinds.Keyword,
  };
  // Tables first, then columns, then keywords.
  const rankByEntry: Record<SqlCompletionEntry['kind'], number> = {
    table: 0,
    view: 0,
    column: 1,
    keyword: 2,
  };

  return monaco.languages.registerCompletionItemProvider('sql', {
    triggerCharacters: ['.', ' '],
    provideCompletionItems: (model, position) => {
      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };
      const prefix = model.getValueInRange({
        startLineNumber: position.lineNumber,
        startColumn: 1,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
      });

      // No popup inside a line comment.
      if (prefix.trimStart().startsWith('--')) return { suggestions: [] };

      const counters = new Map<number, number>();
      const suggestions = source().map((entry) => {
        const rank = rankByEntry[entry.kind];
        const next = counters.get(rank) ?? 0;
        counters.set(rank, next + 1);
        return {
          label: entry.label,
          kind: kindByEntry[entry.kind],
          detail: entry.detail,
          insertText: entry.label,
          sortText: `${rank}${String(next).padStart(5, '0')}`,
          range,
        };
      });
      return { suggestions };
    },
  });
}
