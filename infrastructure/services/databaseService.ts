/**
 * Renderer-side wrapper around the database bridge.
 *
 * The bridge speaks a narrow JSON protocol; this module turns vault entities
 * into connection targets (resolving the stored password placeholder) and keeps
 * error shaping in one place so the UI never needs to understand driver errors.
 */

import { databaseConnectionTarget } from '../../domain/models';
import type {
  DbConnectionTarget,
  DbExecResult,
  DbQueryResult,
  DbTestConnectionResult,
} from '../../domain/models';
import { netcattyBridge } from './netcattyBridge';

export type DbBridgeError = {
  message: string;
  code?: string;
  sqlState?: string;
  position?: number;
  detail?: string;
  hint?: string;
};

const bridge = () => netcattyBridge.get();

function requireDbBridge() {
  const api = bridge();
  if (!api?.dbQuery) {
    throw new Error('Database support is unavailable in this build');
  }
  return api;
}

function normalizeConnectResult(value: unknown): DbTestConnectionResult {
  if (!value || typeof value !== 'object') {
    return { ok: false, durationMs: 0, error: 'No response from database bridge' };
  }
  const record = value as {
    ok?: boolean;
    durationMs?: number;
    serverVersion?: string;
    error?: string | { message?: string };
  };
  const error =
    typeof record.error === 'string'
      ? record.error
      : record.error && typeof record.error.message === 'string'
        ? record.error.message
        : undefined;
  return {
    ok: record.ok === true,
    durationMs: typeof record.durationMs === 'number' ? record.durationMs : 0,
    serverVersion: record.serverVersion,
    error,
  };
}

export { databaseConnectionTarget };

export async function testDatabaseConnection(
  target: DbConnectionTarget,
): Promise<DbTestConnectionResult> {
  const api = requireDbBridge();
  return normalizeConnectResult(await api.dbTestConnection?.(target));
}

export async function openDatabaseConnection(
  target: DbConnectionTarget,
): Promise<DbTestConnectionResult> {
  const api = requireDbBridge();
  return normalizeConnectResult(await api.dbConnect?.(target));
}

export async function runDatabaseQuery(
  target: DbConnectionTarget,
  sql: string,
  options?: { maxRows?: number; timeoutMs?: number },
): Promise<{ ok: true; result: DbQueryResult } | { ok: false; error: DbBridgeError }> {
  const api = requireDbBridge();
  const response = await api.dbQuery?.({ target, sql, ...options });
  if (!response) return { ok: false, error: { message: 'No response from database bridge' } };
  if (!response.ok || !response.result) {
    return { ok: false, error: response.error ?? { message: 'Query failed' } };
  }
  return { ok: true, result: response.result };
}

export interface DbTableRef {
  schema: string;
  name: string;
  type: 'table' | 'view';
}

export interface DbColumnInfo {
  name: string;
  type?: string;
  nullable?: boolean;
  /** Primary-key member; required to edit table rows in place. */
  primaryKey?: boolean;
}

export async function listDatabaseTables(
  target: DbConnectionTarget,
): Promise<{ ok: true; tables: DbTableRef[] } | { ok: false; error: DbBridgeError }> {
  const api = requireDbBridge();
  const response = await api.dbTables?.({ target });
  if (!response) return { ok: false, error: { message: 'No response from database bridge' } };
  if (!response.ok || !response.tables) {
    return { ok: false, error: response.error ?? { message: 'Listing tables failed' } };
  }
  return { ok: true, tables: response.tables };
}

export async function listDatabaseColumns(
  target: DbConnectionTarget,
  table: string,
  schema?: string,
): Promise<{ ok: true; columns: DbColumnInfo[] } | { ok: false; error: DbBridgeError }> {
  const api = requireDbBridge();
  const response = await api.dbColumns?.({ target, schema, table });
  if (!response) return { ok: false, error: { message: 'No response from database bridge' } };
  if (!response.ok || !response.columns) {
    return { ok: false, error: response.error ?? { message: 'Listing columns failed' } };
  }
  return { ok: true, columns: response.columns };
}

export type DbTransactionAction = 'begin' | 'commit' | 'rollback';

export async function controlDatabaseTransaction(
  target: DbConnectionTarget,
  action: DbTransactionAction,
): Promise<{ ok: true } | { ok: false; error: DbBridgeError }> {
  const api = requireDbBridge();
  const response = await api.dbControl?.({ target, action });
  if (!response) return { ok: false, error: { message: 'No response from database bridge' } };
  if (!response.ok) return { ok: false, error: response.error ?? { message: 'Transaction failed' } };
  return { ok: true };
}

export async function cancelDatabaseQuery(connectionId: string): Promise<void> {
  await bridge()?.dbCancel?.({ id: connectionId });
}

export async function closeDatabaseConnection(connectionId: string): Promise<void> {
  await bridge()?.dbDisconnect?.({ id: connectionId });
}

/** Loads a .sql script the user picked; the main process enforces a 5 MB cap. */
export async function readSqlFile(
  path: string,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const response = await bridge()?.dbReadSqlFile?.(path);
  if (!response) return { ok: false, error: 'No response from database bridge' };
  if (!response.ok || typeof response.text !== 'string') {
    return { ok: false, error: response.error ?? 'read-failed' };
  }
  return { ok: true, text: response.text };
}

/** Saves exported config/SQL through the native save dialog. */
export async function saveDatabaseTextFile(
  defaultName: string,
  content: string,
): Promise<{ ok: true; path?: string; canceled?: boolean } | { ok: false; error: string }> {
  const response = await bridge()?.dbSaveTextFile?.({ defaultName, content });
  if (!response) return { ok: false, error: 'No response from database bridge' };
  if (response.ok !== true) return { ok: false, error: response.error ?? 'write-failed' };
  return { ok: true, path: response.path, canceled: response.canceled };
}

/** Driver classes declared by a JDBC jar (META-INF/services/java.sql.Driver). */
export async function readJdbcDriverClasses(jarPath: string): Promise<string[]> {
  try {
    const response = await bridge()?.dbDriverClasses?.({ jarPath });
    return response?.ok && Array.isArray(response.classes) ? response.classes : [];
  } catch {
    return [];
  }
}

export type JavaRuntimeInfo = {
  ok: boolean;
  path?: string;
  version?: string;
  error?: string;
};

/** Asks the main process which Java runtime the JDBC sidecar would launch. */
export async function detectJavaRuntime(javaPath?: string): Promise<JavaRuntimeInfo> {
  try {
    const response = await bridge()?.dbJavaRuntime?.({ javaPath });
    if (response?.ok && response.path) {
      return { ok: true, path: response.path, version: response.version ?? 'java' };
    }
    return { ok: false, error: response?.error ?? 'Java runtime not found' };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function disposeDatabaseConnections(): Promise<void> {
  await bridge()?.dbDispose?.();
}

/** Single-line error for toasts and inline messages. */
export function formatDatabaseError(error: DbBridgeError | undefined | null): string {
  if (!error) return 'Unknown database error';
  const parts = [error.message];
  if (error.sqlState) parts.push(`SQLSTATE ${error.sqlState}`);
  else if (error.code) parts.push(error.code);
  if (error.position) parts.push(`position ${error.position}`);
  return parts.join(' · ');
}

export type { DbExecResult };
