/**
 * Normalisation for the reusable JDBC driver registry.
 *
 * Drivers are device-local (absolute jar paths), so they are exported with the
 * vault for backup but never enter the cloud sync payload.
 */

import type { JdbcDriver } from '../models/database';

export function jdbcDriverJarPaths(driver: JdbcDriver | undefined | null): string[] {
  if (!driver) return [];
  const paths = driver.jarPaths?.length ? driver.jarPaths : [driver.jarPath];
  return paths.filter((path): path is string => typeof path === 'string' && path.trim().length > 0);
}

export function sanitizeJdbcDriver(input: unknown): JdbcDriver | null {
  if (!input || typeof input !== 'object') return null;
  const raw = input as Partial<JdbcDriver>;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!id || !name) return null;
  const jarPaths = jdbcDriverJarPaths(raw as JdbcDriver);
  if (jarPaths.length === 0) return null;
  const driver: JdbcDriver = {
    id,
    name,
    jarPath: jarPaths[0],
    jarPaths,
  };
  if (typeof raw.driverClass === 'string' && raw.driverClass.trim()) {
    driver.driverClass = raw.driverClass.trim();
  }
  if (typeof raw.presetId === 'string' && raw.presetId.trim()) {
    driver.presetId = raw.presetId.trim();
  }
  if (typeof raw.sha256 === 'string' && raw.sha256.trim()) {
    driver.sha256 = raw.sha256.trim();
  }
  if (typeof raw.sizeBytes === 'number' && Number.isFinite(raw.sizeBytes)) {
    driver.sizeBytes = raw.sizeBytes;
  }
  if (typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt)) {
    driver.createdAt = raw.createdAt;
  }
  return driver;
}

export function sanitizeJdbcDrivers(input: unknown): JdbcDriver[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const result: JdbcDriver[] = [];
  for (const entry of input) {
    const driver = sanitizeJdbcDriver(entry);
    if (!driver || seen.has(driver.id)) continue;
    seen.add(driver.id);
    result.push(driver);
  }
  return result;
}

export function findJdbcDriverName(drivers: JdbcDriver[], id: string | undefined): string | undefined {
  if (!id) return undefined;
  return drivers.find((driver) => driver.id === id)?.name;
}
