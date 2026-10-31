import type { DatabaseConnection } from '../models/database';

/** Idle time before the workbench checks that a connection is still alive. */
export const CONNECTION_IDLE_PROBE_MS = 60_000;
/** How often idle connections are re-checked. */
export const CONNECTION_PROBE_INTERVAL_MS = 15_000;

/**
 * Cheapest statement that proves the session still round-trips. VPN drops and
 * idle server-side timeouts otherwise surface as a failed user query with no
 * hint that the connection died minutes earlier.
 */
export function connectivityProbeSql(kind: DatabaseConnection['kind'] | undefined): string {
  if (kind === 'oracle') return 'select 1 from dual';
  return 'select 1';
}
