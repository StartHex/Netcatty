import React, { useMemo, useState } from 'react';
import { Plus, Trash2, Waypoints } from 'lucide-react';

import { useI18n } from '../../application/i18n/I18nProvider';
import { curlTabStore } from '../../application/state/curlTabStore';
import { type CurlRequest } from '../../domain/models';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { ScrollArea } from '../ui/scroll-area';
import { VaultHeaderSearch, VaultPageHeader, vaultHeaderSecondaryButtonClass } from '../vault/VaultPageHeader';

const METHOD_CLASS: Record<string, string> = {
  GET: 'text-emerald-500',
  POST: 'text-amber-500',
  PUT: 'text-sky-500',
  PATCH: 'text-fuchsia-500',
  DELETE: 'text-rose-500',
  HEAD: 'text-slate-500',
  OPTIONS: 'text-slate-500',
};

export const CurlCollections: React.FC<{
  requests: readonly CurlRequest[];
  onUpdateRequests: (next: CurlRequest[]) => void | Promise<void>;
}> = ({ requests, onUpdateRequests }) => {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [pendingDelete, setPendingDelete] = useState<CurlRequest | null>(null);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const sorted = [...(requests ?? [])].sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
    if (!needle) return sorted;
    return sorted.filter(
      (request) =>
        request.name.toLowerCase().includes(needle) ||
        request.url.toLowerCase().includes(needle) ||
        request.method.toLowerCase().includes(needle),
    );
  }, [requests, query]);

  const openRequest = (request: CurlRequest) => {
    void onUpdateRequests(
      requests.map((item) => (item.id === request.id ? { ...item, lastUsedAt: Date.now() } : item)),
    );
    curlTabStore.requestOpen(request.id);
  };

  return (
    <div className="flex h-full flex-col">
      <VaultPageHeader>
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <h2 className="truncate text-sm font-semibold">{t('curl.title')}</h2>
          <span className="text-xs text-muted-foreground">{t('curl.count', { count: String((requests ?? []).length) })}</span>
        </div>
        <VaultHeaderSearch
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('curl.searchPlaceholder')}
          className="w-[240px]"
        />
        <Button
          className={cn(vaultHeaderSecondaryButtonClass, 'h-9 gap-1')}
          onClick={() => curlTabStore.requestOpen(undefined)}
        >
          <Plus size={14} /> {t('curl.newRequest')}
        </Button>
      </VaultPageHeader>
      <ScrollArea className="min-h-0 flex-1">
        {filtered.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-secondary">
              <Waypoints className="h-6 w-6 text-muted-foreground" />
            </div>
            <div>
              <p className="text-sm font-medium">{query ? t('curl.emptySearch') : t('curl.empty')}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {query ? t('curl.emptySearchHint') : t('curl.emptyHint')}
              </p>
            </div>
            {query ? null : (
              <Button size="sm" className="gap-1" onClick={() => curlTabStore.requestOpen(undefined)}>
                <Plus size={14} /> {t('curl.newRequest')}
              </Button>
            )}
          </div>
        ) : (
          <div className="space-y-1 px-3 pb-6">
            {filtered.map((request) => (
              <div
                key={request.id}
                className="group flex items-center gap-3 rounded-md border border-transparent px-3 py-2 hover:border-border/60 hover:bg-muted/40"
              >
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-3 text-left"
                  onClick={() => openRequest(request)}
                >
                  <span className={cn('w-16 shrink-0 font-mono text-[11px] font-semibold', METHOD_CLASS[request.method])}>
                    {request.method}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{request.name || request.url}</span>
                    <span className="block truncate font-mono text-[11px] text-muted-foreground">{request.url}</span>
                  </span>
                </button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 opacity-0 group-hover:opacity-100"
                  aria-label={t('curl.delete')}
                  onClick={() => setPendingDelete(request)}
                >
                  <Trash2 size={14} />
                </Button>
              </div>
            ))}
          </div>
        )}
      </ScrollArea>

      <ConfirmDialog
        open={pendingDelete !== null}
        title={t('curl.deleteConfirmTitle')}
        message={t('curl.deleteConfirmMessage', { name: pendingDelete?.name ?? pendingDelete?.url ?? '' })}
        confirmLabel={t('curl.delete')}
        destructive
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        onConfirm={() => {
          if (!pendingDelete) return;
          void onUpdateRequests(requests.filter((item) => item.id !== pendingDelete.id));
          setPendingDelete(null);
        }}
      />
    </div>
  );
};
