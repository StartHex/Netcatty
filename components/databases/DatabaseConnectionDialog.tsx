/**
 * Create/edit form for a database connection. Kept as a dialog so the Vault
 * section list stays a plain list; the form owns no persistence.
 */

import { FolderOpen, Loader2, TestTube2 } from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import {
  DATABASE_DEFAULT_PORTS,
  databaseDisplayTarget,
  databaseEffectivePort,
  sanitizeDatabaseConnection,
  type DatabaseConnection,
  type DatabaseKind,
  type DatabaseSslMode,
} from '../../domain/models';
import { netcattyBridge } from '@/infrastructure/services/netcattyBridge.ts';
import type { DbTestConnectionResult } from '../../domain/models';
import { Button } from '../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { Switch } from '../ui/switch';

const KINDS: DatabaseKind[] = ['postgresql', 'mysql', 'mariadb', 'oracle', 'sqlite'];
const SSL_MODES: DatabaseSslMode[] = ['disable', 'require', 'verify-ca', 'verify-full'];

interface FormState {
  label: string;
  kind: DatabaseKind;
  host: string;
  port: string;
  database: string;
  username: string;
  password: string;
  savePassword: boolean;
  sslMode: DatabaseSslMode;
  sqlitePath: string;
  inMemory: boolean;
  sshHostId: string;
}

const EMPTY_FORM: FormState = {
  label: '',
  kind: 'postgresql',
  host: '127.0.0.1',
  port: String(DATABASE_DEFAULT_PORTS.postgresql),
  database: '',
  username: '',
  password: '',
  savePassword: true,
  sslMode: 'disable',
  sqlitePath: '',
  inMemory: false,
  sshHostId: '',
};

function formFromConnection(connection: DatabaseConnection): FormState {
  return {
    label: connection.label,
    kind: connection.kind === 'jdbc' ? 'postgresql' : connection.kind,
    host: connection.host ?? '127.0.0.1',
    port: String(databaseEffectivePort(connection) ?? ''),
    database: connection.database ?? '',
    username: connection.username ?? '',
    password: connection.password ?? '',
    savePassword: connection.savePassword !== false,
    sslMode: connection.sslMode ?? 'disable',
    sqlitePath: connection.sqlitePath ?? '',
    inMemory: connection.inMemory === true,
    sshHostId: connection.sshHostId ?? '',
  };
}

interface TestState {
  status: 'idle' | 'testing' | 'ok' | 'error';
  message?: string;
}

export interface DatabaseConnectionDialogProps {
  open: boolean;
  connection?: DatabaseConnection | null;
  /** SSH hosts that can be used as a jump box for this connection. */
  sshHosts?: { id: string; label: string }[];
  onTestConnection?: (draft: DatabaseConnection) => Promise<DbTestConnectionResult>;
  onClose: () => void;
  onSave: (connection: DatabaseConnection) => void;
}

export const DatabaseConnectionDialog: React.FC<DatabaseConnectionDialogProps> = ({
  open,
  connection,
  sshHosts,
  onTestConnection,
  onClose,
  onSave,
}) => {
  const { t } = useI18n();
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [test, setTest] = useState<TestState>({ status: 'idle' });
  const [showError, setShowError] = useState(false);

  useEffect(() => {
    if (!open) return;
    setForm(connection ? formFromConnection(connection) : EMPTY_FORM);
    setTest({ status: 'idle' });
    setShowError(false);
  }, [open, connection]);

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setTest({ status: 'idle' });
  };

  const changeKind = (kind: DatabaseKind) => {
    setForm((prev) => {
      const previousDefault = String(DATABASE_DEFAULT_PORTS[prev.kind] ?? '');
      const nextDefault = String(DATABASE_DEFAULT_PORTS[kind] ?? '');
      const port =
        prev.port === previousDefault || prev.port === '' ? nextDefault : prev.port;
      return {
        ...prev,
        kind,
        port,
        host: kind === 'sqlite' ? prev.host : prev.host === '' ? '127.0.0.1' : prev.host,
      };
    });
    setTest({ status: 'idle' });
  };

  const isSqlite = form.kind === 'sqlite';

  const draft = useMemo<DatabaseConnection>(() => {
    const base = connection ?? { id: crypto.randomUUID(), createdAt: Date.now() };
    return sanitizeDatabaseConnection({
      ...base,
      label: form.label.trim(),
      kind: form.kind,
      host: isSqlite ? undefined : form.host.trim(),
      port: isSqlite ? undefined : Number(form.port) || undefined,
      database: isSqlite ? undefined : form.database.trim() || undefined,
      username: isSqlite ? undefined : form.username.trim() || undefined,
      password: form.savePassword ? form.password : undefined,
      savePassword: form.savePassword,
      sslMode: isSqlite ? undefined : form.sslMode,
      sqlitePath: isSqlite ? form.sqlitePath.trim() : undefined,
      inMemory: isSqlite ? form.inMemory : undefined,
      sshHostId: isSqlite ? undefined : form.sshHostId || undefined,
    });
  }, [connection, form, isSqlite]);

  const labelError = !draft.label;
  const targetError = isSqlite
    ? !draft.inMemory && !draft.sqlitePath
    : !draft.host || !draft.port || draft.port < 1 || draft.port > 65535;
  const invalid = labelError || targetError;

  const handleSave = () => {
    setShowError(true);
    if (invalid) return;
    onSave(draft);
  };

  const handleTest = async () => {
    if (targetError) {
      setShowError(true);
      return;
    }
    setTest({ status: 'testing' });
    if (!onTestConnection) return;
    const result = await onTestConnection(draft);
    if (result.ok) {
      setTest({
        status: 'ok',
        message: t('databases.testOk', {
          version: result.serverVersion ?? '',
          ms: String(result.durationMs ?? 0),
        }),
      });
    } else {
      setTest({ status: 'error', message: result.error ?? t('databases.testFailed') });
    }
  };

  const browse = async () => {
    const selected = await netcattyBridge.get()?.selectFile?.(
      t('databases.form.sqlitePath'),
      form.sqlitePath || undefined,
      [{ name: 'SQLite', extensions: ['db', 'sqlite', 'sqlite3', 'db3'] }],
    );
    if (selected) update('sqlitePath', selected);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (!next ? onClose() : undefined)}>
      <DialogContent className="max-w-[560px]">
        <DialogHeader>
          <DialogTitle>
            {connection ? t('databases.form.titleEdit') : t('databases.form.titleNew')}
          </DialogTitle>
          <DialogDescription>{t('databases.form.description')}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-1">
          <div className="grid gap-2">
            <Label htmlFor="db-label">{t('databases.form.label')}</Label>
            <Input
              id="db-label"
              value={form.label}
              placeholder={t('databases.form.labelPlaceholder')}
              onChange={(event) => update('label', event.target.value)}
            />
            {showError && labelError ? (
              <p className="text-xs text-destructive">{t('databases.form.required')}</p>
            ) : null}
          </div>

          <div className="grid gap-2">
            <Label>{t('databases.form.kind')}</Label>
            <Select value={form.kind} onValueChange={(value) => changeKind(value as DatabaseKind)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {KINDS.map((kind) => (
                  <SelectItem key={kind} value={kind}>
                    {t(`databases.kind.${kind}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {isSqlite ? (
            <>
              <div className="grid gap-2">
                <Label htmlFor="db-sqlite-path">{t('databases.form.sqlitePath')}</Label>
                <div className="flex gap-2">
                  <Input
                    id="db-sqlite-path"
                    value={form.sqlitePath}
                    disabled={form.inMemory}
                    placeholder={t('databases.form.sqlitePathPlaceholder')}
                    onChange={(event) => update('sqlitePath', event.target.value)}
                  />
                  <Button type="button" variant="outline" disabled={form.inMemory} onClick={() => void browse()}>
                    <FolderOpen className="mr-1.5 h-3.5 w-3.5" />
                    {t('databases.form.browse')}
                  </Button>
                </div>
                {showError && targetError && !form.inMemory ? (
                  <p className="text-xs text-destructive">{t('databases.form.required')}</p>
                ) : null}
              </div>
              <div className="flex items-center justify-between gap-4 rounded-md border border-border/60 px-3 py-2">
                <div>
                  <p className="text-sm font-medium">{t('databases.form.inMemory')}</p>
                  <p className="text-xs text-muted-foreground">{t('databases.form.inMemoryHint')}</p>
                </div>
                <Switch checked={form.inMemory} onCheckedChange={(checked) => update('inMemory', checked)} />
              </div>
            </>
          ) : (
            <>
              <div className="grid grid-cols-[1fr_120px] gap-3">
                <div className="grid gap-2">
                  <Label htmlFor="db-host">{t('databases.form.host')}</Label>
                  <Input
                    id="db-host"
                    value={form.host}
                    placeholder="127.0.0.1"
                    onChange={(event) => update('host', event.target.value)}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="db-port">{t('databases.form.port')}</Label>
                  <Input
                    id="db-port"
                    value={form.port}
                    inputMode="numeric"
                    onChange={(event) => update('port', event.target.value.replace(/[^0-9]/g, ''))}
                  />
                </div>
              </div>
              {showError && targetError ? (
                <p className="text-xs text-destructive">{t('databases.form.invalidTarget')}</p>
              ) : null}

              <div className="grid gap-2">
                <Label htmlFor="db-name">{t('databases.form.database')}</Label>
                <Input
                  id="db-name"
                  value={form.database}
                  placeholder={t('databases.form.databasePlaceholder')}
                  onChange={(event) => update('database', event.target.value)}
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-2">
                  <Label htmlFor="db-user">{t('databases.form.username')}</Label>
                  <Input
                    id="db-user"
                    value={form.username}
                    autoComplete="off"
                    onChange={(event) => update('username', event.target.value)}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="db-password">{t('databases.form.password')}</Label>
                  <Input
                    id="db-password"
                    type="password"
                    value={form.password}
                    autoComplete="new-password"
                    onChange={(event) => update('password', event.target.value)}
                  />
                </div>
              </div>

              <div className="flex items-center justify-between gap-4 rounded-md border border-border/60 px-3 py-2">
                <div>
                  <p className="text-sm font-medium">{t('databases.form.savePassword')}</p>
                  <p className="text-xs text-muted-foreground">{t('databases.form.savePasswordHint')}</p>
                </div>
                <Switch
                  checked={form.savePassword}
                  onCheckedChange={(checked) => update('savePassword', checked)}
                />
              </div>

              <div className="grid gap-2">
                <Label>{t('databases.form.sshHost')}</Label>
                <Select
                  value={form.sshHostId || '__direct__'}
                  onValueChange={(value) => update('sshHostId', value === '__direct__' ? '' : value)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__direct__">{t('databases.form.sshHostDirect')}</SelectItem>
                    {(sshHosts ?? []).map((host) => (
                      <SelectItem key={host.id} value={host.id}>
                        {host.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">{t('databases.form.sshHostHint')}</p>
              </div>

              <div className="grid gap-2">
                <Label>{t('databases.form.sslMode')}</Label>
                <Select value={form.sslMode} onValueChange={(value) => update('sslMode', value as DatabaseSslMode)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SSL_MODES.map((mode) => (
                      <SelectItem key={mode} value={mode}>
                        {t(`databases.sslMode.${mode}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </>
          )}

          <p className="text-xs text-muted-foreground">{databaseDisplayTarget(draft)}</p>

          {test.status !== 'idle' ? (
            <div
              className={`rounded-md border px-3 py-2 text-xs ${
                test.status === 'error'
                  ? 'border-destructive/40 bg-destructive/10 text-destructive'
                  : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
              }`}
            >
              {test.status === 'testing' ? t('databases.testing') : test.message}
            </div>
          ) : null}
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          <Button type="button" variant="outline" onClick={() => void handleTest()} disabled={test.status === 'testing'}>
            {test.status === 'testing' ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <TestTube2 className="mr-1.5 h-3.5 w-3.5" />
            )}
            {t('databases.test')}
          </Button>
          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              {t('databases.cancel')}
            </Button>
            <Button type="button" onClick={handleSave}>
              {t('databases.save')}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
