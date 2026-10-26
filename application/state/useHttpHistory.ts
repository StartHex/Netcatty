import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  addHttpHistoryEntry,
  sanitizeHttpHistory,
  type HttpHistoryEntry,
} from '../../domain/http/history';
import { STORAGE_KEY_HTTP_HISTORY } from '../../infrastructure/config/storageKeys';
import { localStorageAdapter } from '../../infrastructure/persistence/localStorageAdapter';

export interface UseHttpHistoryResult {
  entries: readonly HttpHistoryEntry[];
  record: (entry: Omit<HttpHistoryEntry, 'id' | 'at'>) => void;
  clear: () => void;
}

export function useHttpHistory(): UseHttpHistoryResult {
  const [entries, setEntries] = useState<HttpHistoryEntry[]>([]);

  useEffect(() => {
    const stored = localStorageAdapter.read<unknown>(STORAGE_KEY_HTTP_HISTORY);
    setEntries(sanitizeHttpHistory(stored));
  }, []);

  const persist = useCallback((next: HttpHistoryEntry[]) => {
    setEntries(next);
    localStorageAdapter.write(STORAGE_KEY_HTTP_HISTORY, next);
  }, []);

  const record = useCallback(
    (entry: Omit<HttpHistoryEntry, 'id' | 'at'>) => {
      setEntries((current) => {
        const next = addHttpHistoryEntry(current, {
          ...entry,
          id: `hist-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          at: Date.now(),
        });
        localStorageAdapter.write(STORAGE_KEY_HTTP_HISTORY, next);
        return next;
      });
    },
    [],
  );

  const clear = useCallback(() => persist([]), [persist]);

  return useMemo(() => ({ entries, record, clear }), [entries, record, clear]);
}
