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

export async function cancelDatabaseQuery(connectionId: string): Promise<void> {
  await bridge()?.dbCancel?.({ id: connectionId });
}

export async function closeDatabaseConnection(connectionId: string): Promise<void> {
  await bridge()?.dbDisconnect?.({ id: connectionId });
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
