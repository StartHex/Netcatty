/**
 * Workbench tab state: one tab per opened connection, query lifecycle, and
 * connection health. Kept out of the view so the SQL workbench component stays
 * presentational.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { DatabaseConnection, DbQueryResult } from '../../domain/models';
import {
  cancelDatabaseQuery,
  closeDatabaseConnection,
  databaseConnectionTarget,
  formatDatabaseError,
  openDatabaseConnection,
  controlDatabaseTransaction,
  listDatabaseTables,
  runDatabaseQuery,
  testDatabaseConnection,
  type DbBridgeError,
  type DbTableRef,
} from '../../infrastructure/services/databaseService';
import {
  applyDatabaseTunnel,
  closeAllDatabaseTunnels,
  closeDatabaseTunnel,
  ensureDatabaseTunnel,
  type DatabaseTunnelDeps,
} from '../../infrastructure/services/databaseTunnelService';
import type { DbConnectionTarget, DbTestConnectionResult } from '../../domain/models';

export type { DatabaseTunnelDeps } from '../../infrastructure/services/databaseTunnelService';
export type { DbColumnInfo, DbTableRef } from '../../infrastructure/services/databaseService';

export type DatabaseTabStatus = 'connecting' | 'ready' | 'error';

export interface DatabaseTab {
  id: string;
  connectionId: string;
  title: string;
  kind: DatabaseConnection['kind'];
  sql: string;
  status: DatabaseTabStatus;
  connected: boolean;
  running: boolean;
  serverVersion?: string;
  result?: DbQueryResult;
  error?: string;
  errorDetail?: DbBridgeError;
  durationMs?: number;
  transactionOpen?: boolean;
  tables?: DbTableRef[];
  tablesLoading?: boolean;
  tablesError?: string;
}

export interface UseDatabaseWorkbenchResult {
  tabs: DatabaseTab[];
  activeTabId: string | null;
  activeTab: DatabaseTab | undefined;
  openTab: (connection: DatabaseConnection) => Promise<string>;
  closeTab: (tabId: string) => void;
  setActiveTabId: (tabId: string | null) => void;
  updateSql: (tabId: string, sql: string) => void;
  runQuery: (tabId: string, sqlOverride?: string) => Promise<void>;
  beginTransaction: (tabId: string) => Promise<void>;
  commitTransaction: (tabId: string) => Promise<void>;
  rollbackTransaction: (tabId: string) => Promise<void>;
  refreshTables: (tabId: string) => Promise<void>;
  previewTable: (tabId: string, table: DbTableRef) => Promise<void>;
  cancelQuery: (tabId: string) => void;
  reconnect: (tabId: string) => Promise<void>;
}

/**
 * Ad-hoc connection test used by the connection editor. Lives here so components
 * never import infrastructure services directly.
 */
export function useDatabaseConnectionTester(
  tunnelDeps?: DatabaseTunnelDeps,
): { test: (connection: DatabaseConnection) => Promise<DbTestConnectionResult> } {
  const test = useCallback(
    async (connection: DatabaseConnection): Promise<DbTestConnectionResult> => {
      const base = databaseConnectionTarget(connection);
      if (!connection.sshHostId || !tunnelDeps) return testDatabaseConnection(base);
      const tunnel = await ensureDatabaseTunnel(connection, tunnelDeps);
      if (tunnel.ok !== true) return { ok: false, durationMs: 0, error: tunnel.error };
      return testDatabaseConnection(applyDatabaseTunnel(base, { host: tunnel.host, port: tunnel.port }));
    },
    [tunnelDeps],
  );
  return { test };
}

export function useDatabaseWorkbench(
  connections: DatabaseConnection[],
  tunnelDeps?: DatabaseTunnelDeps,
): UseDatabaseWorkbenchResult {
  const [tabs, setTabs] = useState<DatabaseTab[]>([]);
  const [activeTabId, setActiveTabIdState] = useState<string | null>(null);
  const tabsRef = useRef<DatabaseTab[]>(tabs);
  const connectionsRef = useRef<DatabaseConnection[]>(connections);
  const openSeqRef = useRef(new Map<string, number>());
  tabsRef.current = tabs;
  connectionsRef.current = connections;

  const patchTab = useCallback(
    (tabId: string, patch: Partial<DatabaseTab> | ((tab: DatabaseTab) => Partial<DatabaseTab>)) => {
      setTabs((prev) =>
        prev.map((tab) =>
          tab.id === tabId
            ? { ...tab, ...(typeof patch === 'function' ? patch(tab) : patch) }
            : tab,
        ),
      );
    },
    [],
  );

  const setActiveTabId = useCallback((tabId: string | null) => {
    setActiveTabIdState(tabId);
  }, []);

  const tunnelDepsRef = useRef(tunnelDeps);
  tunnelDepsRef.current = tunnelDeps;

  /** Resolve the dialable target, opening an SSH tunnel when the connection asks for one. */
  const resolveTarget = useCallback(
    async (
      connection: DatabaseConnection,
    ): Promise<{ ok: true; target: DbConnectionTarget } | { ok: false; error: string }> => {
      const base = databaseConnectionTarget(connection);
      const deps = tunnelDepsRef.current;
      if (!connection.sshHostId || !deps) return { ok: true, target: base };
      const tunnel = await ensureDatabaseTunnel(connection, deps);
      if (tunnel.ok !== true) return { ok: false, error: tunnel.error };
      return { ok: true, target: applyDatabaseTunnel(base, { host: tunnel.host, port: tunnel.port }) };
    },
    [],
  );

  const loadTables = useCallback(
    async (tabId: string, connection: DatabaseConnection) => {
      patchTab(tabId, { tablesLoading: true, tablesError: undefined });
      const resolved = await resolveTarget(connection);
      if (resolved.ok !== true) {
        patchTab(tabId, { tablesLoading: false, tablesError: resolved.error });
        return;
      }
      const response = await listDatabaseTables(resolved.target);
      if (response.ok === true) {
        patchTab(tabId, { tablesLoading: false, tables: response.tables });
      } else {
        patchTab(tabId, {
          tablesLoading: false,
          tablesError: formatDatabaseError(response.error),
        });
      }
    },
    [patchTab, resolveTarget],
  );

  const refreshTables = useCallback(
    async (tabId: string) => {
      const tab = tabsRef.current.find((entry) => entry.id === tabId);
      if (!tab) return;
      const connection = connectionsRef.current.find((entry) => entry.id === tab.connectionId);
      if (!connection) return;
      await loadTables(tabId, connection);
    },
    [loadTables],
  );

  const previewTable = useCallback(
    async (tabId: string, table: DbTableRef) => {
      const quoted = table.schema && table.schema !== 'main' ? `${table.schema}.${table.name}` : table.name;
      const sql = `select * from ${quoted} limit 100`;
      patchTab(tabId, { sql });
      const tab = tabsRef.current.find((entry) => entry.id === tabId);
      if (!tab) return;
      const connection = connectionsRef.current.find((entry) => entry.id === tab.connectionId);
      if (!connection) return;
      // Run through the same path as the toolbar button.
      const resolved = await resolveTarget(connection);
      if (resolved.ok !== true) {
        patchTab(tabId, { error: resolved.error });
        return;
      }
      patchTab(tabId, { running: true, error: undefined, errorDetail: undefined });
      const startedAt = Date.now();
      const response = await runDatabaseQuery(resolved.target, sql);
      if (response.ok === true && response.result) {
        patchTab(tabId, {
          running: false,
          result: response.result,
          durationMs: Date.now() - startedAt,
          error: undefined,
          errorDetail: undefined,
        });
      } else {
        const failureInfo = (response as { error?: DbBridgeError }).error;
        patchTab(tabId, {
          running: false,
          error: formatDatabaseError(failureInfo),
          errorDetail: failureInfo,
        });
      }
    },
    [patchTab, resolveTarget],
  );

  const connectTab = useCallback(
    async (tabId: string, connection: DatabaseConnection) => {
      const seq = (openSeqRef.current.get(tabId) ?? 0) + 1;
      openSeqRef.current.set(tabId, seq);
      patchTab(tabId, { status: 'connecting', error: undefined, errorDetail: undefined });
      try {
        const resolved = await resolveTarget(connection);
        if (openSeqRef.current.get(tabId) !== seq) return;
        if (resolved.ok !== true) {
          patchTab(tabId, { status: 'error', connected: false, error: resolved.error });
          return;
        }
        const result = await openDatabaseConnection(resolved.target);
        if (openSeqRef.current.get(tabId) !== seq) return;
        if (!result.ok) {
          patchTab(tabId, {
            status: 'error',
            connected: false,
            error: result.error ?? 'Connection failed',
          });
          return;
        }
        patchTab(tabId, {
          status: 'ready',
          connected: true,
          serverVersion: result.serverVersion,
          error: undefined,
          errorDetail: undefined,
        });
        void loadTables(tabId, connection);
      } catch (error) {
        if (openSeqRef.current.get(tabId) !== seq) return;
        patchTab(tabId, {
          status: 'error',
          connected: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [loadTables, patchTab, resolveTarget],
  );

  const openTab = useCallback(
    async (connection: DatabaseConnection) => {
      const existing = tabsRef.current.find((tab) => tab.connectionId === connection.id);
      if (existing) {
        setActiveTabIdState(existing.id);
        return existing.id;
      }
      const id = crypto.randomUUID();
      setTabs((prev) => [
        ...prev,
        {
          id,
          connectionId: connection.id,
          title: connection.label,
          kind: connection.kind,
          sql: '',
          status: 'connecting',
          connected: false,
          running: false,
        },
      ]);
      setActiveTabIdState(id);
      await connectTab(id, connection);
      return id;
    },
    [connectTab],
  );

  const closeTab = useCallback((tabId: string) => {
    const tab = tabsRef.current.find((entry) => entry.id === tabId);
    setTabs((prev) => {
      const next = prev.filter((entry) => entry.id !== tabId);
      setActiveTabIdState((current) => {
        if (current !== tabId) return current;
        return next.length > 0 ? next[next.length - 1].id : null;
      });
      return next;
    });
    if (tab) {
      void closeDatabaseConnection(tab.connectionId);
      void closeDatabaseTunnel(tab.connectionId);
    }
  }, []);

  const updateSql = useCallback(
    (tabId: string, sql: string) => {
      patchTab(tabId, { sql });
    },
    [patchTab],
  );

  const runQuery = useCallback(
    async (tabId: string, sqlOverride?: string) => {
      const tab = tabsRef.current.find((entry) => entry.id === tabId);
      if (!tab || tab.running) return;
      const sql = (sqlOverride ?? tab.sql).trim();
      if (!sql) return;
      const connection = connectionsRef.current.find((entry) => entry.id === tab.connectionId);
      if (!connection) {
        patchTab(tabId, { error: 'Connection was deleted', errorDetail: undefined });
        return;
      }
      patchTab(tabId, { running: true, error: undefined, errorDetail: undefined });
      const startedAt = Date.now();
      try {
        const resolved = await resolveTarget(connection);
        if (resolved.ok !== true) {
          patchTab(tabId, { running: false, error: resolved.error });
          return;
        }
        const response = await runDatabaseQuery(resolved.target, sql);
        if (response.ok === true && response.result) {
          patchTab(tabId, {
            running: false,
            status: 'ready',
            connected: true,
            result: response.result,
            durationMs: Date.now() - startedAt,
            error: undefined,
            errorDetail: undefined,
          });
        } else {
          const bridgeError = response.ok === false ? response.error : undefined;
          patchTab(tabId, {
            running: false,
            error: formatDatabaseError(bridgeError),
            errorDetail: bridgeError,
          });
        }
      } catch (error) {
        patchTab(tabId, {
          running: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [patchTab, resolveTarget],
  );

  const controlTransaction = useCallback(
    async (tabId: string, action: 'begin' | 'commit' | 'rollback') => {
      const tab = tabsRef.current.find((entry) => entry.id === tabId);
      if (!tab) return;
      const connection = connectionsRef.current.find((entry) => entry.id === tab.connectionId);
      if (!connection) return;
      const resolved = await resolveTarget(connection);
      if (resolved.ok !== true) {
        patchTab(tabId, { error: resolved.error });
        return;
      }
      const response = await controlDatabaseTransaction(resolved.target, action);
      if (response.ok !== true) {
        patchTab(tabId, { error: formatDatabaseError(response.error), errorDetail: response.error });
        return;
      }
      patchTab(tabId, {
        transactionOpen: action === 'begin' ? true : false,
        error: undefined,
        errorDetail: undefined,
      });
    },
    [patchTab, resolveTarget],
  );

  const beginTransaction = useCallback(
    (tabId: string) => controlTransaction(tabId, 'begin'),
    [controlTransaction],
  );
  const commitTransaction = useCallback(
    (tabId: string) => controlTransaction(tabId, 'commit'),
    [controlTransaction],
  );
  const rollbackTransaction = useCallback(
    (tabId: string) => controlTransaction(tabId, 'rollback'),
    [controlTransaction],
  );

  const cancelQuery = useCallback((tabId: string) => {
    const tab = tabsRef.current.find((entry) => entry.id === tabId);
    if (!tab) return;
    void cancelDatabaseQuery(tab.connectionId).finally(() => {
      patchTab(tabId, { running: false, error: 'Query cancelled' });
    });
  }, [patchTab]);

  const reconnect = useCallback(
    async (tabId: string) => {
      const tab = tabsRef.current.find((entry) => entry.id === tabId);
      if (!tab) return;
      const connection = connectionsRef.current.find((entry) => entry.id === tab.connectionId);
      if (!connection) return;
      await connectTab(tabId, connection);
    },
    [connectTab],
  );

  const activeTab = tabs.find((tab) => tab.id === activeTabId);

  useEffect(() => () => {
    // Closing the workbench drops every pooled session and ad-hoc SSH tunnel.
    for (const tab of tabsRef.current) void closeDatabaseConnection(tab.connectionId);
    void closeAllDatabaseTunnels();
  }, []);

  return {
    tabs,
    activeTabId,
    activeTab,
    openTab,
    closeTab,
    setActiveTabId,
    updateSql,
    runQuery,
    refreshTables,
    previewTable,
    beginTransaction,
    commitTransaction,
    rollbackTransaction,
    cancelQuery,
    reconnect,
  };
}
