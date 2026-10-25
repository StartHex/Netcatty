/**
 * Query history bookkeeping. Entries are capped per connection and identical
 * statements are promoted instead of duplicated.
 */

export interface SqlHistoryEntry {
  sql: string;
  at: number;
  ok: boolean;
}

export const SQL_HISTORY_LIMIT = 100;

export type SqlHistoryMap = Record<string, SqlHistoryEntry[]>;

function isEntry(value: unknown): value is SqlHistoryEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<SqlHistoryEntry>;
  return typeof entry.sql === 'string' && entry.sql.length > 0 && typeof entry.at === 'number';
}

export function sanitizeSqlHistory(value: unknown, limit = SQL_HISTORY_LIMIT): SqlHistoryMap {
  if (!value || typeof value !== 'object') return {};
  const source = value as Record<string, unknown>;
  const result: SqlHistoryMap = {};
  for (const [connectionId, entries] of Object.entries(source)) {
    if (!connectionId || !Array.isArray(entries)) continue;
    const cleaned = entries.filter(isEntry).slice(0, limit).map((entry) => ({
      sql: entry.sql,
      at: entry.at,
      ok: entry.ok === true,
    }));
    if (cleaned.length > 0) result[connectionId] = cleaned;
  }
  return result;
}

export function addSqlHistoryEntry(
  entries: readonly SqlHistoryEntry[],
  entry: SqlHistoryEntry,
  limit = SQL_HISTORY_LIMIT,
): SqlHistoryEntry[] {
  const sql = entry.sql.trim();
  if (!sql) return [...entries];
  const deduped = entries.filter((existing) => existing.sql.trim() !== sql);
  return [{ ...entry, sql }, ...deduped].slice(0, limit);
}

export function listSqlHistory(entries: readonly SqlHistoryEntry[] | undefined, limit = 20): SqlHistoryEntry[] {
  if (!entries) return [];
  return entries.slice(0, limit);
}
