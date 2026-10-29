import type { DatabaseKind } from '../models';

/** Client charsets the workbench offers for MySQL/MariaDB and JDBC connections. */
export const DATABASE_ENCODINGS = [
  'utf8mb4',
  'utf8',
  'gbk',
  'gb18030',
  'big5',
  'latin1',
] as const;

export type DatabaseEncoding = (typeof DATABASE_ENCODINGS)[number];

/**
 * Only drivers with a per-connection charset negotiate text encoding: MySQL
 * maps it to the connection charset, JDBC to the driver `characterEncoding`
 * property. Postgres/MSSQL/Oracle/SQLite hand back UTF-8 (or NLS-decoded)
 * strings and have no client-side switch.
 */
export function supportsClientEncoding(kind: DatabaseKind): boolean {
  return kind === 'mysql' || kind === 'mariadb' || kind === 'jdbc';
}

/** Encoding to show as active; undefined means "driver default". */
export function currentDatabaseEncoding(
  kind: DatabaseKind,
  explicit?: string,
): string | null {
  if (!supportsClientEncoding(kind)) return null;
  return explicit && explicit.trim() ? explicit.trim() : 'utf8mb4';
}
