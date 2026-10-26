import type { DatabaseKind } from "../models";

export interface TablePreviewRef {
  schema?: string;
  name: string;
}

function qualifiedName(table: TablePreviewRef): string {
  const name = String(table.name || "").trim();
  const schema = String(table.schema || "").trim();
  if (!schema || schema === "main" || name.startsWith(`${schema}.`)) return name;
  return `${schema}.${name}`;
}

/**
 * Preview SQL differs per engine: MySQL/Postgres/SQLite use `limit`, SQL Server
 * uses `top`, Oracle has `fetch first` but older versions reject it, and JDBC
 * drivers may implement `limit` by rewriting the statement (which breaks
 * Oracle-like dialects such as DM/e-mobile). For the last two we send plain
 * SQL and let the workbench cap rows while streaming.
 */
export function buildTablePreviewSql(
  kind: DatabaseKind | undefined,
  table: TablePreviewRef,
  limit: number,
): string {
  const target = qualifiedName(table);
  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0;
  if (kind === "sqlserver" && cap > 0) return `select top ${cap} * from ${target}`;
  if ((kind === "postgresql" || kind === "mysql" || kind === "mariadb" || kind === "sqlite") && cap > 0) {
    return `select * from ${target} limit ${cap}`;
  }
  return `select * from ${target}`;
}
