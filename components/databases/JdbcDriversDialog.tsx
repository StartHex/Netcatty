/**
 * Reusable JDBC driver registry: name + driver class + jar list, kept in the
 * vault so connections can reference the driver instead of re-picking jars.
 */

import { Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import React, { useMemo, useState } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import type { JdbcDriver } from '../../domain/models';
import { JDBC_PRESETS, findJdbcPreset } from '../../domain/database/jdbcPresets';
import { sanitizeJdbcDrivers } from '../../domain/database/jdbcDrivers';
import { netcattyBridge } from '@/infrastructure/services/netcattyBridge.ts';
import { Button } from '../ui/button';
import { ConfirmDialog } from '../ui/confirm-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { ScrollArea } from '../ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';

interface JdbcDriversDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  drivers: JdbcDriver[];
  onUpdateDrivers: (drivers: JdbcDriver[]) => void;
}

interface DriverDraft {
  id: string | null;
  name: string;
  presetId: string;
  driverClass: string;
  jarPaths: string[];
}

const emptyDraft = (): DriverDraft => ({
  id: null,
  name: '',
  presetId: '',
  driverClass: '',
  jarPaths: [],
});

function draftFromDriver(driver: JdbcDriver): DriverDraft {
  return {
    id: driver.id,
    name: driver.name,
    presetId: driver.presetId ?? '',
    driverClass: driver.driverClass ?? '',
    jarPaths: driver.jarPaths?.length ? driver.jarPaths : [driver.jarPath].filter(Boolean),
  };
}

export const JdbcDriversDialog: React.FC<JdbcDriversDialogProps> = ({
  open,
  onOpenChange,
  drivers,
  onUpdateDrivers,
}) => {
  const { t } = useI18n();
  const [draft, setDraft] = useState<DriverDraft | null>(null);
  const [deleting, setDeleting] = useState<JdbcDriver | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sorted = useMemo(
    () => sanitizeJdbcDrivers(drivers).sort((a, b) => a.name.localeCompare(b.name)),
    [drivers],
  );

  const addJar = async () => {
    if (!draft) return;
    const selected = await netcattyBridge.get()?.selectFile?.(
      t('databases.drivers.jars'),
      undefined,
      [{ name: 'JAR', extensions: ['jar'] }],
    );
    if (!selected || draft.jarPaths.includes(selected)) return;
    setDraft({ ...draft, jarPaths: [...draft.jarPaths, selected] });
  };

  const save = () => {
    if (!draft) return;
    const name = draft.name.trim();
    if (!name) {
      setError(t('databases.drivers.nameRequired'));
      return;
    }
    if (draft.jarPaths.length === 0) {
      setError(t('databases.drivers.jarsRequired'));
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const entry: JdbcDriver = {
        id: draft.id ?? `jdbc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name,
        driverClass: draft.driverClass.trim() || undefined,
        presetId: draft.presetId || undefined,
        jarPath: draft.jarPaths[0],
        jarPaths: draft.jarPaths,
        createdAt: drivers.find((item) => item.id === draft.id)?.createdAt ?? Date.now(),
      };
      const next = draft.id
        ? drivers.map((item) => (item.id === draft.id ? entry : item))
        : [...drivers, entry];
      onUpdateDrivers(next);
      setDraft(null);
    } finally {
      setBusy(false);
    }
  };

  const remove = (driver: JdbcDriver) => {
    onUpdateDrivers(drivers.filter((item) => item.id !== driver.id));
    if (draft?.id === driver.id) setDraft(null);
    setDeleting(null);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[720px]">
        <DialogHeader>
          <DialogTitle>{t('databases.drivers.title')}</DialogTitle>
          <DialogDescription>{t('databases.drivers.description')}</DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-[240px_1fr] gap-3">
          <div className="rounded-md border border-border/60">
            <div className="flex items-center justify-between border-b border-border/60 px-2 py-1.5">
              <span className="text-xs text-muted-foreground">
                {t('databases.drivers.count', { count: sorted.length })}
              </span>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2"
                onClick={() => {
                  setDraft(emptyDraft());
                  setError(null);
                }}
              >
                <Plus className="mr-1 h-3.5 w-3.5" />
                {t('databases.drivers.add')}
              </Button>
            </div>
            <ScrollArea className="h-[320px]">
              {sorted.length === 0 ? (
                <p className="p-3 text-xs text-muted-foreground">{t('databases.drivers.empty')}</p>
              ) : (
                <ul className="divide-y divide-border/50">
                  {sorted.map((driver) => (
                    <li key={driver.id} className="flex items-center gap-1 px-2 py-2">
                      <button
                        type="button"
                        className="min-w-0 flex-1 text-left"
                        onClick={() => {
                          setDraft(draftFromDriver(driver));
                          setError(null);
                        }}
                      >
                        <p className="truncate text-sm text-foreground">{driver.name}</p>
                        <p className="truncate text-[11px] text-muted-foreground">
                          {driver.driverClass || t('databases.drivers.autoDetect')}
                        </p>
                      </button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7"
                        onClick={() => setDraft(draftFromDriver(driver))}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 text-destructive"
                        onClick={() => setDeleting(driver)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </ScrollArea>
          </div>

          <div className="space-y-3 rounded-md border border-border/60 p-3">
            {!draft ? (
              <p className="text-xs text-muted-foreground">{t('databases.drivers.selectHint')}</p>
            ) : (
              <>
                <div className="grid gap-1.5">
                  <Label htmlFor="driver-name">{t('databases.drivers.name')}</Label>
                  <Input
                    id="driver-name"
                    value={draft.name}
                    onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label>{t('databases.drivers.preset')}</Label>
                  <Select
                    value={draft.presetId || '__custom__'}
                    onValueChange={(value) => {
                      const preset = findJdbcPreset(value);
                      setDraft({
                        ...draft,
                        presetId: preset ? value : '',
                        driverClass: preset ? preset.driverClass : draft.driverClass,
                        name: draft.name || preset?.label || '',
                      });
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__custom__">{t('databases.drivers.presetCustom')}</SelectItem>
                      {JDBC_PRESETS.map((preset) => (
                        <SelectItem key={preset.id} value={preset.id}>
                          {preset.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="driver-class">{t('databases.form.jdbcDriverClass')}</Label>
                  <Input
                    id="driver-class"
                    value={draft.driverClass}
                    placeholder={t('databases.form.jdbcDriverClassPlaceholder')}
                    onChange={(event) => setDraft({ ...draft, driverClass: event.target.value })}
                  />
                </div>
                <div className="grid gap-1.5">
                  <div className="flex items-center justify-between">
                    <Label>{t('databases.drivers.jars')}</Label>
                    <Button size="sm" variant="outline" onClick={() => void addJar()}>
                      <Plus className="mr-1 h-3.5 w-3.5" />
                      {t('databases.drivers.addJar')}
                    </Button>
                  </div>
                  <ul className="space-y-1">
                    {draft.jarPaths.map((jar) => (
                      <li
                        key={jar}
                        className="flex items-center justify-between gap-2 rounded bg-muted/40 px-2 py-1 text-[11px]"
                      >
                        <span className="truncate font-mono">{jar}</span>
                        <button
                          type="button"
                          className="text-muted-foreground hover:text-destructive"
                          onClick={() =>
                            setDraft({ ...draft, jarPaths: draft.jarPaths.filter((item) => item !== jar) })
                          }
                        >
                          x
                        </button>
                      </li>
                    ))}
                    {draft.jarPaths.length === 0 ? (
                      <li className="text-[11px] text-muted-foreground">
                        {t('databases.drivers.jarsHint')}
                      </li>
                    ) : null}
                  </ul>
                </div>
                {error ? <p className="text-xs text-destructive">{error}</p> : null}
                <div className="flex justify-end gap-2">
                  <Button variant="ghost" onClick={() => setDraft(null)}>
                    {t('common.cancel')}
                  </Button>
                  <Button onClick={save} disabled={busy}>
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                    {t('common.save')}
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>

        <ConfirmDialog
          open={Boolean(deleting)}
          title={t('databases.drivers.deleteTitle')}
          message={deleting ? t('databases.drivers.deleteMessage', { name: deleting.name }) : undefined}
          confirmLabel={t('common.delete')}
          destructive
          onOpenChange={(next) => (!next ? setDeleting(null) : undefined)}
          onConfirm={() => deleting && remove(deleting)}
        />
      </DialogContent>
    </Dialog>
  );
};
