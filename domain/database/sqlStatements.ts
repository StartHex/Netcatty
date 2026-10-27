/**
 * Statement splitter for the SQL workbench.
 *
 * The JDBC sidecar executes exactly one statement per call (`Statement.execute`
 * returns a single `ResultSet`), so running a script with several statements has
 * to be split client-side and issued one by one. This splitter only needs to be
 * good enough to find real statement boundaries — it never rewrites the SQL, so
 * anything it keeps intact is exactly what the driver receives.
 *
 * Handled separators:
 * - `;` outside of strings, identifiers, comments and dollar-quoted bodies
 * - `GO` on its own line (SQL Server batch separator)
 *
 * Handled quoting so a `;` inside stays part of the statement:
 * - `'single quoted'` (with `''` and backslash escapes)
 * - `"double quoted"` identifiers
 * - `` `backtick` `` identifiers
 * - `-- line` comments, `/* block *\/` comments, MySQL `#` line comments
 * - PostgreSQL `$tag$ … $tag$` bodies (function bodies keep their semicolons)
 *
 * Known limitation: client tools that redefine the separator (`DELIMITER //` in
 * MySQL) are not modelled. Such scripts should be run one statement at a time.
 */

export interface SqlStatement {
  /** Statement text, whitespace-trimmed, without the trailing separator. */
  sql: string;
  /** 1-based line in the original script where the statement starts. */
  startLine: number;
}

const isIdentifierStart = (ch: string): boolean => /[A-Za-z_]/.test(ch);
const isIdentifierPart = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);

/** Reads `$tag$` (including bare `$$`) starting at `index`, or null. */
function readDollarTag(input: string, index: number): string | null {
  if (input[index] !== '$') return null;
  let cursor = index + 1;
  if (input[cursor] === '$') return '$$';
  if (!isIdentifierStart(input[cursor] ?? '')) return null;
  cursor += 1;
  while (cursor < input.length && isIdentifierPart(input[cursor])) cursor += 1;
  if (input[cursor] !== '$') return null;
  return input.slice(index, cursor + 1);
}

/** `GO` alone on a line, optionally followed by a repeat count. */
function readBatchSeparator(input: string, index: number): number | null {
  if (!/[Gg]/.test(input[index] ?? '')) return null;
  if (!/^[Gg][Oo]\b/.test(input.slice(index, index + 3))) return null;
  const lineStart = input.lastIndexOf('\n', index - 1) + 1;
  if (input.slice(lineStart, index).trim().length > 0) return null;
  const lineEnd = input.indexOf('\n', index);
  const rest = input.slice(index, lineEnd === -1 ? input.length : lineEnd);
  if (!/^[Gg][Oo](\s+\d+)?\s*$/.test(rest)) return null;
  return index + rest.length;
}

/**
 * Split a SQL script into individually executable statements.
 *
 * Empty segments (blank input, trailing `;`, `;;`, separator-only scripts) are
 * dropped so a script never sends a blank statement to the driver.
 */
export function splitSqlStatements(input: string): SqlStatement[] {
  const statements: SqlStatement[] = [];
  let start = -1;
  let startLine = 1;
  // Line of the first token that is not whitespace or a comment; a statement
  // that opens with comments still reports the line its code starts on.
  let codeLine = 0;
  let line = 1;

  const push = (end: number) => {
    if (start < 0) return;
    const sql = input.slice(start, end).trim();
    if (sql.length > 0) statements.push({ sql, startLine: codeLine || startLine });
    start = -1;
    codeLine = 0;
  };

  const begin = (index: number) => {
    if (start < 0) {
      start = index;
      startLine = line;
    }
  };

  let index = 0;
  while (index < input.length) {
    const ch = input[index];

    if (ch === '\n') {
      // A batch separator ends the statement; keep scanning from after it.
      const batchEnd = readBatchSeparator(input, index + 1);
      if (batchEnd !== null) {
        push(index);
        index = batchEnd;
        line += 1;
        continue;
      }
      line += 1;
      index += 1;
      continue;
    }
    if (/\s/.test(ch)) {
      index += 1;
      continue;
    }

    // A leading batch separator (`GO` on its own line) belongs to no statement.
    const leadingBatchEnd = start < 0 ? readBatchSeparator(input, index) : null;
    if (leadingBatchEnd !== null) {
      index = leadingBatchEnd;
      continue;
    }

    begin(index);

    // Line comments.
    if (ch === '-' && input[index + 1] === '-') {
      const end = input.indexOf('\n', index);
      index = end === -1 ? input.length : end;
      continue;
    }
    if (ch === '#' && input.slice(input.lastIndexOf('\n', index - 1) + 1, index).trim() === '') {
      const end = input.indexOf('\n', index);
      index = end === -1 ? input.length : end;
      continue;
    }

    // Block comments (not nested, matches every mainstream driver).
    if (ch === '/' && input[index + 1] === '*') {
      const end = input.indexOf('*/', index + 2);
      const stop = end === -1 ? input.length : end + 2;
      line += (input.slice(index, stop).match(/\n/g) ?? []).length;
      index = stop;
      continue;
    }

    // Everything below is statement code, not a comment.
    if (codeLine === 0) codeLine = line;

    // Dollar-quoted bodies (PostgreSQL functions keep their inner `;`).
    if (ch === '$') {
      const tag = readDollarTag(input, index);
      if (tag) {
        const end = input.indexOf(tag, index + tag.length);
        const stop = end === -1 ? input.length : end + tag.length;
        line += (input.slice(index, stop).match(/\n/g) ?? []).length;
        index = stop;
        continue;
      }
    }

    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      let cursor = index + 1;
      while (cursor < input.length) {
        const current = input[cursor];
        if (current === '\\' && quote === "'") {
          cursor += 2;
          continue;
        }
        if (current === quote) {
          if (input[cursor + 1] === quote) {
            cursor += 2;
            continue;
          }
          cursor += 1;
          break;
        }
        if (current === '\n') line += 1;
        cursor += 1;
      }
      index = cursor;
      continue;
    }

    if (ch === ';') {
      push(index);
      index += 1;
      continue;
    }

    index += 1;
  }

  push(input.length);
  return statements;
}
