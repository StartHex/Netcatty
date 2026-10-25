/**
 * SQL workbench: connection tabs, a Monaco SQL editor, and a virtualized result
 * grid. All query orchestration lives in useDatabaseWorkbench.
 */

import {
  AlertTriangle,
  ArrowUpDown,
  Bookmark,
  BookmarkPlus,
  Download,
  History,
  Loader2,
  Play,
  RotateCw,
  Square,
  Table2,
  Eye,
  FileCode2,
  Wand2,
  X,
} from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { format as formatSqlText } from 'sql-formatter';
import { useI18n } from '../../application/i18n/I18nProvider';
import { useDatabaseWorkbench, type DatabaseTab } from '../../application/state/useDatabaseWorkbench';
import type { DatabaseConnection, DbCellValue, DbQueryResult } from '../../domain/models';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import { FixedSizeVirtualList } from '../ui/FixedSizeVirtualList';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { ScriptCodeEditor, type ScriptCodeEditorHandle } from '../scripts/ScriptCodeEditor';
import { useSqlHistory } from '../../application/state/useSqlHistory';
import type { DatabaseTunnelDeps, DbTableRef } from '../../application/state/useDatabaseWorkbench';
import {
  resultToCsv,
  resultToInsertSql,
  resultToJson,
  suggestExportFileName,
} from '../../domain/database/sqlResultExport';
import { classifySqlSafety } from '../../domain/database/sqlSafety';
import { readSqlFile } from '@/infrastructure/services/databaseService.ts';
import { netcattyBridge } from '@/infrastructure/services/netcattyBridge.ts';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { toast } from '../ui/toast';

const SQL_DIALECTS: Record<string, 'postgresql' | 'mysql' | 'mariadb' | 'plsql' | 'sqlite'> = {
  postgresql: 'postgresql',
  mysql: 'mysql',
  mariadb: 'mariadb',
  oracle: 'plsql',
  sqlite: 'sqlite',
} as const;

const CELL_PADDING_X = 12;
const MIN_COLUMN_WIDTH = 120;
const MAX_COLUMN_WIDTH = 420;

function cellText(value: DbCellValue): string {
  if (value === null) return 'NULL';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

function columnWidths(result: DbQueryResult | undefined): number[] {
  if (!result) return [];
  const sample = result.rows.slice(0, 50);
  return result.columns.map((column, index) => {
    let longest = column.name.length;
    for (const row of sample) {
      const text = cellText(row[index]);
      if (text.length > longest) longest = text.length;
    }
    return Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, longest * 7.5 + CELL_PADDING_X * 2 + 12));
  });
}

function StatusDot({ tab }: { tab: DatabaseTab }) {
  if (tab.status === 'connecting') {
    return <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />;
  }
  if (tab.status === 'error' || !tab.connected) {
    return <span className="h-1.5 w-1.5 rounded-full bg-destructive" />;
  }
  return <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />;
}

interface SqlWorkbenchProps {
  open: boolean;
  connections: DatabaseConnection[];
  /** Vault lookups used to dial connections that route through an SSH host. */
  tunnelDeps?: DatabaseTunnelDeps;
  initialConnection?: DatabaseConnection | null;
  onUpdateConnections?: (connections: DatabaseConnection[] | ((prev: DatabaseConnection[]) => DatabaseConnection[])) => void;
  onClose: () => void;
}

export const SqlWorkbench: React.FC<SqlWorkbenchProps> = ({
  open,
  connections,
  initialConnection,
  onUpdateConnections,
  tunnelDeps,
  onClose,
}) => {
  const { t } = useI18n();
  const workbench = useDatabaseWorkbench(connections, tunnelDeps);
  const { tabs, activeTab, activeTabId } = workbench;
  const openedRef = useRef<string | null>(null);

  useEffect(() => {
    if (!open) {
      openedRef.current = null;
      return;
    }
    if (!initialConnection) return;
    if (openedRef.current === initialConnection.id) return;
    openedRef.current = initialConnection.id;
    void workbench.openTab(initialConnection);
  }, [open, initialConnection, workbench]);

  const editorRef = useRef<ScriptCodeEditorHandle | null>(null);
  const sqlHistory = useSqlHistory();
  const activeConnection = useMemo(
    () => connections.find((connection) => connection.id === activeTab?.connectionId),
    [connections, activeTab?.connectionId],
  );
  const [pendingRun, setPendingRun] = useState<{ tabId: string; sql: string; reasons: string[] } | null>(null);
  const [saveQueryOpen, setSaveQueryOpen] = useState(false);
  const [saveQueryName, setSaveQueryName] = useState('');

  const executeSql = useCallback(
    (tabId: string, sqlOverride: string | undefined) => {
      const tab = tabs.find((entry) => entry.id === tabId);
      if (!tab) return;
      sqlHistory.record(tab.connectionId, sqlOverride ?? tab.sql);
      void workbench.runQuery(tabId, sqlOverride);
    },
    [sqlHistory, tabs, workbench],
  );

  const runActiveQuery = useCallback(() => {
    if (!activeTab) return;
    const selection = editorRef.current?.getSelectionText()?.trim();
    const hasSelection = Boolean(selection && selection.length > 0);
    const sql = hasSelection ? selection! : activeTab.sql;
    const trimmed = sql.trim();
    if (!trimmed) return;
    const safety = classifySqlSafety(trimmed);
    if (activeConnection?.readOnly && safety.risk !== 'read') {
      toast.error(t('databases.workbench.readOnlyBlocked'));
      return;
    }
    if (safety.risk === 'destructive') {
      setPendingRun({ tabId: activeTab.id, sql: trimmed, reasons: safety.reasons });
      return;
    }
    executeSql(activeTab.id, hasSelection ? selection : undefined);
  }, [activeConnection?.readOnly, activeTab, executeSql, t]);

  const downloadResult = useCallback(
    (format: 'csv' | 'json' | 'sql') => {
      const result = activeTab?.result;
      if (!result) return;
      const dialect = SQL_DIALECTS[activeTab!.kind] ?? 'postgresql';
      const tableMatch = /\bfrom\s+([\w."`]+)/i.exec(activeTab!.sql);
      const tableName = tableMatch ? tableMatch[1].replace(/["`]/g, '') : 'result';
      const payload =
        format === 'csv'
          ? resultToCsv(result)
          : format === 'json'
            ? resultToJson(result)
            : resultToInsertSql(result, tableName, dialect);
      if (!payload) return;
      const mime = format === 'csv' ? 'text/csv' : format === 'json' ? 'application/json' : 'application/sql';
      const prefix = format === 'csv' ? '\ufeff' : '';
      const blob = new Blob([`${prefix}${payload}`], { type: `${mime};charset=utf-8;` });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = suggestExportFileName(activeTab!.title, format === 'sql' ? 'sql' : format, Date.now());
      anchor.click();
      URL.revokeObjectURL(url);
    },
    [activeTab],
  );

  const openSqlFile = useCallback(async () => {
    if (!activeTab) return;
    const bridge = netcattyBridge.get();
    if (!bridge?.selectFile) return;
    const filePath = await bridge.selectFile(t('databases.workbench.openSqlFileTitle'), undefined, [
      { name: 'SQL', extensions: ['sql', 'txt'] },
    ]);
    if (!filePath) return;
    const loaded = await readSqlFile(filePath);
    if (!loaded.ok) {
      toast.error(t('databases.workbench.openSqlFileFailed', { error: (loaded as { error?: string }).error ?? 'read-failed' }));
      return;
    }
    workbench.updateSql(activeTab.id, loaded.text);
    sqlHistory.record(activeTab.connectionId, loaded.text);
    toast.success(t('databases.workbench.openSqlFileLoaded'));
  }, [activeTab, sqlHistory, t, workbench]);

  const saveCurrentQuery = useCallback(() => {
    if (!activeTab || !onUpdateConnections) return;
    const name = saveQueryName.trim();
    const sql = editorRef.current?.getSelectionText()?.trim() || activeTab.sql.trim();
    if (!name || !sql) return;
    const connectionId = activeTab.connectionId;
    const query = { id: `q_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, name, sql, createdAt: Date.now() };
    onUpdateConnections((prev) =>
      prev.map((entry) =>
        entry.id === connectionId
          ? { ...entry, savedQueries: [...(entry.savedQueries ?? []), query] }
          : entry,
      ),
    );
    setSaveQueryOpen(false);
    setSaveQueryName('');
    toast.success(t('databases.workbench.saveQuerySaved'));
  }, [activeTab, onUpdateConnections, saveQueryName, t]);

  const loadSavedQuery = useCallback(
    (sql: string) => {
      if (!activeTab) return;
      workbench.updateSql(activeTab.id, sql);
    },
    [activeTab, workbench],
  );

  const deleteSavedQuery = useCallback(
    (queryId: string) => {
      if (!activeTab || !onUpdateConnections) return;
      const connectionId = activeTab.connectionId;
      onUpdateConnections((prev) =>
        prev.map((entry) =>
          entry.id === connectionId
            ? { ...entry, savedQueries: (entry.savedQueries ?? []).filter((q) => q.id !== queryId) }
            : entry,
        ),
      );
    },
    [activeTab, onUpdateConnections],
  );

  const activeHistory = sqlHistory.entriesFor(activeTab?.connectionId);

  const widths = useMemo(() => columnWidths(activeTab?.result), [activeTab?.result]);
  const gridTemplate = useMemo(
    () => widths.map((width) => `${Math.round(width)}px`).join(' '),
    [widths],
  );

  const formatSql = () => {
    if (!activeTab) return;
    const dialect = SQL_DIALECTS[activeTab.kind] ?? 'postgresql';
    try {
      const formatted = formatSqlText(activeTab.sql, { language: dialect as never });
      if (formatted && formatted !== activeTab.sql) workbench.updateSql(activeTab.id, formatted);
    } catch {
      // Formatting is best-effort; leave the statement untouched on parse errors.
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (!next ? onClose() : undefined)}>
      <DialogContent className="flex h-[88vh] w-[94vw] max-w-[1500px] flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 border-b border-border/60 px-4 py-2.5">
          <DialogTitle className="text-sm">{t('databases.workbench.title')}</DialogTitle>
        </DialogHeader>

        <div className="flex shrink-0 items-stretch overflow-x-auto border-b border-border/60">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              role="tab"
              aria-selected={tab.id === activeTabId}
              className={cn(
                'group flex min-w-[140px] max-w-[240px] cursor-pointer items-center gap-1.5 border-r border-border/50 px-3 py-2 text-xs',
                tab.id === activeTabId ? 'bg-secondary/70 text-foreground' : 'text-muted-foreground hover:bg-secondary/40',
              )}
              onClick={() => workbench.setActiveTabId(tab.id)}
            >
              <StatusDot tab={tab} />
              <span className="truncate">{tab.title}</span>
              <button
                type="button"
                className="ml-auto rounded p-0.5 opacity-60 hover:bg-background hover:opacity-100"
                aria-label={t('databases.workbench.closeTab')}
                onClick={(event) => {
                  event.stopPropagation();
                  workbench.closeTab(tab.id);
                }}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>

        {activeTab ? (
          <>
            <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-1.5">
              <Button
                size="sm"
                className="h-7 text-xs"
                disabled={activeTab.running || !activeTab.connected || !activeTab.sql.trim()}
                onClick={runActiveQuery}
              >
                {activeTab.running ? (
                  <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                ) : (
                  <Play className="mr-1 h-3 w-3" />
                )}
                {activeTab.running ? t('databases.workbench.running') : t('databases.workbench.run')}
              </Button>
              {activeTab.running ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  onClick={() => workbench.cancelQuery(activeTab.id)}
                >
                  <Square className="mr-1 h-3 w-3" />
                  {t('databases.workbench.cancel')}
                </Button>
              ) : null}
              <Popover>
                <PopoverTrigger asChild>
                  <Button size="sm" variant="ghost" className="h-7 w-7 p-0">
                    <Bookmark className="h-3.5 w-3.5" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-72 p-1">
                  {(activeConnection?.savedQueries ?? []).length === 0 ? (
                    <p className="px-2 py-3 text-xs text-muted-foreground">
                      {t('databases.workbench.savedQueriesEmpty')}
                    </p>
                  ) : (
                    <div className="max-h-64 overflow-auto">
                      {(activeConnection?.savedQueries ?? []).map((query) => (
                        <div key={query.id} className="group flex items-center gap-1 rounded px-1">
                          <button
                            type="button"
                            className="flex-1 truncate px-1 py-1 text-left text-xs hover:text-foreground"
                            title={query.sql}
                            onClick={() => loadSavedQuery(query.sql)}
                          >
                            {query.name}
                          </button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100"
                            onClick={() => deleteSavedQuery(query.id)}
                          >
                            <X className="h-3 w-3" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </PopoverContent>
              </Popover>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 w-7 p-0"
                    disabled={!activeTab || !onUpdateConnections}
                    onClick={() => {
                      setSaveQueryName('');
                      setSaveQueryOpen(true);
                    }}
                  >
                    <BookmarkPlus className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('databases.workbench.saveQuery')}</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 w-7 p-0"
                    onClick={() => void openSqlFile()}
                  >
                    <FileCode2 className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('databases.workbench.openSqlFile')}</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={formatSql}>
                    <Wand2 className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('databases.workbench.format')}</TooltipContent>
              </Tooltip>
              {activeTab.transactionOpen ? (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    disabled={activeTab.running}
                    onClick={() => void workbench.commitTransaction(activeTab.id)}
                  >
                    {t('databases.workbench.commit')}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-xs"
                    disabled={activeTab.running}
                    onClick={() => void workbench.rollbackTransaction(activeTab.id)}
                  >
                    {t('databases.workbench.rollback')}
                  </Button>
                </>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs"
                  disabled={activeTab.running || !activeTab.connected}
                  onClick={() => void workbench.beginTransaction(activeTab.id)}
                >
                  {t('databases.workbench.beginTransaction')}
                </Button>
              )}
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 w-7 p-0"
                    disabled={activeHistory.length === 0}
                    aria-label={t('databases.workbench.history')}
                  >
                    <History className="h-3.5 w-3.5" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-[420px] p-1">
                  <div className="max-h-[320px] overflow-y-auto">
                    {activeHistory.slice(0, 20).map((entry) => (
                      <button
                        key={`${entry.at}-${entry.sql.slice(0, 40)}`}
                        type="button"
                        className="block w-full truncate rounded px-2 py-1.5 text-left font-mono text-[11px] hover:bg-secondary"
                        title={entry.sql}
                        onClick={() => {
                          workbench.updateSql(activeTab.id, entry.sql);
                        }}
                      >
                        {entry.sql.replace(/\s+/g, ' ')}
                      </button>
                    ))}
                  </div>
                </PopoverContent>
              </Popover>
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 w-7 p-0"
                    disabled={!activeTab.result}
                    title={t('databases.workbench.exportCsv')}
                  >
                    <Download className="h-3.5 w-3.5" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="end" className="w-40 p-1">
                  <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground px-2 py-1">
                    {t('databases.workbench.exportTitle')}
                  </div>
                  {(['csv', 'json', 'sql'] as const).map((format) => (
                    <button
                      key={format}
                      type="button"
                      className="flex w-full items-center rounded px-2 py-1.5 text-left text-xs hover:bg-secondary"
                      onClick={() => downloadResult(format)}
                    >
                      {t(`databases.workbench.export.${format}`)}
                    </button>
                  ))}
                </PopoverContent>
              </Popover>
              {activeTab.status === 'error' ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  onClick={() => void workbench.reconnect(activeTab.id)}
                >
                  <RotateCw className="mr-1 h-3 w-3" />
                  {t('databases.workbench.reconnect')}
                </Button>
              ) : null}
              <span className="ml-auto truncate font-mono text-[11px] text-muted-foreground">
                {activeTab.serverVersion ?? ''}
              </span>
            </div>

            <div className="flex min-h-0 flex-1">
              <SchemaPanel
                tab={activeTab}
                onRefresh={() => void workbench.refreshTables(activeTab.id)}
                onPreview={(table) => void workbench.previewTable(activeTab.id, table)}
                t={t}
              />
              <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex min-h-0 basis-[38%] flex-col border-b border-border/60">
              <ScriptCodeEditor
                value={activeTab.sql}
                onChange={(value) => workbench.updateSql(activeTab.id, value)}
                language="sql"
                fill
                active={open}
                autoFocus
                ariaLabel={t('databases.workbench.editorLabel')}
                placeholder={t('databases.workbench.placeholder')}
                ref={editorRef}
                onSubmitShortcut={runActiveQuery}
              />
            </div>

            <div className="flex min-h-0 flex-1 flex-col">
              {activeTab.error ? (
                <div className="shrink-0 border-b border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                  <div className="flex items-start gap-1.5">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <div className="min-w-0 space-y-0.5">
                      <p className="whitespace-pre-wrap break-words font-medium">{activeTab.error}</p>
                      {activeTab.errorDetail?.detail ? (
                        <p className="opacity-80">{activeTab.errorDetail.detail}</p>
                      ) : null}
                      {activeTab.errorDetail?.hint ? (
                        <p className="opacity-80">{activeTab.errorDetail.hint}</p>
                      ) : null}
                    </div>
                  </div>
                </div>
              ) : null}

              {activeTab.result ? (
                <ResultGrid result={activeTab.result} gridTemplate={gridTemplate} t={t} />
              ) : (
                <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
                  <ArrowUpDown className="h-5 w-5 text-muted-foreground/60" />
                  <p className="max-w-md text-xs text-muted-foreground">
                    {activeTab.status === 'connecting'
                      ? t('databases.workbench.connecting')
                      : t('databases.workbench.emptyHint')}
                  </p>
                </div>
              )}

              <div className="flex shrink-0 items-center gap-4 border-t border-border/60 px-3 py-1 text-[11px] text-muted-foreground">
                <span>
                  {t('databases.workbench.rowCount', {
                    count: String(activeTab.result?.rowCount ?? 0),
                  })}
                </span>
                {activeTab.result?.truncated ? (
                  <span className="text-amber-600 dark:text-amber-400">
                    {t('databases.workbench.truncated')}
                  </span>
                ) : null}
                {activeTab.result?.command ? <span className="font-mono">{activeTab.result.command}</span> : null}
                {typeof activeTab.durationMs === 'number' ? (
                  <span className="ml-auto tabular-nums">
                    {t('databases.workbench.elapsed', { ms: String(activeTab.durationMs) })}
                  </span>
                ) : null}
              </div>
            </div>
              </div>
            </div>
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
            {t('databases.workbench.noTab')}
          </div>
        )}
      </DialogContent>
      <Dialog open={saveQueryOpen} onOpenChange={setSaveQueryOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('databases.workbench.saveQueryTitle')}</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            value={saveQueryName}
            placeholder={t('databases.workbench.saveQueryPlaceholder')}
            onChange={(event) => setSaveQueryName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') saveCurrentQuery();
            }}
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setSaveQueryOpen(false)}>
              {t('databases.form.cancel')}
            </Button>
            <Button disabled={!saveQueryName.trim()} onClick={saveCurrentQuery}>
              {t('databases.form.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={pendingRun !== null}
        title={t('databases.workbench.confirmDangerTitle')}
        message={t('databases.workbench.confirmDangerMessage')}
        confirmLabel={t('databases.workbench.confirmDangerRun')}
        destructive
        onOpenChange={(next) => {
          if (!next) setPendingRun(null);
        }}
        onConfirm={() => {
          if (!pendingRun) return;
          executeSql(pendingRun.tabId, pendingRun.sql);
          setPendingRun(null);
        }}
      />
    </Dialog>
  );
};

interface SchemaPanelProps {
  tab: DatabaseTab;
  onRefresh: () => void;
  onPreview: (table: DbTableRef) => void;
  t: ReturnType<typeof useI18n>['t'];
}

const SchemaPanel: React.FC<SchemaPanelProps> = ({ tab, onRefresh, onPreview, t }) => {
  const grouped = useMemo(() => {
    const map = new Map<string, DbTableRef[]>();
    for (const table of tab.tables ?? []) {
      const list = map.get(table.schema) ?? [];
      list.push(table);
      map.set(table.schema, list);
    }
    return [...map.entries()];
  }, [tab.tables]);

  return (
    <div className="flex w-[190px] shrink-0 flex-col border-r border-border/60">
      <div className="flex shrink-0 items-center justify-between border-b border-border/60 px-2 py-1">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {t('databases.schema.title')}
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="sm"
              variant="ghost"
              className="h-5 w-5 p-0"
              disabled={tab.tablesLoading}
              onClick={onRefresh}
            >
              <RotateCw className={cn('h-3 w-3', tab.tablesLoading && 'animate-spin')} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t('databases.schema.refresh')}</TooltipContent>
        </Tooltip>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1">
        {tab.tablesError ? (
          <p className="px-1 py-2 text-[11px] text-destructive">{tab.tablesError}</p>
        ) : grouped.length === 0 ? (
          <p className="px-1 py-2 text-[11px] text-muted-foreground">
            {tab.tablesLoading ? t('databases.schema.loading') : t('databases.schema.empty')}
          </p>
        ) : (
          grouped.map(([schema, tables]) => (
            <div key={schema} className="mb-1">
              {grouped.length > 1 ? (
                <p className="px-1 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground/80">
                  {schema}
                </p>
              ) : null}
              {tables.map((table) => (
                <button
                  key={`${table.schema}.${table.name}`}
                  type="button"
                  className="flex w-full items-center gap-1 rounded px-1 py-0.5 text-left text-[11px] hover:bg-secondary"
                  title={`${table.schema}.${table.name}`}
                  onClick={() => onPreview(table)}
                >
                  {table.type === 'view' ? (
                    <Eye className="h-3 w-3 shrink-0 text-muted-foreground" />
                  ) : (
                    <Table2 className="h-3 w-3 shrink-0 text-muted-foreground" />
                  )}
                  <span className="truncate">{table.name}</span>
                </button>
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  );
};

interface ResultGridProps {
  result: DbQueryResult;
  gridTemplate: string;
  t: ReturnType<typeof useI18n>['t'];
}

const ResultGrid: React.FC<ResultGridProps> = ({ result, gridTemplate, t }) => {
  if (result.columns.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
        {result.command
          ? t('databases.workbench.statementOk', { command: result.command })
          : t('databases.workbench.noColumns')}
      </div>
    );
  }
  return (
    <div className="min-h-0 flex-1 overflow-x-auto">
      <div className="flex min-h-full flex-col" style={{ minWidth: '100%' }}>
        <div
          className="sticky top-0 z-10 grid shrink-0 border-b border-border/60 bg-secondary/60"
          style={{ gridTemplateColumns: gridTemplate }}
        >
          {result.columns.map((column, index) => (
            <div
              key={`${column.name}-${index}`}
              className="truncate px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
              title={column.type ? `${column.name} · ${column.type}` : column.name}
            >
              {column.name}
            </div>
          ))}
        </div>
        <FixedSizeVirtualList
          items={result.rows}
          itemHeight={28}
          className="min-h-0 flex-1"
          getItemKey={(_row, index) => String(index)}
          renderItem={(row, rowIndex) => (
            <div
              className={cn(
                'grid h-7 items-center text-xs',
                rowIndex % 2 === 1 ? 'bg-secondary/20' : 'bg-transparent',
              )}
              style={{ gridTemplateColumns: gridTemplate }}
            >
              {row.map((value, cellIndex) => (
                <div
                  key={cellIndex}
                  className={cn(
                    'truncate px-3 font-mono',
                    value !== null && 'cursor-pointer hover:bg-secondary/40',
                    value === null && 'italic text-muted-foreground/70',
                    typeof value === 'number' && 'text-right tabular-nums',
                  )}
                  title={cellText(value)}
                  onClick={() => {
                    if (value === null) return;
                    void navigator.clipboard?.writeText(String(value)).then(() => {
                      toast.success(t('databases.workbench.cellCopied'));
                    });
                  }}
                >
                  {cellText(value)}
                </div>
              ))}
            </div>
          )}
        />
      </div>
    </div>
  );
};
