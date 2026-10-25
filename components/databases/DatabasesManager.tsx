/**
 * Vault section for database connections. Owns the list/search surface and
 * delegates editing to DatabaseConnectionDialog; opening a connection hands the
 * entity to the workbench layer.
 */

import { Copy, Database, Pencil, Play, Plus, Trash2 } from 'lucide-react';
import React, { useMemo, useState } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import {
  databaseDisplayTarget,
  sortDatabaseConnections,
  type DatabaseConnection,
  type DatabaseKind,
} from '../../domain/models';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { VaultHeaderSearch, VaultPageHeader, vaultHeaderSecondaryButtonClass } from '../vault/VaultPageHeader';
import type { DbTestConnectionResult } from '../../domain/models';
import { DatabaseConnectionDialog } from './DatabaseConnectionDialog';

const KIND_ACCENT: Record<DatabaseKind, string> = {
  postgresql: 'text-sky-500',
  mysql: 'text-amber-500',
  mariadb: 'text-orange-500',
  oracle: 'text-red-500',
  sqlite: 'text-emerald-500',
  jdbc: 'text-violet-500',
};

interface DatabasesManagerProps {
  dbConnections: DatabaseConnection[];
  onUpdateDbConnections: (connections: DatabaseConnection[]) => void;
  onOpenConnection: (connection: DatabaseConnection) => void;
  /** SSH hosts offered as jump boxes for new connections. */
  sshHosts?: { id: string; label: string }[];
  /** Runs a test dial, opening the SSH tunnel first when the draft asks for one. */
  onTestConnection?: (draft: DatabaseConnection) => Promise<DbTestConnectionResult>;
}

export const DatabasesManager: React.FC<DatabasesManagerProps> = ({
  dbConnections,
  onUpdateDbConnections,
  onOpenConnection,
  sshHosts,
  onTestConnection,
}) => {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<DatabaseConnection | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<DatabaseConnection | null>(null);


  const connections = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const sorted = sortDatabaseConnections(dbConnections);
    if (!needle) return sorted;
    return sorted.filter((connection) =>
      [connection.label, connection.host, connection.database, connection.sqlitePath]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle)),
    );
  }, [dbConnections, query]);

  const openCreate = () => {
    setEditing(null);
    setDialogOpen(true);
  };

  const openEdit = (connection: DatabaseConnection) => {
    setEditing(connection);
    setDialogOpen(true);
  };

  const save = (connection: DatabaseConnection) => {
    const exists = dbConnections.some((entry) => entry.id === connection.id);
    const next = exists
      ? dbConnections.map((entry) => (entry.id === connection.id ? connection : entry))
      : [...dbConnections, connection];
    onUpdateDbConnections(next);
    setDialogOpen(false);
    setEditing(null);
  };

  const clone = (connection: DatabaseConnection) => {
    const copy = sanitizeDatabaseConnection({
      ...connection,
      id: crypto.randomUUID(),
      label: `${connection.label} (${t('databases.copySuffix')})`,
      createdAt: Date.now(),
      updatedAt: undefined,
      lastUsedAt: undefined,
    });
    onUpdateDbConnections([...dbConnections, copy]);
  };

  const open = (connection: DatabaseConnection) => {
    onUpdateDbConnections(
      dbConnections.map((entry) =>
        entry.id === connection.id ? { ...entry, lastUsedAt: Date.now() } : entry,
      ),
    );
    onOpenConnection(connection);
  };

  const remove = (connection: DatabaseConnection) => {
    onUpdateDbConnections(dbConnections.filter((entry) => entry.id !== connection.id));
    setPendingDelete(null);
  };

  return (
    <div className="flex h-full flex-col">
      <VaultPageHeader>
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <h2 className="truncate text-sm font-semibold">{t('databases.title')}</h2>
          <span className="text-xs text-muted-foreground">
            {t('databases.count', { count: String(dbConnections.length) })}
          </span>
        </div>
        <VaultHeaderSearch
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('databases.search.placeholder')}
          className="w-[240px]"
        />
        <Button className={cn(vaultHeaderSecondaryButtonClass, 'h-9')} onClick={openCreate}>
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          {t('databases.new')}
        </Button>
      </VaultPageHeader>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {connections.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-secondary">
              <Database className="h-6 w-6 text-muted-foreground" />
            </div>
            <div>
              <p className="text-sm font-medium">{t('databases.empty.title')}</p>
              <p className="mt-1 max-w-md text-xs text-muted-foreground">
                {t('databases.empty.description')}
              </p>
            </div>
            <Button onClick={openCreate}>
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              {t('databases.new')}
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {connections.map((connection) => (
              <div
                key={connection.id}
                className="group flex flex-col gap-3 rounded-lg border border-border/60 bg-card p-3 transition-colors hover:border-border"
              >
                <div className="flex items-start gap-2">
                  <Database className={cn('mt-0.5 h-4 w-4 shrink-0', KIND_ACCENT[connection.kind])} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-sm font-medium">{connection.label}</p>
                      <span className="shrink-0 rounded bg-secondary px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                        {t(`databases.kind.${connection.kind}`)}
                      </span>
                    </div>
                    <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
                      {databaseDisplayTarget(connection)}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  <Button size="sm" className="h-7 flex-1 text-xs" onClick={() => open(connection)}>
                    <Play className="mr-1 h-3 w-3" />
                    {t('databases.open')}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 w-7 p-0"
                    title={t('databases.edit')}
                    onClick={() => openEdit(connection)}
                  >
                    <Pencil className="h-3 w-3" />
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 w-7 p-0"
                    title={t('databases.clone')}
                    onClick={() => clone(connection)}
                  >
                    <Copy className="h-3 w-3" />
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 w-7 p-0 text-destructive hover:text-destructive"
                    title={t('databases.delete')}
                    onClick={() => setPendingDelete(connection)}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <DatabaseConnectionDialog
        open={dialogOpen}
        connection={editing}
        onClose={() => {
          setDialogOpen(false);
          setEditing(null);
        }}
        onSave={save}
        sshHosts={sshHosts}
        onTestConnection={onTestConnection}
      />

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        title={t('databases.deleteTitle')}
        message={t('databases.deleteDescription', { label: pendingDelete?.label ?? '' })}
        confirmLabel={t('databases.delete')}
        destructive
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        onConfirm={() => {
          if (pendingDelete) remove(pendingDelete);
        }}
      />
    </div>
  );
};
