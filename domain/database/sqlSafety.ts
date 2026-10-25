/**
 * Very small SQL risk classifier. It is not a parser: it exists so the
 * workbench can block obviously destructive statements on read-only
 * connections and warn before a statement that touches data without a WHERE.
 *
 * Anything it cannot recognise is treated as a write, never as safe.
 */

export type SqlRisk = 'read' | 'write' | 'destructive';

const DESTRUCTIVE = /^(drop|truncate)\b/i;
const WRITE = /^(insert|update|delete|merge|create|alter|rename|grant|revoke|comment|copy|call|exec|execute|vacuum|analyze|reindex|refresh|begin|start|commit|rollback|set|use|attach|detach|pragma)\b/i;

/** Statements that are destructive regardless of WHERE. */
function isDestructive(statement: string): boolean {
  return DESTRUCTIVE.test(statement.trim());
}

/** UPDATE/DELETE without a WHERE clause destroy every row. */
function isUnboundedMutation(statement: string): boolean {
  const trimmed = statement.trim().replace(/;+$/, '');
  if (!/^(update|delete)\b/i.test(trimmed)) return false;
  return !/\bwhere\b/i.test(trimmed);
}

/**
 * Splits a script on semicolons that are not inside quotes/comments. Good
 * enough for the safety check and for the "run script" affordance.
 */
export function splitSqlScript(script: string): string[] {
  const statements: string[] = [];
  let current = '';
  let quote: '"' | "'" | '`' | null = null;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < script.length; index += 1) {
    const char = script[index];
    const next = script[index + 1];
    if (lineComment) {
      current += char;
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      current += char;
      if (char === '*' && next === '/') {
        current += next;
        index += 1;
        blockComment = false;
      }
      continue;
    }
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === '-' && next === '-') {
      current += char;
      lineComment = true;
      continue;
    }
    if (char === '/' && next === '*') {
      current += char;
      blockComment = true;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      current += char;
      continue;
    }
    if (char === ';') {
      if (current.trim()) statements.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

export interface SqlSafetyReport {
  risk: SqlRisk;
  statements: string[];
  /** Human readable reasons, e.g. "delete-without-where". */
  reasons: string[];
}

/** Classifies a script: the highest risk of any statement wins. */
export function classifySqlSafety(sql: string): SqlSafetyReport {
  const statements = splitSqlScript(sql ?? '');
  const reasons: string[] = [];
  let risk: SqlRisk = 'read';
  for (const statement of statements) {
    if (isDestructive(statement)) {
      risk = 'destructive';
      reasons.push(/^drop\b/i.test(statement) ? 'drop' : 'truncate');
      continue;
    }
    if (isUnboundedMutation(statement)) {
      risk = 'destructive';
      reasons.push(/^update\b/i.test(statement) ? 'update-without-where' : 'delete-without-where');
      continue;
    }
    if (WRITE.test(statement)) {
      if (risk === 'read') risk = 'write';
      reasons.push('write');
      continue;
    }
    if (!/^(select|with|show|describe|desc|explain|values|table)\b/i.test(statement)) {
      if (risk === 'read') risk = 'write';
      reasons.push('unknown-statement');
    }
  }
  return { risk, statements, reasons: Array.from(new Set(reasons)) };
}
