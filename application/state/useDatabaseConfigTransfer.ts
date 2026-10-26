/**
 * File-level export/import for database connections and JDBC drivers. Lives in
 * application state so components never touch infrastructure services.
 */

import { useMemo } from 'react';
import type { DatabaseConnection, JdbcDriver } from '../../domain/models';
import {
  parseDatabaseConfig,
  serializeDatabaseConfig,
  type ParsedDatabaseConfig,
} from '../../domain/database/connectionTransfer';
import { saveDatabaseTextFile } from '../../infrastructure/services/databaseService';

export type DatabaseConfigReadResult =
  | { ok: true; value: ParsedDatabaseConfig }
  | { ok: false; error: string };

export interface DatabaseConfigTransfer {
  exportToFile: (
    connections: readonly DatabaseConnection[],
    drivers: readonly JdbcDriver[],
  ) => Promise<{ ok: true; path?: string; canceled?: boolean } | { ok: false; error: string }>;
  readConfigFile: (file: File) => Promise<DatabaseConfigReadResult>;
}

export function useDatabaseConfigTransfer(): DatabaseConfigTransfer {
  return useMemo(
    () => ({
      async exportToFile(connections, drivers) {
        const text = serializeDatabaseConfig(connections, drivers);
        return saveDatabaseTextFile('netcatty-databases.json', text);
      },
      async readConfigFile(file) {
        try {
          return parseDatabaseConfig(await file.text());
        } catch {
          return { ok: false as const, error: 'read-failed' };
        }
      },
    }),
    [],
  );
}
