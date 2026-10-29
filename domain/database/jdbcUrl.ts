/**
 * JDBC URLs carry their own host and port, so an SSH tunnel that rewrites
 * `target.host`/`target.port` would be ignored by the driver. These helpers
 * swap the endpoint inside the URL text instead.
 *
 * Supported shapes:
 *   jdbc:mysql://host:3306/db?x=1        (also mariadb, postgresql, hive2, dm, ...)
 *   jdbc:sqlserver://host:1433;databaseName=x
 *   jdbc:oracle:thin:@host:1521:SID      /  jdbc:oracle:thin:@//host:1521/SERVICE
 */
export interface JdbcEndpoint {
  host: string;
  port: number | null;
}

/** Oracle thin URLs put the endpoint after `@`. */
const ORACLE_THIN = /^(jdbc:oracle:[^:]+:@)(\/\/)?([^/:;,@]+)(?::(\d+))?/i;
/** `jdbc:vendor://host:port/...` (the common shape). */
const VENDOR_URL = /^(jdbc:[\w+]+:\/\/)([^/:;,@]+)(?::(\d+))?/i;

/** Reads the host/port a JDBC URL dials, or null when it has no TCP endpoint. */
export function parseJdbcEndpoint(url: string): JdbcEndpoint | null {
  const trimmed = url.trim();
  if (!trimmed.toLowerCase().startsWith('jdbc:')) return null;

  const oracle = ORACLE_THIN.exec(trimmed);
  if (oracle) {
    return { host: oracle[3], port: oracle[4] ? Number(oracle[4]) : null };
  }
  const vendor = VENDOR_URL.exec(trimmed);
  if (vendor) {
    return { host: vendor[2], port: vendor[3] ? Number(vendor[3]) : null };
  }
  return null;
}

/**
 * Rewrites the endpoint of a JDBC URL to `host:port`, keeping every other part
 * (vendor, database path, parameters) untouched. Returns the input unchanged
 * when the URL has no recognizable endpoint.
 */
export function rewriteJdbcUrlEndpoint(url: string, host: string, port: number): string {
  const trimmed = url.trim();
  if (!parseJdbcEndpoint(trimmed)) return url;

  const oracle = ORACLE_THIN.exec(trimmed);
  if (oracle) {
    const [match, prefix, slashes = ''] = oracle;
    return `${prefix}${slashes}${host}:${port}${trimmed.slice(match.length)}`;
  }
  const vendor = VENDOR_URL.exec(trimmed);
  if (vendor) {
    const [match, prefix] = vendor;
    return `${prefix}${host}:${port}${trimmed.slice(match.length)}`;
  }
  return url;
}
