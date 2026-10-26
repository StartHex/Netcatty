/**
 * Persisted manual column widths for the result grid. Convenience data only, so
 * it lives in localStorage rather than the encrypted vault.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { localStorageAdapter } from '../../infrastructure/persistence/localStorageAdapter';
import { STORAGE_KEY_DB_COLUMN_WIDTHS } from '../../infrastructure/config/storageKeys';
import {
  clampColumnWidth,
  sanitizeColumnWidths,
  scopeWidths,
  type ColumnWidthMap,
} from '../../domain/database/columnWidths';

export interface DatabaseColumnWidthStore {
  widthsFor: (scope: string) => Record<string, number>;
  setWidth: (scope: string, column: string, width: number) => void;
}

export function useDatabaseColumnWidthStore(): DatabaseColumnWidthStore {
  const [map, setMap] = useState<ColumnWidthMap>({});
  const mapRef = useRef<ColumnWidthMap>({});
  mapRef.current = map;

  useEffect(() => {
    setMap(sanitizeColumnWidths(localStorageAdapter.read<unknown>(STORAGE_KEY_DB_COLUMN_WIDTHS)));
  }, []);

  const widthsFor = useCallback((scope: string) => scopeWidths(map, scope), [map]);

  const setWidth = useCallback((scope: string, column: string, width: number) => {
    if (!scope || !column) return;
    const key = `${scope}::${column.toLowerCase()}`;
    const next = { ...mapRef.current, [key]: clampColumnWidth(width) };
    mapRef.current = next;
    setMap(next);
    localStorageAdapter.write(STORAGE_KEY_DB_COLUMN_WIDTHS, next);
  }, []);

  return { widthsFor, setWidth };
}
