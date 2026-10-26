/**
 * Workbench tab state: one tab per opened connection, query lifecycle, and
 * connection health. Kept out of the view so the SQL workbench component stays
 * presentational.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { DatabaseConnection, DbQueryResult } from '../../domain/models';
import { buildTablePreviewSql } from '../../domain/database/tablePreview';
import {
  cancelDatabaseQuery,
  closeDatabaseConnection,
  databaseConnectionTarget,
  listDatabaseColumns,
  formatDatabaseError,
  openDatabaseConnection,
  controlDatabaseTransaction,
  listDatabaseTables,
  runDatabaseQuery,
  testDatabaseConnection,
  type DbBridgeError,
  type DbColumnInfo,
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
import { databaseTabStore, useDatabaseTabRequest } from './databaseTabStore';

export type { DatabaseTunnelDeps } from '../../infrastructure/services/databaseTunnelService';
export type { DbColumnInfo, DbTableRef } from '../../infrastructure/services/databaseService';

/** Rows fetched for a statement that carries no LIMIT of its own. */
const FULL_RESULT_ROWS = 10000;

export type DatabaseTabStatus = 'idle' | 'connecting' | 'ready' | 'error';

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
  /** Row cap for the next run (100..5000). */
  maxRows: number;
  /** Column metadata shown by the schema panel's structure view. */
  structure?: { table: DbTableRef; columns: DbColumnInfo[]; loading?: boolean; error?: string };
}

export interface UseDatabaseWorkbenchResult {
  tabs: DatabaseTab[];
  activeTabId: string | null;
  activeTab: DatabaseTab | undefined;
  openTab: (connection: DatabaseConnection, options?: { forceNew?: boolean }) => Promise<string>;
  closeTab: (tabId: string) => void;
  setActiveTabId: (tabId: string | null) => void;
  updateSql: (tabId: string, sql: string) => void;
  runQuery: (tabId: string, sqlOverride?: string, options?: { maxRows?: number }) => Promise<void>;
  setMaxRows: (tabId: string, maxRows: number) => void;
  beginTransaction: (tabId: string) => Promise<void>;
  commitTransaction: (tabId: string) => Promise<void>;
  rollbackTransaction: (tabId: string) => Promise<void>;
  refreshTables: (tabId: string) => Promise<void>;
  previewTable: (tabId: string, table: DbTableRef) => Promise<void>;
  showStructure: (tabId: string, table: DbTableRef) => Promise<void>;
  clearStructure: (tabId: string) => void;
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
      const activeTab = tabsRef.current.find((entry) => entry.id === tabId);
      const sql = buildTablePreviewSql(activeTab?.kind, table, activeTab?.maxRows ?? 1000);
      patchTab(tabId, { sql });
      if (!activeTab) return;
      const connection = connectionsRef.current.find((entry) => entry.id === activeTab.connectionId);
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

  const showStructure = useCallback(
    async (tabId: string, table: DbTableRef) => {
      const activeTab = tabsRef.current.find((entry) => entry.id === tabId);
      if (!activeTab) return;
      const connection = connectionsRef.current.find((entry) => entry.id === activeTab.connectionId);
      if (!connection) return;
      patchTab(tabId, { structure: { table, columns: [], loading: true } });
      const resolved = await resolveTarget(connection);
      if (resolved.ok !== true) {
        patchTab(tabId, { structure: { table, columns: [], error: resolved.error } });
        return;
      }
      const response = await listDatabaseColumns(resolved.target, table.name, table.schema);
      if (response.ok === true) {
        patchTab(tabId, { structure: { table, columns: response.columns } });
      } else {
        patchTab(tabId, {
          structure: { table, columns: [], error: formatDatabaseError(response.error) },
        });
      }
    },
    [patchTab, resolveTarget],
  );

  const clearStructure = useCallback(
    (tabId: string) => {
      patchTab(tabId, { structure: undefined });
    },
    [patchTab],
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
    async (connection: DatabaseConnection, options?: { forceNew?: boolean }) => {
      const existing = options?.forceNew
        ? undefined
        : tabsRef.current.find((tab) => tab.connectionId === connection.id);
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
          maxRows: 1000,
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

  const setMaxRows = useCallback(
    (tabId: string, maxRows: number) => {
      const clamped = Math.min(5000, Math.max(100, Math.round(maxRows)));
      patchTab(tabId, { maxRows: clamped });
    },
    [patchTab],
  );

  const runQuery = useCallback(
    async (tabId: string, sqlOverride?: string, options?: { maxRows?: number }) => {
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
        // Statements without their own LIMIT load a full page set so the grid
        // can paginate client-side; tab.maxRows is the page size, not a cap.
        const maxRows = options?.maxRows ?? FULL_RESULT_ROWS;
        const response = await runDatabaseQuery(resolved.target, sql, { maxRows });
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

  // Hydrate persisted tabs once connections are available. Restored tabs stay
  // disconnected until the user activates them.
  const hydrateGuardRef = useRef(false);
  useEffect(() => {
    if (hydrateGuardRef.current) return;
    if (connections.length === 0) return;
    hydrateGuardRef.current = true;
    const persisted = databaseTabStore.loadPersisted();
    if (!persisted || persisted.tabs.length === 0) return;
    const restored = persisted.tabs
      .map((entry) => {
        const connection = connections.find((item) => item.id === entry.connectionId);
        if (!connection) return null;
        const tab: DatabaseTab = {
          id: entry.id,
          connectionId: entry.connectionId,
          title: entry.title || connection.label,
          kind: connection.kind,
          sql: databaseTabStore.loadDraft(entry.id) ?? entry.sql ?? '',
          status: 'idle',
          connected: false,
          running: false,
          maxRows: 1000,
        };
        return tab;
      })
      .filter((tab): tab is DatabaseTab => tab !== null);
    if (restored.length === 0) return;
    setTabs((prev) => (prev.length === 0 ? restored : prev));
    const persistedActive = persisted.activeTabId;
    setActiveTabIdState((current) =>
      current ??
      (persistedActive && restored.some((tab) => tab.id === persistedActive)
        ? persistedActive
        : restored[0].id),
    );
  }, [connections]);

  // Publish tab summaries for the tab bar and persist drafts for restart restore.
  useEffect(() => {
    const summaries = tabs.map((tab) => ({
      id: tab.id,
      connectionId: tab.connectionId,
      title: tab.title,
      kind: tab.kind,
      status: (tab.connected ? 'ready' : tab.status) as 'idle' | 'connecting' | 'ready' | 'error',
      transactionOpen: tab.transactionOpen,
    }));
    databaseTabStore.sync(summaries, activeTabId);
    databaseTabStore.saveDrafts(
      tabs.map((tab) => ({
        id: tab.id,
        connectionId: tab.connectionId,
        title: tab.title,
        sql: tab.sql,
      })),
      activeTabId,
    );
  }, [tabs, activeTabId]);

  // Requests raised by the vault list / tab bar (open or close).
  const tabRequest = useDatabaseTabRequest();
  useEffect(() => {
    if (!tabRequest) return;
    databaseTabStore.clearRequest(tabRequest.nonce);
    if (tabRequest.type === 'open') {
      const connection = connectionsRef.current.find((item) => item.id === tabRequest.connectionId);
      if (!connection) return;
      void openTab(connection, { forceNew: tabRequest.forceNew }).then((id) => {
        setActiveTabIdState(id);
        databaseTabStore.activate(id);
        databaseTabStore.markActive(id);
      });
    } else if (tabRequest.type === 'close') {
      closeTab(tabRequest.tabId);
    }
  }, [tabRequest, openTab, closeTab]);

  // A restored tab connects lazily the first time it becomes active.
  useEffect(() => {
    if (!activeTabId) return;
    const tab = tabsRef.current.find((entry) => entry.id === activeTabId);
    if (!tab || tab.status !== 'idle') return;
    const connection = connectionsRef.current.find((entry) => entry.id === tab.connectionId);
    if (!connection) return;
    void connectTab(activeTabId, connection);
  }, [activeTabId, connectTab]);

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
    setMaxRows,
    refreshTables,
    previewTable,
    showStructure,
    clearStructure,
    beginTransaction,
    commitTransaction,
    rollbackTransaction,
    cancelQuery,
    reconnect,
  };
}
