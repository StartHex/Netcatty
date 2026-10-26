/**
 * Portable export/import for database connections and JDBC driver presets.
 * Secrets are never written to disk: passwords are dropped, so an imported
 * connection asks for them again on first use.
 */

import type { DatabaseConnection, JdbcDriver } from '../models/database';

export const DATABASE_CONFIG_FILE_VERSION = 1;

export interface DatabaseConfigFile {
  version: number;
  exportedAt: string;
  connections: DatabaseConnection[];
  drivers: JdbcDriver[];
}

export interface ParsedDatabaseConfig {
  connections: DatabaseConnection[];
  drivers: JdbcDriver[];
}

function stripSecrets(connection: DatabaseConnection): DatabaseConnection {
  return { ...connection, password: '', savePassword: false };
}

export function buildDatabaseConfigFile(
  connections: readonly DatabaseConnection[],
  drivers: readonly JdbcDriver[],
  now: number = Date.now(),
): DatabaseConfigFile {
  return {
    version: DATABASE_CONFIG_FILE_VERSION,
    exportedAt: new Date(now).toISOString(),
    connections: connections.map(stripSecrets),
    drivers: drivers.map((driver) => ({ ...driver })),
  };
}

export function serializeDatabaseConfig(
  connections: readonly DatabaseConnection[],
  drivers: readonly JdbcDriver[],
  now: number = Date.now(),
): string {
  return `${JSON.stringify(buildDatabaseConfigFile(connections, drivers, now), null, 2)}\n`;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readConnection(value: unknown): DatabaseConnection | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const id = asString(raw.id);
  const kind = asString(raw.kind) as DatabaseConnection['kind'] | undefined;
  const label = asString(raw.label);
  if (!id || !kind || !label) return null;
  const connection: DatabaseConnection = {
    ...(raw as unknown as DatabaseConnection),
    id,
    kind,
    label,
    password: '',
    savePassword: false,
  };
  return connection;
}

function readDriver(value: unknown): JdbcDriver | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const id = asString(raw.id);
  const name = asString(raw.name);
  if (!id || !name) return null;
  return raw as unknown as JdbcDriver;
}

export function parseDatabaseConfig(
  text: string,
): { ok: true; value: ParsedDatabaseConfig } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: 'invalid-json' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'invalid-shape' };
  }
  const raw = parsed as Record<string, unknown>;
  const connections = asArray(raw.connections)
    .map(readConnection)
    .filter((entry): entry is DatabaseConnection => entry !== null);
  const drivers = asArray(raw.drivers)
    .map(readDriver)
    .filter((entry): entry is JdbcDriver => entry !== null);
  if (connections.length === 0 && drivers.length === 0) {
    return { ok: false, error: 'empty' };
  }
  return { ok: true, value: { connections, drivers } };
}

export interface MergeResult<T> {
  items: T[];
  added: number;
  updated: number;
}

/**
 * Merges imported rows by id. Existing rows keep their saved password, since
 * exports never carry one.
 */
export function mergeImported<T extends { id: string }>(
  existing: readonly T[],
  incoming: readonly T[],
): MergeResult<T> {
  const items = existing.map((entry) => ({ ...entry }));
  const indexById = new Map(items.map((entry, index) => [entry.id, index]));
  let added = 0;
  let updated = 0;
  for (const entry of incoming) {
    const index = indexById.get(entry.id);
    if (index === undefined) {
      indexById.set(entry.id, items.length);
      items.push({ ...entry });
      added += 1;
    } else {
      const previous = items[index] as T & { password?: string };
      const next = { ...entry } as T & { password?: string };
      if (!next.password && previous.password) next.password = previous.password;
      items[index] = next;
      updated += 1;
    }
  }
  return { items, added, updated };
}
