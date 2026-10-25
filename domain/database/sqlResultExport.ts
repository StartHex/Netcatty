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
