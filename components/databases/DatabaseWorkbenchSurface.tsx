/**
 * SQL workbench: connection tabs, a Monaco SQL editor, and a virtualized result
 * grid. All query orchestration lives in useDatabaseWorkbench.
 */

import {
  AlertTriangle,
  Columns2,
  ArrowUpDown,
  Bookmark,
  BookmarkPlus,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  History,
  Loader2,
  Play,
  RotateCw,
  Rows2,
  Square,
  Table2,
  Trash2,
  Eye,
  FileCode2,
  Wand2,
  X,
} from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { format as formatSqlText } from 'sql-formatter';
import { useI18n } from '../../application/i18n/I18nProvider';
import { useDatabaseWorkbench, type DatabaseTab } from '../../application/state/useDatabaseWorkbench';
import { databaseTabStore } from '../../application/state/databaseTabStore';
import type { DatabaseConnection, DbCellValue, DbQueryResult } from '../../domain/models';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import { FixedSizeVirtualList } from '../ui/FixedSizeVirtualList';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { ScriptCodeEditor, type ScriptCodeEditorHandle } from '../scripts/ScriptCodeEditor';
import { buildSqlCompletionEntries } from '../../domain/database/sqlCompletion';
import { applyWidths, widthScopeKey } from '../../domain/database/columnWidths';
import { useDatabaseColumnWidthStore } from '../../application/state/useDatabaseColumnWidths';
import { useSqlHistory } from '../../application/state/useSqlHistory';
import type { DatabaseTunnelDeps, DbTableRef } from '../../application/state/useDatabaseWorkbench';
import {
  resultToCsv,
  resultToInsertSql,
  resultToJson,
  suggestExportFileName,
} from '../../domain/database/sqlResultExport';
import { classifySqlSafety } from '../../domain/database/sqlSafety';
import { filterTables } from '../../domain/database/tableFilter';
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

interface DatabaseWorkbenchSurfaceProps {
  /** Workbench tab id (without the `database:` prefix), or null when idle. */
  tabId: string | null;
  connections: DatabaseConnection[];
  /** Vault lookups used to dial connections that route through an SSH host. */
  tunnelDeps?: DatabaseTunnelDeps;
  onUpdateConnections?: (connections: DatabaseConnection[] | ((prev: DatabaseConnection[]) => DatabaseConnection[])) => void;
}

interface DatabaseTabPaneProps {
  tab: DatabaseTab;
  workbench: ReturnType<typeof useDatabaseWorkbench>;
  connections: readonly DatabaseConnection[];
  onUpdateConnections?: (connections: DatabaseConnection[] | ((prev: DatabaseConnection[]) => DatabaseConnection[])) => void;
  sqlHistory: ReturnType<typeof useSqlHistory>;
  schemaWidth: number;
  onSchemaResizeStart: (event: React.MouseEvent) => void;
  autoFocus?: boolean;
  headerActions?: React.ReactNode;
}

/**
 * One editor pane: toolbar, schema tree, SQL editor, result grid and status bar.
 * Tab state is owned by the surface so split panes can share it.
 */
const DatabaseTabPane: React.FC<DatabaseTabPaneProps> = ({
  tab,
  workbench,
  connections,
  onUpdateConnections,
  sqlHistory,
  schemaWidth,
  onSchemaResizeStart,
  autoFocus,
  headerActions,
}) => {
  const { t } = useI18n();
  const columnWidthStore = useDatabaseColumnWidthStore();
  const editorRef = useRef<ScriptCodeEditorHandle | null>(null);
  const connection = useMemo(
    () => connections.find((entry) => entry.id === tab.connectionId),
    [connections, tab.connectionId],
  );
  const [pendingRun, setPendingRun] = useState<{ sql: string; reasons: string[] } | null>(null);
  const [saveQueryOpen, setSaveQueryOpen] = useState(false);
  const [saveQueryName, setSaveQueryName] = useState('');
  const [page, setPage] = useState(0);

  const executeSql = useCallback(
    (sqlOverride: string | undefined) => {
      sqlHistory.record(tab.connectionId, sqlOverride ?? tab.sql);
      void workbench.runQuery(tab.id, sqlOverride);
    },
    [sqlHistory, tab, workbench],
  );

  const runActiveQuery = useCallback(() => {
    const selection = editorRef.current?.getSelectionText()?.trim();
    const hasSelection = Boolean(selection && selection.length > 0);
    const sql = hasSelection ? selection! : tab.sql;
    const trimmed = sql.trim();
    if (!trimmed) return;
    const safety = classifySqlSafety(trimmed);
    if (connection?.readOnly && safety.risk !== 'read') {
      toast.error(t('databases.workbench.readOnlyBlocked'));
      return;
    }
    if (safety.risk === 'destructive') {
      setPendingRun({ sql: trimmed, reasons: safety.reasons });
      return;
    }
    executeSql(hasSelection ? selection : undefined);
  }, [connection?.readOnly, tab.sql, executeSql, t]);

  const downloadResult = useCallback(
    (format: 'csv' | 'json' | 'sql') => {
      const result = tab.result;
      if (!result) return;
      const dialect = SQL_DIALECTS[tab.kind] ?? 'postgresql';
      const tableMatch = /\bfrom\s+([\w."`]+)/i.exec(tab.sql);
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
      anchor.download = suggestExportFileName(tab.title, format === 'sql' ? 'sql' : format, Date.now());
      anchor.click();
      URL.revokeObjectURL(url);
    },
    [tab],
  );

  const openSqlFile = useCallback(async () => {
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
    workbench.updateSql(tab.id, loaded.text);
    sqlHistory.record(tab.connectionId, loaded.text);
    toast.success(t('databases.workbench.openSqlFileLoaded'));
  }, [tab, sqlHistory, t, workbench]);

  const saveCurrentQuery = useCallback(() => {
    if (!onUpdateConnections) return;
    const name = saveQueryName.trim();
    const sql = editorRef.current?.getSelectionText()?.trim() || tab.sql.trim();
    if (!name || !sql) return;
    const connectionId = tab.connectionId;
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
  }, [tab, onUpdateConnections, saveQueryName, t]);

  const loadSavedQuery = useCallback(
    (sql: string) => {
      workbench.updateSql(tab.id, sql);
    },
    [tab.id, workbench],
  );

  const deleteSavedQuery = useCallback(
    (queryId: string) => {
      if (!onUpdateConnections) return;
      const connectionId = tab.connectionId;
      onUpdateConnections((prev) =>
        prev.map((entry) =>
          entry.id === connectionId
            ? { ...entry, savedQueries: (entry.savedQueries ?? []).filter((q) => q.id !== queryId) }
            : entry,
        ),
      );
    },
    [tab.connectionId, onUpdateConnections],
  );

  const activeHistory = sqlHistory.entriesFor(tab.connectionId);

  const autoWidths = useMemo(() => columnWidths(tab.result), [tab.result]);
  const widthScope = useMemo(
    () =>
      tab.result
        ? widthScopeKey(tab.connectionId, tab.editMeta?.target.table, tab.result.columns.map((column) => column.name))
        : '',
    [tab.connectionId, tab.editMeta, tab.result],
  );
  const savedWidths = columnWidthStore.widthsFor(widthScope);
  const widths = useMemo(
    () => applyWidths(autoWidths, tab.result?.columns ?? [], savedWidths),
    [autoWidths, savedWidths, tab.result],
  );

  const sqlCompletionSource = useCallback(
    () =>
      buildSqlCompletionEntries({
        tables: tab.tables,
        columns: tab.structure?.columns ?? [],
        resultColumns: tab.result?.columns ?? [],
      }),
    [tab],
  );

  const pageSize = tab.maxRows || 1000;
  const allRows = useMemo(() => tab.result?.rows ?? [], [tab.result]);
  const totalPages = Math.max(1, Math.ceil(allRows.length / pageSize));
  const pageIndex = Math.min(Math.max(0, page), totalPages - 1);
  const pagedResult = useMemo(() => {
    if (!tab.result) return null;
    return {
      ...tab.result,
      rows: allRows.slice(pageIndex * pageSize, (pageIndex + 1) * pageSize),
      rowCount: allRows.length,
    };
  }, [tab.result, allRows, pageIndex, pageSize]);

  useEffect(() => {
    setPage(0);
  }, [tab.id, tab.result]);

  const formatSql = () => {
    const dialect = SQL_DIALECTS[tab.kind] ?? 'postgresql';
    try {
      const formatted = formatSqlText(tab.sql, { language: dialect as never });
      if (formatted && formatted !== tab.sql) workbench.updateSql(tab.id, formatted);
    } catch {
      // Formatting is best-effort; leave the statement untouched on parse errors.
    }
  };

  return (
    <>
          <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-1.5 text-xs">
      <StatusDot tab={tab} />
      <span className="truncate font-medium">{tab.title}</span>
      {tab.transactionOpen ? (
        <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
          {t('databases.workbench.beginTransaction')}
        </span>
      ) : null}
      <span className="ml-auto truncate font-mono text-[11px] text-muted-foreground">
        {tab.serverVersion ?? ''}
      </span>
    </div>
    <div className="flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-1.5">
      <Button
        size="sm"
        className="h-7 text-xs"
        disabled={tab.running || !tab.connected || !tab.sql.trim()}
        onClick={runActiveQuery}
      >
        {tab.running ? (
          <Loader2 className="mr-1 h-3 w-3 animate-spin" />
        ) : (
          <Play className="mr-1 h-3 w-3" />
        )}
        {tab.running ? t('databases.workbench.running') : t('databases.workbench.run')}
      </Button>
      {tab.running ? (
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs"
          onClick={() => workbench.cancelQuery(tab.id)}
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
          {(connection?.savedQueries ?? []).length === 0 ? (
            <p className="px-2 py-3 text-xs text-muted-foreground">
              {t('databases.workbench.savedQueriesEmpty')}
            </p>
          ) : (
            <div className="max-h-64 overflow-auto">
              {(connection?.savedQueries ?? []).map((query) => (
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
            disabled={!tab || !onUpdateConnections}
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
      {tab.transactionOpen ? (
        <>
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            disabled={tab.running}
            onClick={() => void workbench.commitTransaction(tab.id)}
          >
            {t('databases.workbench.commit')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-xs"
            disabled={tab.running}
            onClick={() => void workbench.rollbackTransaction(tab.id)}
          >
            {t('databases.workbench.rollback')}
          </Button>
        </>
      ) : (
        <Button
          size="sm"
          variant="ghost"
          className="h-7 text-xs"
          disabled={tab.running || !tab.connected}
          onClick={() => void workbench.beginTransaction(tab.id)}
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
                  workbench.updateSql(tab.id, entry.sql);
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
            disabled={!tab.result}
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
      {tab.status === 'error' ? (
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs"
          onClick={() => void workbench.reconnect(tab.id)}
        >
          <RotateCw className="mr-1 h-3 w-3" />
          {t('databases.workbench.reconnect')}
        </Button>
      ) : null}
      {headerActions ? <div className="ml-auto flex items-center gap-1">{headerActions}</div> : null}
    </div>

    <div className="flex min-h-0 min-w-0 flex-1">
      <SchemaPanel
        tab={tab}
        width={schemaWidth}
        onRefresh={() => void workbench.refreshTables(tab.id)}
        onPreview={(table) => void workbench.previewTable(tab.id, table)}
        onShowStructure={(table) => void workbench.showStructure(tab.id, table)}
        t={t}
      />
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t('databases.schema.resize')}
        className="w-1 shrink-0 cursor-col-resize bg-transparent hover:bg-border"
        onMouseDown={onSchemaResizeStart}
      />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
    <div className="flex min-h-0 min-w-0 basis-[38%] flex-col border-b border-border/60">
      <ScriptCodeEditor
        value={tab.sql}
        onChange={(value) => workbench.updateSql(tab.id, value)}
        language="sql"
        fill
        active
        autoFocus={autoFocus}
        ariaLabel={t('databases.workbench.editorLabel')}
        placeholder={t('databases.workbench.placeholder')}
        ref={editorRef}
        onSubmitShortcut={runActiveQuery}
        sqlCompletion={sqlCompletionSource}
      />
    </div>

    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {tab.error ? (
        <div className="shrink-0 border-b border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          <div className="flex items-start gap-1.5">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <div className="min-w-0 space-y-0.5">
              <p className="whitespace-pre-wrap break-words font-medium">{tab.error}</p>
              {tab.errorDetail?.detail ? (
                <p className="opacity-80">{tab.errorDetail.detail}</p>
              ) : null}
              {tab.errorDetail?.hint ? (
                <p className="opacity-80">{tab.errorDetail.hint}</p>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {tab.structure ? (
        <StructurePanel
          structure={tab.structure}
          onClose={() => workbench.clearStructure(tab.id)}
          onPreview={() => {
            const table = tab.structure?.table;
            if (table) void workbench.previewTable(tab.id, table);
          }}
          t={t}
        />
      ) : pagedResult ? (
        <ResultGrid
          result={pagedResult}
          columnWidths={widths}
          onResizeColumn={(index, width) => {
            const column = tab.result?.columns[index];
            if (!column || !widthScope) return;
            columnWidthStore.setWidth(widthScope, column.name, width);
          }}
          t={t}
          editable={Boolean(tab.editMeta) && !connection?.readOnly}
          rowOffset={pageIndex * pageSize}
          onUpdateCell={(rowIndex, column, value) =>
            workbench.updateCell(tab.id, rowIndex, column, value)
          }
          onDeleteRow={(rowIndex) => workbench.deleteRow(tab.id, rowIndex)}
        />
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
          <ArrowUpDown className="h-5 w-5 text-muted-foreground/60" />
          <p className="max-w-md text-xs text-muted-foreground">
            {tab.status === 'connecting'
              ? t('databases.workbench.connecting')
              : t('databases.workbench.emptyHint')}
          </p>
        </div>
      )}

      <div className="flex shrink-0 items-center gap-4 border-t border-border/60 px-3 py-1 text-[11px] text-muted-foreground">
        {tab.result && tab.result.columns.length > 0 && tab.result.rows.length > 0 && tab.editMeta ? (
          <span className="truncate">{t('databases.workbench.editHint')}</span>
        ) : null}
        <label className="flex items-center gap-1">
          <span>{t('databases.workbench.rowLimit')}</span>
          <RowLimitControl
            value={tab.maxRows}
            label={t('databases.workbench.rowLimit')}
            onChange={(value) => workbench.setMaxRows(tab.id, value)}
          />
        </label>
        <span>
          {t('databases.workbench.rowCount', {
            count: String(tab.result?.rowCount ?? 0),
          })}
        </span>
        {allRows.length > 0 ? (
          <div className="flex items-center gap-1">
            <Button
              size="sm"
              variant="ghost"
              className="h-6 w-6 p-0"
              disabled={pageIndex <= 0}
              aria-label={t('databases.workbench.previousPage')}
              onClick={() => setPage(pageIndex - 1)}
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </Button>
            <span className="whitespace-nowrap">
              {t('databases.workbench.pageOf', {
                page: String(pageIndex + 1),
                pages: String(totalPages),
              })}
            </span>
            <Input
              className="h-6 w-12 px-1 text-center text-[11px]"
              inputMode="numeric"
              value={String(pageIndex + 1)}
              aria-label={t('databases.workbench.pageNumber')}
              onChange={(event) => {
                const next = Number(event.target.value.replace(/[^0-9]/g, ''));
                if (Number.isFinite(next) && next >= 1) setPage(next - 1);
              }}
            />
            <Button
              size="sm"
              variant="ghost"
              className="h-6 w-6 p-0"
              disabled={pageIndex >= totalPages - 1}
              aria-label={t('databases.workbench.nextPage')}
              onClick={() => setPage(pageIndex + 1)}
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        ) : null}
        {tab.result?.truncated ? (
          <span className="text-amber-600 dark:text-amber-400">
            {t('databases.workbench.truncated')}
          </span>
        ) : null}
        {tab.result?.command ? <span className="font-mono">{tab.result.command}</span> : null}
        {typeof tab.durationMs === 'number' ? (
          <span className="ml-auto tabular-nums">
            {t('databases.workbench.elapsed', { ms: String(tab.durationMs) })}
          </span>
        ) : null}
      </div>
    </div>
      </div>
    </div>
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
          executeSql(pendingRun.sql);
          setPendingRun(null);
        }}
      />
    </>
  );
};

export const DatabaseWorkbenchSurface: React.FC<DatabaseWorkbenchSurfaceProps> = ({
  tabId,
  connections,
  onUpdateConnections,
  tunnelDeps,
}) => {
  const { t } = useI18n();
  const workbench = useDatabaseWorkbench(connections, tunnelDeps);
  const { tabs, activeTab } = workbench;
  const sqlHistory = useSqlHistory();

  useEffect(() => {
    if (!tabId) return;
    workbench.setActiveTabId(tabId);
    databaseTabStore.markActive(tabId);
  }, [tabId, workbench]);

  const [schemaWidth, setSchemaWidth] = useState(190);
  const beginSchemaResize = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = schemaWidth;
      const onMove = (move: MouseEvent) => {
        setSchemaWidth(Math.min(560, Math.max(140, startWidth + (move.clientX - startX))));
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    },
    [schemaWidth],
  );

  const [secondaryTabId, setSecondaryTabId] = useState<string | null>(null);
  const [splitDirection, setSplitDirection] = useState<'horizontal' | 'vertical'>('horizontal');
  const [splitRatio, setSplitRatio] = useState(0.5);
  const splitContainerRef = useRef<HTMLDivElement | null>(null);

  const secondaryTab = secondaryTabId ? tabs.find((tab) => tab.id === secondaryTabId) : undefined;

  useEffect(() => {
    if (secondaryTabId && !tabs.some((tab) => tab.id === secondaryTabId)) setSecondaryTabId(null);
  }, [tabs, secondaryTabId]);

  const openSecondaryPane = useCallback(
    async (direction: 'horizontal' | 'vertical') => {
      const active = workbench.activeTab;
      if (!active) return;
      setSplitDirection(direction);
      const other = tabs.find((tab) => tab.id !== active.id);
      if (other) {
        setSecondaryTabId(other.id);
        return;
      }
      const connection = connections.find((entry) => entry.id === active.connectionId);
      if (!connection) return;
      const newTabId = await workbench.openTab(connection, { forceNew: true });
      workbench.setActiveTabId(active.id);
      setSecondaryTabId(newTabId || null);
    },
    [connections, tabs, workbench],
  );

  const beginSplitResize = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      const rect = splitContainerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const onMove = (move: MouseEvent) => {
        const next =
          splitDirection === 'vertical'
            ? (move.clientY - rect.top) / Math.max(1, rect.height)
            : (move.clientX - rect.left) / Math.max(1, rect.width);
        setSplitRatio(Math.min(0.8, Math.max(0.2, next)));
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    },
    [splitDirection],
  );

  if (!activeTab) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        {t('databases.workbench.noTab')}
      </div>
    );
  }

  const splitControls = (
    <div className="flex items-center gap-0.5">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 w-6 p-0"
            aria-label={t('databases.workbench.splitRight')}
            onClick={() => void openSecondaryPane('horizontal')}
          >
            <Columns2 className="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t('databases.workbench.splitRight')}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 w-6 p-0"
            aria-label={t('databases.workbench.splitDown')}
            onClick={() => void openSecondaryPane('vertical')}
          >
            <Rows2 className="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t('databases.workbench.splitDown')}</TooltipContent>
      </Tooltip>
      {secondaryTab ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 w-6 p-0"
              aria-label={t('databases.workbench.closeSplit')}
              onClick={() => setSecondaryTabId(null)}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t('databases.workbench.closeSplit')}</TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  );

  const secondaryControls = (
    <div className="flex items-center gap-1">
      <Popover>
        <PopoverTrigger asChild>
          <Button size="sm" variant="ghost" className="h-6 max-w-[220px] gap-1 px-1.5 text-[11px]">
            <Table2 className="h-3 w-3 shrink-0" />
            <span className="truncate">{secondaryTab?.title ?? ''}</span>
            <ChevronDown className="h-3 w-3 shrink-0" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-64 p-1">
          <div className="max-h-64 overflow-y-auto">
            {tabs
              .filter((tab) => tab.id !== activeTab.id)
              .map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  className={cn(
                    'flex w-full items-center rounded px-2 py-1.5 text-left text-xs hover:bg-secondary',
                    tab.id === secondaryTab?.id ? 'bg-secondary/60' : '',
                  )}
                  onClick={() => setSecondaryTabId(tab.id)}
                >
                  <span className="truncate">{tab.title}</span>
                </button>
              ))}
          </div>
        </PopoverContent>
      </Popover>
      <Button
        size="sm"
        variant="ghost"
        className="h-6 w-6 p-0"
        aria-label={t('databases.workbench.closeSplit')}
        onClick={() => setSecondaryTabId(null)}
      >
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>
  );

  return (
    <div
      ref={splitContainerRef}
      className={cn(
        'relative flex h-full min-h-0 w-full min-w-0 overflow-hidden bg-background',
        secondaryTab && splitDirection === 'vertical' ? 'flex-col' : 'flex-row',
      )}
    >
      <div
        className="flex min-h-0 min-w-0 flex-col overflow-hidden"
        style={secondaryTab ? { flexBasis: `${splitRatio * 100}%`, flexGrow: 0, flexShrink: 0 } : { flex: '1 1 0%' }}
      >
        <DatabaseTabPane
          tab={activeTab}
          workbench={workbench}
          connections={connections}
          onUpdateConnections={onUpdateConnections}
          sqlHistory={sqlHistory}
          schemaWidth={schemaWidth}
          onSchemaResizeStart={beginSchemaResize}
          autoFocus
          headerActions={splitControls}
        />
      </div>
      {secondaryTab ? (
        <>
          <div
            role="separator"
            aria-orientation={splitDirection === 'vertical' ? 'horizontal' : 'vertical'}
            aria-label={t('databases.schema.resize')}
            className={cn(
              'shrink-0 bg-border/60 hover:bg-primary/40',
              splitDirection === 'vertical' ? 'h-1 cursor-row-resize' : 'w-1 cursor-col-resize',
            )}
            onMouseDown={beginSplitResize}
          />
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            <DatabaseTabPane
              key={secondaryTab.id}
              tab={secondaryTab}
              workbench={workbench}
              connections={connections}
              onUpdateConnections={onUpdateConnections}
              sqlHistory={sqlHistory}
              schemaWidth={schemaWidth}
              onSchemaResizeStart={beginSchemaResize}
              headerActions={secondaryControls}
            />
          </div>
        </>
      ) : null}
    </div>
  );
};


const ROW_LIMIT_PRESETS = [100, 500, 1000, 2000, 5000];

/**
 * Editable row limit: the number is a text field (type any value), the chevron
 * opens the usual presets.
 */
const RowLimitControl: React.FC<{
  value: number;
  label: string;
  onChange: (value: number) => void;
}> = ({ value, label, onChange }) => {
  const [draft, setDraft] = useState(String(value));

  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  const commit = (raw: string) => {
    const parsed = Number(raw.trim());
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setDraft(String(value));
      return;
    }
    onChange(parsed);
  };

  return (
    <div className="flex items-center overflow-hidden rounded border border-border/60">
      <input
        className="h-5 w-14 bg-transparent px-1 text-right text-[11px] tabular-nums outline-none focus:bg-muted/40"
        inputMode="numeric"
        value={draft}
        aria-label={label}
        onChange={(event) => setDraft(event.target.value.replace(/[^0-9]/g, ''))}
        onBlur={() => commit(draft)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            commit(draft);
            event.currentTarget.blur();
          } else if (event.key === 'Escape') {
            setDraft(String(value));
            event.currentTarget.blur();
          }
        }}
      />
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="flex h-5 w-4 items-center justify-center border-l border-border/60 text-muted-foreground hover:bg-muted/60"
            aria-label={label}
          >
            <ChevronDown className="h-3 w-3" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-24 p-1">
          <div className="flex flex-col">
            {ROW_LIMIT_PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                className={cn(
                  'rounded px-2 py-1 text-left text-[11px] tabular-nums hover:bg-muted',
                  preset === value ? 'bg-primary/10 font-medium' : '',
                )}
                onClick={() => onChange(preset)}
              >
                {preset}
              </button>
            ))}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
};

interface SchemaPanelProps {
  tab: DatabaseTab;
  width: number;
  onRefresh: () => void;
  onPreview: (table: DbTableRef) => void;
  onShowStructure: (table: DbTableRef) => void;
  t: ReturnType<typeof useI18n>['t'];
}

const SchemaPanel: React.FC<SchemaPanelProps> = ({ tab, width, onRefresh, onPreview, onShowStructure, t }) => {
  const [tableQuery, setTableQuery] = useState('');
  const visibleTables = useMemo(() => filterTables(tab.tables ?? [], tableQuery), [tab.tables, tableQuery]);
  const grouped = useMemo(() => {
    const map = new Map<string, DbTableRef[]>();
    for (const table of visibleTables) {
      const list = map.get(table.schema) ?? [];
      list.push(table);
      map.set(table.schema, list);
    }
    return [...map.entries()];
  }, [visibleTables]);

  return (
    <div className="flex shrink-0 flex-col border-r border-border/60" style={{ width }}>
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
      <div className="shrink-0 px-1 pt-1">
        <Input
          className="h-6 text-[11px]"
          placeholder={t('databases.schema.searchPlaceholder')}
          value={tableQuery}
          aria-label={t('databases.schema.searchPlaceholder')}
          onChange={(event) => setTableQuery(event.target.value)}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1">
        {tab.tablesError ? (
          <p className="px-1 py-2 text-[11px] text-destructive">{tab.tablesError}</p>
        ) : grouped.length === 0 ? (
          <p className="px-1 py-2 text-[11px] text-muted-foreground">
            {tab.tablesLoading
              ? t('databases.schema.loading')
              : tableQuery.trim()
                ? t('databases.schema.noMatches')
                : t('databases.schema.empty')}
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
                <div
                  key={`${table.schema}.${table.name}`}
                  className="group flex w-full items-center gap-1 rounded px-1 py-0.5 text-[11px] hover:bg-secondary"
                >
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-1 text-left"
                    title={`${table.schema}.${table.name}`}
                    onClick={() => onShowStructure(table)}
                  >
                    {table.type === 'view' ? (
                      <Eye className="h-3 w-3 shrink-0 text-muted-foreground" />
                    ) : (
                      <Table2 className="h-3 w-3 shrink-0 text-muted-foreground" />
                    )}
                    <span className="truncate">{table.name}</span>
                  </button>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        className="rounded p-0.5 opacity-0 transition-opacity hover:bg-background group-hover:opacity-100"
                        aria-label={t('databases.schema.preview')}
                        onClick={() => onPreview(table)}
                      >
                        <Play className="h-3 w-3 text-muted-foreground" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>{t('databases.schema.preview')}</TooltipContent>
                  </Tooltip>
                </div>
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  );
};

interface StructurePanelProps {
  structure: NonNullable<DatabaseTab['structure']>;
  onClose: () => void;
  onPreview: () => void;
  t: ReturnType<typeof useI18n>['t'];
}

const StructurePanel: React.FC<StructurePanelProps> = ({ structure, onClose, onPreview, t }) => {
  const { table, columns, loading, error } = structure;
  const [columnQuery, setColumnQuery] = useState('');
  const visibleColumns = useMemo(
    () => filterTables(columns, columnQuery),
    [columns, columnQuery],
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border/60 bg-secondary/40 px-3 py-1.5">
        <Table2 className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="truncate text-xs font-medium">{`${table.schema}.${table.name}`}</span>
        <span className="text-[11px] text-muted-foreground">
          {t('databases.structure.title')}
        </span>
        <Input
          className="ml-2 h-6 w-40 text-[11px]"
          placeholder={t('databases.structure.searchPlaceholder')}
          value={columnQuery}
          aria-label={t('databases.structure.searchPlaceholder')}
          onChange={(event) => setColumnQuery(event.target.value)}
        />
        <div className="ml-auto flex items-center gap-1">
          <Button size="sm" variant="ghost" className="h-6 text-[11px]" onClick={onPreview}>
            <Play className="mr-1 h-3 w-3" />
            {t('databases.schema.preview')}
          </Button>
          <Button size="sm" variant="ghost" className="h-6 w-6 p-0" aria-label={t('common.close')} onClick={onClose}>
            <X className="h-3 w-3" />
          </Button>
        </div>
      </div>
      {error ? (
        <p className="px-3 py-2 text-xs text-destructive">{error}</p>
      ) : loading ? (
        <p className="px-3 py-2 text-xs text-muted-foreground">{t('databases.structure.loading')}</p>
      ) : visibleColumns.length === 0 ? (
        <p className="px-3 py-2 text-xs text-muted-foreground">{t('databases.structure.empty')}</p>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="sticky top-0 z-10 grid grid-cols-[minmax(160px,2fr)_minmax(120px,1.5fr)_80px] border-b border-border/60 bg-secondary/60 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            <span>{t('databases.structure.column')}</span>
            <span>{t('databases.structure.type')}</span>
            <span>{t('databases.structure.nullable')}</span>
          </div>
          {visibleColumns.map((column) => (
            <div
              key={column.name}
              className="grid grid-cols-[minmax(160px,2fr)_minmax(120px,1.5fr)_80px] items-center border-b border-border/30 px-3 py-1 text-xs"
            >
              <span className="truncate font-mono">{column.name}</span>
              <span className="truncate text-muted-foreground">{column.type ?? ''}</span>
              <span className="text-muted-foreground">{column.nullable === false ? 'NOT NULL' : 'NULL'}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

interface ResultGridProps {
  result: DbQueryResult;
  /** Resolved pixel width per rendered column (after manual overrides). */
  columnWidths: number[];
  t: ReturnType<typeof useI18n>['t'];
  /** In-place editing is only offered when the row has a usable primary key. */
  editable?: boolean;
  /** Index of the first visible row inside the full result set. */
  rowOffset?: number;
  onUpdateCell?: (rowIndex: number, column: string, value: string | null) => Promise<boolean>;
  onDeleteRow?: (rowIndex: number) => Promise<boolean>;
  /** Fired while dragging a header divider; width is already in pixels. */
  onResizeColumn?: (index: number, width: number) => void;
  onResizeCommit?: () => void;
}

const ACTION_COLUMN_WIDTH = 32;

const ResultGrid: React.FC<ResultGridProps> = ({
  result,
  columnWidths,
  t,
  editable = false,
  rowOffset = 0,
  onUpdateCell,
  onDeleteRow,
  onResizeColumn,
  onResizeCommit,
}) => {
  const [editing, setEditing] = useState<{ row: number; cell: number; draft: string } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ row: number } | null>(null);
  const [saving, setSaving] = useState(false);

  if (result.columns.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
        {result.command
          ? t('databases.workbench.statementOk', { command: result.command })
          : t('databases.workbench.noColumns')}
      </div>
    );
  }

  const template = [editable ? `${ACTION_COLUMN_WIDTH}px` : null, ...columnWidths.map((entry) => `${Math.round(entry)}px`)]
    .filter(Boolean)
    .join(' ');
  const width = columnWidths.reduce((total, entry) => total + Math.round(entry), 0) + (editable ? ACTION_COLUMN_WIDTH : 0);

  const commitEdit = async () => {
    if (!editing || !onUpdateCell) {
      setEditing(null);
      return;
    }
    const column = result.columns[editing.cell];
    const original = result.rows[editing.row]?.[editing.cell];
    const draft = editing.draft;
    const next = draft === '' && (original === null || original === undefined) ? null : draft;
    if (String(original ?? '') === String(next ?? '')) {
      setEditing(null);
      return;
    }
    setSaving(true);
    const applied = await onUpdateCell(rowOffset + editing.row, column.name, next);
    setSaving(false);
    setEditing(null);
    if (applied) toast.success(t('databases.workbench.rowUpdated'));
    else toast.error(t('databases.workbench.rowUpdateFailed'));
  };

  const commitDelete = async () => {
    if (!pendingDelete || !onDeleteRow) {
      setPendingDelete(null);
      return;
    }
    setSaving(true);
    const applied = await onDeleteRow(rowOffset + pendingDelete.row);
    setSaving(false);
    setPendingDelete(null);
    if (applied) toast.success(t('databases.workbench.rowDeleted'));
    else toast.error(t('databases.workbench.rowDeleteFailed'));
  };

  return (
    <>
      <div className="min-h-0 w-full min-w-0 flex-1 overflow-x-auto [&::-webkit-scrollbar]:h-2.5 [&::-webkit-scrollbar]:w-2.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border [&::-webkit-scrollbar-thumb]:border-2 [&::-webkit-scrollbar-thumb]:border-solid [&::-webkit-scrollbar-thumb]:border-background [&::-webkit-scrollbar-thumb]:bg-clip-padding [&::-webkit-scrollbar-track]:bg-transparent">
        <div
          className="flex min-h-full flex-col"
          style={{ minWidth: '100%', width: width > 0 ? `${width}px` : undefined }}
        >
          <div
            className="sticky top-0 z-10 grid shrink-0 border-b border-border/60 bg-secondary/60"
            style={{ gridTemplateColumns: template }}
          >
            {editable ? <div className="px-1 py-1.5" /> : null}
            {result.columns.map((column, index) => (
              <div
                key={`${column.name}-${index}`}
                className="group/head relative truncate px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
                title={column.type ? `${column.name} · ${column.type}` : column.name}
              >
                {column.name}
                {onResizeColumn ? (
                  <span
                    role="separator"
                    aria-orientation="vertical"
                    className="absolute -right-0.5 top-0 h-full w-1.5 cursor-col-resize select-none bg-transparent hover:bg-primary/40"
                    onPointerDown={(event) => {
                      event.preventDefault();
                      const startX = event.clientX;
                      const startWidth = columnWidths[index] ?? MIN_COLUMN_WIDTH;
                      const target = event.currentTarget;
                      target.setPointerCapture(event.pointerId);
                      const move = (moveEvent: PointerEvent) => {
                        onResizeColumn(index, startWidth + (moveEvent.clientX - startX));
                      };
                      const up = () => {
                        target.removeEventListener('pointermove', move);
                        target.removeEventListener('pointerup', up);
                        target.removeEventListener('pointercancel', up);
                        onResizeCommit?.();
                      };
                      target.addEventListener('pointermove', move);
                      target.addEventListener('pointerup', up);
                      target.addEventListener('pointercancel', up);
                    }}
                  />
                ) : null}
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
                  'group grid h-7 items-center text-xs',
                  rowIndex % 2 === 1 ? 'bg-secondary/20' : 'bg-transparent',
                )}
                style={{ gridTemplateColumns: template }}
              >
                {editable ? (
                  <div className="flex items-center justify-center">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-5 w-5 p-0 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                      aria-label={t('databases.workbench.deleteRow')}
                      disabled={saving}
                      onClick={() => setPendingDelete({ row: rowIndex })}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                ) : null}
                {row.map((value, cellIndex) => {
                  const isEditing = editing?.row === rowIndex && editing?.cell === cellIndex;
                  if (isEditing) {
                    return (
                      <input
                        key={cellIndex}
                        autoFocus
                        className="h-6 w-full rounded border border-primary/60 bg-background px-2 font-mono text-xs outline-none"
                        value={editing!.draft}
                        disabled={saving}
                        onChange={(event) => setEditing({ ...editing!, draft: event.target.value })}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault();
                            void commitEdit();
                          } else if (event.key === 'Escape') {
                            event.preventDefault();
                            setEditing(null);
                          }
                        }}
                        onBlur={() => void commitEdit()}
                      />
                    );
                  }
                  return (
                    <div
                      key={cellIndex}
                      className={cn(
                        'truncate px-3 font-mono',
                        value !== null && 'cursor-pointer hover:bg-secondary/40',
                        value === null && 'italic text-muted-foreground/70',
                        typeof value === 'number' && 'text-right tabular-nums',
                      )}
                      title={cellText(value)}
                      onDoubleClick={() => {
                        if (!editable || !onUpdateCell || saving) return;
                        setEditing({ row: rowIndex, cell: cellIndex, draft: cellText(value) });
                      }}
                      onClick={() => {
                        if (value === null) return;
                        void navigator.clipboard?.writeText(String(value)).then(() => {
                          toast.success(t('databases.workbench.cellCopied'));
                        });
                      }}
                    >
                      {cellText(value)}
                    </div>
                  );
                })}
              </div>
            )}
          />
        </div>
      </div>
      <ConfirmDialog
        open={pendingDelete !== null}
        title={t('databases.workbench.deleteRowTitle')}
        message={t('databases.workbench.deleteRowConfirmMessage')}
        confirmLabel={t('databases.workbench.deleteRow')}
        destructive
        busy={saving}
        onOpenChange={(next) => {
          if (!next) setPendingDelete(null);
        }}
        onConfirm={() => void commitDelete()}
      />
    </>
  );
};
