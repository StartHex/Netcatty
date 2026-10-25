/**
 * Query history for the SQL workbench. Persisted in localStorage (never in the
 * encrypted vault): statements are only kept to make reruns convenient.
 */

import { useCallback, useEffect, useState } from 'react';

import { localStorageAdapter } from '../../infrastructure/persistence/localStorageAdapter';
import { STORAGE_KEY_DB_QUERY_HISTORY } from '../../infrastructure/config/storageKeys';
import {
  addSqlHistoryEntry,
  sanitizeSqlHistory,
  type SqlHistoryEntry,
  type SqlHistoryMap,
} from '../../domain/database/sqlHistory';

export interface SqlHistoryApi {
  entriesFor: (connectionId: string | undefined) => SqlHistoryEntry[];
  record: (connectionId: string, sql: string, ok?: boolean) => void;
  clear: (connectionId: string) => void;
}

export function useSqlHistory(): SqlHistoryApi {
  const [history, setHistory] = useState<SqlHistoryMap>({});

  useEffect(() => {
    setHistory(sanitizeSqlHistory(localStorageAdapter.read<unknown>(STORAGE_KEY_DB_QUERY_HISTORY)));
  }, []);

  const persist = useCallback((next: SqlHistoryMap) => {
    localStorageAdapter.write(STORAGE_KEY_DB_QUERY_HISTORY, next);
    return next;
  }, []);

  const record = useCallback(
    (connectionId: string, sql: string, ok = true) => {
      if (!connectionId || !sql.trim()) return;
      setHistory((prev) =>
        persist({
          ...prev,
          [connectionId]: addSqlHistoryEntry(prev[connectionId] ?? [], {
            sql,
            at: Date.now(),
            ok,
          }),
        }),
      );
    },
    [persist],
  );

  const clear = useCallback(
    (connectionId: string) => {
      setHistory((prev) => {
        const next = { ...prev };
        delete next[connectionId];
        return persist(next);
      });
    },
    [persist],
  );

  const entriesFor = useCallback(
    (connectionId: string | undefined) => (connectionId ? history[connectionId] ?? [] : []),
    [history],
  );

  return { entriesFor, record, clear };
}
