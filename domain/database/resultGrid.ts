/**
 * Pure helpers behind the result grid: cross-page sorting, fuzzy search and
 * multi-column copy. Kept free of DOM so they can be unit tested from Node.
 *
 * The grid shows one page of rows at a time but sorting and search always run
 * over the whole fetched result, which is what makes both features work across
 * page boundaries.
 */

import type { DbCellValue } from '../models/database';

export type ResultSortDirection = 'asc' | 'desc';

export interface ResultSort {
  /** Index into `result.columns`. */
  columnIndex: number;
  direction: ResultSortDirection;
}

export interface ResultMatch {
  /** Row index in the unsorted result. */
  rowIndex: number;
  /** Column index of the matching cell. */
  columnIndex: number;
}

function isNumericCell(value: DbCellValue): boolean {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Cell comparison used by sorting: numbers numerically, NULL/undefined last. */
export function compareResultCells(left: DbCellValue, right: DbCellValue): number {
  const leftEmpty = left === null || left === undefined;
  const rightEmpty = right === null || right === undefined;
  if (leftEmpty && rightEmpty) return 0;
  if (leftEmpty) return 1;
  if (rightEmpty) return -1;

  if (isNumericCell(left) && isNumericCell(right)) return Number(left) - Number(right);
  if (typeof left === 'boolean' && typeof right === 'boolean') {
    return Number(left) - Number(right);
  }
  return String(left).localeCompare(String(right), undefined, { numeric: true, sensitivity: 'base' });
}

/**
 * Row indices ordered by one column. The sort is stable: rows that compare equal
 * keep their original order, so paging and editing stay predictable.
 *
 * Empty cells always sort last, in both directions — that matches how database
 * clients usually display NULLs and keeps the "interesting" rows on top.
 */
export function sortResultRows(
  rows: readonly DbCellValue[][],
  sort: ResultSort | null | undefined,
): number[] {
  const indices = rows.map((_, index) => index);
  if (!sort || !Number.isInteger(sort.columnIndex) || sort.columnIndex < 0) return indices;
  const { columnIndex, direction } = sort;
  const sign = direction === 'desc' ? -1 : 1;
  return indices.sort((leftIndex, rightIndex) => {
    const left = rows[leftIndex]?.[columnIndex] ?? null;
    const right = rows[rightIndex]?.[columnIndex] ?? null;
    const leftEmpty = left === null || left === undefined;
    const rightEmpty = right === null || right === undefined;
    if (leftEmpty !== rightEmpty) return leftEmpty ? 1 : -1;
    const compared = compareResultCells(left, right);
    if (compared !== 0) return compared * sign;
    return leftIndex - rightIndex;
  });
}

/** Case-insensitive subsequence test: `abc` matches `a-b-c`. */
function isSubsequence(haystack: string, needle: string): boolean {
  if (needle.length === 0) return true;
  if (needle.length > haystack.length) return false;
  let cursor = 0;
  for (let index = 0; index < haystack.length && cursor < needle.length; index += 1) {
    if (haystack[index] === needle[cursor]) cursor += 1;
  }
  return cursor === needle.length;
}

export function cellMatchesQuery(value: DbCellValue, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return false;
  if (value === null || value === undefined) return false;
  const haystack = String(value).toLowerCase();
  if (haystack.includes(needle)) return true;
  return isSubsequence(haystack, needle);
}

/**
 * Every cell matching `query` across the fetched rows, in row-major order.
 * `columnIndexes` narrows the search to the selected columns; an empty list
 * means "all columns".
 */
export function findResultMatches(
  rows: readonly DbCellValue[][],
  columnIndexes: readonly number[],
  query: string,
): ResultMatch[] {
  const needle = query.trim();
  if (!needle) return [];
  const matches: ResultMatch[] = [];
  rows.forEach((row, rowIndex) => {
    const targets = columnIndexes.length > 0
      ? columnIndexes
      : row.map((_, columnIndex) => columnIndex);
    targets.forEach((columnIndex) => {
      if (cellMatchesQuery(row[columnIndex] ?? null, needle)) {
        matches.push({ rowIndex, columnIndex });
      }
    });
  });
  return matches;
}

/**
 * TSV of the selected columns (header included). Spreadsheet apps and terminals
 * both paste this correctly, which is what "copy column" is for.
 */
export function columnsToTsv(
  columns: readonly { name: string }[],
  rows: readonly DbCellValue[][],
  columnIndexes: readonly number[],
): string {
  const targets = columnIndexes.length > 0
    ? [...columnIndexes]
    : columns.map((_, index) => index);
  if (targets.length === 0) return '';
  const escape = (value: DbCellValue): string => {
    if (value === null || value === undefined) return '';
    return String(value).replace(/\t/g, ' ').replace(/\r?\n/g, ' ');
  };
  const header = targets.map((index) => escape(columns[index]?.name ?? `column_${index + 1}`)).join('\t');
  const body = rows.map((row) => targets.map((index) => escape(row[index] ?? null)).join('\t'));
  return [header, ...body].join('\n');
}

/** Single cell text, used by "copy cell" and by the search highlight. */
export function cellToText(value: DbCellValue): string {
  if (value === null || value === undefined) return '';
  return String(value);
}
