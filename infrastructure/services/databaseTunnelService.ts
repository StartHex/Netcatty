/**
 * Ad-hoc SSH tunnels for database connections.
 *
 * When a `DatabaseConnection` carries `tunnelHostId`, the connection is dialed
 * through an existing vault host using a dedicated local port forward. The
 * ephemeral rule never touches port-forwarding persistence: it lives only in
 * renderer memory and is stopped when the workbench closes the connection.
 */

import {
  DATABASE_DEFAULT_PORTS,
  databaseEffectivePort,
  type DatabaseConnection,
  type DbConnectionTarget,
} from '../../domain/models';
import type { PortForwardingRule } from '../../domain/models/portForwarding';
import type { Host, Identity, KnownHost, SSHKey, TerminalSettings } from '../../domain/models';
import { parseJdbcEndpoint, rewriteJdbcUrlEndpoint } from '../../domain/database/jdbcUrl';
import { startPortForward, stopPortForward } from './portForwardingService';

export interface DatabaseTunnelDeps {
  hosts: readonly Host[];
  keys: readonly SSHKey[];
  identities: readonly Identity[];
  knownHosts?: readonly KnownHost[];
  terminalSettings?: Pick<
    TerminalSettings,
    'verifyHostKeys' | 'keepaliveInterval' | 'keepaliveCountMax'
  >;
}

interface TunnelRecord {
  ruleId: string;
  host: string;
  port: number;
}

const tunnels = new Map<string, TunnelRecord>();

const noopStatus = () => {};

function tunnelRuleId(connectionId: string): string {
  return `db-tunnel-${connectionId}`;
}

function buildRule(connection: DatabaseConnection, ruleId: string, remotePort: number): PortForwardingRule {
  return {
    id: ruleId,
    label: `DB tunnel: ${connection.label}`,
    type: 'local',
    localPort: 0,
    bindAddress: '127.0.0.1',
    remoteHost: connection.host || '127.0.0.1',
    remotePort,
    hostId: connection.sshHostId,
    status: 'inactive',
    createdAt: Date.now(),
  };
}

export const hasDatabaseTunnel = (connectionId: string): boolean => tunnels.has(connectionId);

/**
 * The host/port a connection dials. JDBC connections usually keep both inside
 * `jdbcUrl`, so fall back to parsing it before the kind defaults.
 */
function resolveRemoteEndpoint(connection: DatabaseConnection): { host: string; port: number } {
  const jdbc = connection.kind === 'jdbc' && connection.jdbcUrl
    ? parseJdbcEndpoint(connection.jdbcUrl)
    : null;
  const port = databaseEffectivePort(connection)
    ?? jdbc?.port
    ?? DATABASE_DEFAULT_PORTS[connection.kind];
  return { host: connection.host || jdbc?.host || '127.0.0.1', port };
}

export async function ensureDatabaseTunnel(
  connection: DatabaseConnection,
  deps: DatabaseTunnelDeps,
): Promise<{ ok: true; host: string; port: number } | { ok: false; error: string }> {
  const remote = resolveRemoteEndpoint(connection);
  const remotePort = remote.port;
  if (!connection.sshHostId) {
    return { ok: true, host: remote.host, port: remotePort };
  }
  const existing = tunnels.get(connection.id);
  if (existing) return { ok: true, host: existing.host, port: existing.port };

  const jumpHost = deps.hosts.find((host) => host.id === connection.sshHostId);
  if (!jumpHost) {
    return { ok: false, error: 'The SSH host used for this tunnel no longer exists' };
  }

  const ruleId = tunnelRuleId(connection.id);
  const rule = buildRule(connection, ruleId, remotePort);
  const started = await startPortForward(
    rule,
    jumpHost,
    [...deps.hosts],
    [...deps.keys],
    [...deps.identities],
    noopStatus,
    false,
    deps.terminalSettings,
    deps.knownHosts ? [...deps.knownHosts] : undefined,
  );
  if (!started.success) {
    return { ok: false, error: started.error || 'Failed to open the SSH tunnel' };
  }
  const localPort = started.localPort;
  if (!localPort) {
    await stopPortForward(ruleId, noopStatus).catch(() => undefined);
    return { ok: false, error: 'The SSH tunnel did not report a local port' };
  }
  const record: TunnelRecord = { ruleId, host: '127.0.0.1', port: localPort };
  tunnels.set(connection.id, record);
  return { ok: true, host: record.host, port: record.port };
}

export async function closeDatabaseTunnel(connectionId: string): Promise<void> {
  const record = tunnels.get(connectionId);
  if (!record) return;
  tunnels.delete(connectionId);
  await stopPortForward(record.ruleId, noopStatus).catch(() => undefined);
}

export async function closeAllDatabaseTunnels(): Promise<void> {
  const ids = [...tunnels.keys()];
  await Promise.all(ids.map((id) => closeDatabaseTunnel(id)));
}

/** Rewrite a connection target to the tunneled endpoint when one is active. */
export function applyDatabaseTunnel(
  target: DbConnectionTarget,
  tunnel: { host: string; port: number } | null,
): DbConnectionTarget {
  if (!tunnel) return target;
  // JDBC drivers read host/port from the URL, so rewrite it as well.
  const jdbcUrl = target.jdbcUrl
    ? rewriteJdbcUrlEndpoint(target.jdbcUrl, tunnel.host, tunnel.port)
    : undefined;
  return { ...target, host: tunnel.host, port: tunnel.port, ...(jdbcUrl ? { jdbcUrl } : {}) };
}
