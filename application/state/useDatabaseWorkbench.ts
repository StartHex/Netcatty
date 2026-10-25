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
  runDatabaseQuery,
  testDatabaseConnection,
  type DbBridgeError,
} from '../../infrastructure/services/databaseService';

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
}

export interface UseDatabaseWorkbenchResult {
  tabs: DatabaseTab[];
  activeTabId: string | null;
  activeTab: DatabaseTab | undefined;
  openTab: (connection: DatabaseConnection) => Promise<string>;
  closeTab: (tabId: string) => void;
  setActiveTabId: (tabId: string | null) => void;
  updateSql: (tabId: string, sql: string) => void;
  runQuery: (tabId: string) => Promise<void>;
  cancelQuery: (tabId: string) => void;
  reconnect: (tabId: string) => Promise<void>;
}

/**
 * Ad-hoc connection test used by the connection editor. Lives here so components
 * never import infrastructure services directly.
 */
export function useDatabaseConnectionTester(): {
  test: typeof testDatabaseConnection;
} {
  return { test: testDatabaseConnection };
}

export function useDatabaseWorkbench(connections: DatabaseConnection[]): UseDatabaseWorkbenchResult {
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

  const connectTab = useCallback(
    async (tabId: string, connection: DatabaseConnection) => {
      const seq = (openSeqRef.current.get(tabId) ?? 0) + 1;
      openSeqRef.current.set(tabId, seq);
      patchTab(tabId, { status: 'connecting', error: undefined, errorDetail: undefined });
      try {
        const result = await openDatabaseConnection(databaseConnectionTarget(connection));
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
      } catch (error) {
        if (openSeqRef.current.get(tabId) !== seq) return;
        patchTab(tabId, {
          status: 'error',
          connected: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [patchTab],
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
    if (tab) void closeDatabaseConnection(tab.connectionId);
  }, []);

  const updateSql = useCallback(
    (tabId: string, sql: string) => {
      patchTab(tabId, { sql });
    },
    [patchTab],
  );

  const runQuery = useCallback(
    async (tabId: string) => {
      const tab = tabsRef.current.find((entry) => entry.id === tabId);
      if (!tab || tab.running) return;
      const sql = tab.sql.trim();
      if (!sql) return;
      const connection = connectionsRef.current.find((entry) => entry.id === tab.connectionId);
      if (!connection) {
        patchTab(tabId, { error: 'Connection was deleted', errorDetail: undefined });
        return;
      }
      patchTab(tabId, { running: true, error: undefined, errorDetail: undefined });
      const startedAt = Date.now();
      try {
        const response = await runDatabaseQuery(databaseConnectionTarget(connection), sql);
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
    [patchTab],
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
    // Closing the workbench drops every pooled session.
    for (const tab of tabsRef.current) void closeDatabaseConnection(tab.connectionId);
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
    cancelQuery,
    reconnect,
  };
}
