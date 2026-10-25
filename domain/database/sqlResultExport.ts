/**
 * Pure helpers that turn query results into portable text formats. Kept free of
 * DOM/localStorage so they can be unit tested from Node.
 */

import type { DbCellValue, DbQueryResult } from '../models/database';

function escapeCsvCell(value: DbCellValue): string {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'string' ? value : String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

/** RFC 4180-ish CSV with a header row; NULL becomes an empty field. */
export function resultToCsv(result: DbQueryResult | undefined): string {
  if (!result) return '';
  const header = result.columns.map((column) => escapeCsvCell(column.name)).join(',');
  const body = result.rows.map((row) => row.map((cell) => escapeCsvCell(cell)).join(','));
  return [header, ...body].join('\r\n');
}

export function suggestExportFileName(label: string, extension: string, now: number): string {
  const safeLabel = (label || 'query').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'query';
  const stamp = new Date(now).toISOString().slice(0, 19).replace(/[:T]/g, '-');
  return `${safeLabel}-${stamp}.${extension}`;
}

function cellToJsonValue(value: DbCellValue): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  return value;
}

/** Pretty-printed JSON array of row objects keyed by column name. */
export function resultToJson(result: DbQueryResult | undefined): string {
  if (!result) return '';
  const rows = result.rows.map((row) => {
    const entry: Record<string, string | number | boolean | null> = {};
    result.columns.forEach((column, index) => {
      entry[column.name] = cellToJsonValue(row[index]);
    });
    return entry;
  });
  return JSON.stringify(rows, null, 2);
}

function sqlLiteral(value: DbCellValue): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** INSERT statements that rebuild the result; table name is quoted per dialect. */
export function resultToInsertSql(
  result: DbQueryResult | undefined,
  tableName: string,
  dialect: 'postgresql' | 'mysql' | 'mariadb' | 'plsql' | 'sqlite' = 'postgresql',
): string {
  if (!result || result.rows.length === 0) return '';
  const quote = dialect === 'mysql' || dialect === 'mariadb' ? '`' : '"';
  const table = String(tableName || 'result_table')
    .split('.')
    .map((part) => `${quote}${part.replace(new RegExp(quote, 'g'), quote + quote)}${quote}`)
    .join('.');
  const columns = result.columns.map((column) => `${quote}${column.name.replace(new RegExp(quote, 'g'), quote + quote)}${quote}`).join(', ');
  return result.rows
    .map((row) => `INSERT INTO ${table} (${columns}) VALUES (${row.map((cell) => sqlLiteral(cell)).join(', ')});`)
    .join('\n');
}
