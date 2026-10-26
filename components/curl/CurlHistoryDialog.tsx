import React, { useMemo, useState } from 'react';
import { Copy, Play } from 'lucide-react';

import { useI18n } from '../../application/i18n/I18nProvider';
import { useClipboardBackend } from '../../application/state/useClipboardBackend';
import type { HttpHistoryEntry } from '../../domain/http/history';
import { formatJsonText, safeParseJson } from '../../domain/http/responseBody';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog';
import { ScrollArea } from '../ui/scroll-area';
import { JsonTreeViewer } from './JsonTreeViewer';
import { copyTextWithFeedback } from './clipboard';

type DetailSection = 'request' | 'response';

const HeaderList: React.FC<{ headers: Array<{ key: string; value: string }> }> = ({ headers }) => {
  if (headers.length === 0) return null;
  return (
    <div className="rounded border border-border/60">
      {headers.map((header, index) => (
        <div
          key={`${header.key}-${index}`}
          className="flex gap-2 border-b border-border/40 px-2 py-1 font-mono text-[11px] last:border-b-0"
        >
          <span className="w-48 shrink-0 truncate text-muted-foreground">{header.key}</span>
          <span className="break-all">{header.value}</span>
        </div>
      ))}
    </div>
  );
};

export const CurlHistoryDialog: React.FC<{
  entry: HttpHistoryEntry | null;
  onOpenChange: (open: boolean) => void;
  onReplay: (entry: HttpHistoryEntry) => void;
}> = ({ entry, onOpenChange, onReplay }) => {
  const { t } = useI18n();
  const { writeClipboardText } = useClipboardBackend();
  const [section, setSection] = useState<DetailSection>('response');

  const request = entry?.request;
  const response = entry?.response;

  const responseBody = useMemo(() => {
    if (!response?.bodyText) return '';
    if (response.bodyKind === 'json') {
      const formatted = formatJsonText(response.bodyText);
      return formatted.ok ? formatted.text : response.bodyText;
    }
    return response.bodyText;
  }, [response]);

  const isJson = Boolean(response?.bodyKind === 'json' && safeParseJson(responseBody) !== undefined);

  const copy = async (text: string) => {
    await copyTextWithFeedback(
      writeClipboardText,
      text,
      t('curl.response.copied'),
      t('curl.copyFailed'),
    );
  };

  return (
    <Dialog open={Boolean(entry)} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[760px] p-0">
        <DialogHeader className="border-b border-border/60 px-4 py-3">
          <DialogTitle className="text-sm">{t('curl.history.detailTitle')}</DialogTitle>
          {entry ? (
            <p className="font-mono text-[11px] text-muted-foreground">
              {entry.method} {entry.url}
            </p>
          ) : null}
        </DialogHeader>

        {entry ? (
          <div className="flex h-[560px] min-h-0 flex-col">
            <div className="flex items-center gap-1 border-b border-border/60 px-3 py-2">
              {(['response', 'request'] as DetailSection[]).map((item) => (
                <button
                  key={item}
                  type="button"
                  onClick={() => setSection(item)}
                  className={
                    section === item
                      ? 'rounded bg-muted px-2 py-1 text-xs text-foreground'
                      : 'rounded px-2 py-1 text-xs text-muted-foreground hover:text-foreground'
                  }
                >
                  {t(`curl.history.${item}`)}
                </button>
              ))}
              <span className="ml-auto text-[11px] text-muted-foreground">
                {new Date(entry.at).toLocaleString()}
              </span>
            </div>

            <ScrollArea className="min-h-0 flex-1">
              <div className="space-y-3 p-3 text-xs">
                {section === 'request' ? (
                  <>
                    <p className="font-mono text-[11px] text-muted-foreground">
                      {request ? `${request.method} ${request.url}` : `${entry.method} ${entry.url}`}
                    </p>
                    <HeaderList headers={request?.headers ?? []} />
                    {request?.bodyText ? (
                      <pre className="whitespace-pre-wrap break-all rounded border border-border/60 p-2 font-mono text-[11px]">
                        {request.bodyText}
                      </pre>
                    ) : null}
                  </>
                ) : (
                  <>
                    {response ? (
                      <>
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="rounded px-2 py-0.5 font-mono font-semibold">
                            {response.status || '—'} {response.statusText}
                          </span>
                          <span className="text-muted-foreground">{response.durationMs} ms</span>
                          <span className="text-muted-foreground">{response.sizeBytes} B</span>
                          {response.truncated ? (
                            <span className="rounded bg-amber-500/15 px-2 py-0.5 text-amber-600 dark:text-amber-400">
                              {t('curl.response.truncated')}
                            </span>
                          ) : null}
                          <Button
                            size="sm"
                            variant="ghost"
                            className="ml-auto h-7 gap-1 px-2 text-[11px]"
                            onClick={() => void copy(responseBody)}
                            disabled={!responseBody}
                          >
                            <Copy size={11} /> {t('curl.history.copyResponse')}
                          </Button>
                        </div>
                        {response.error ? (
                          <div className="rounded border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-destructive">
                            {response.error.code}: {response.error.message}
                          </div>
                        ) : null}
                        <HeaderList headers={response.headers} />
                        {response.bodyOmitted ? (
                          <p className="text-[11px] text-muted-foreground">{t('curl.history.bodyOmitted')}</p>
                        ) : null}
                        {isJson ? (
                          <JsonTreeViewer
                            text={responseBody}
                            labels={{
                              expand: t('curl.json.expand'),
                              collapse: t('curl.json.collapse'),
                              copyValue: t('curl.json.copyValue'),
                            }}
                            onCopyValue={(text) => void copy(text)}
                            className="rounded border border-border/60"
                          />
                        ) : responseBody ? (
                          <pre className="whitespace-pre-wrap break-all rounded border border-border/60 p-2 font-mono text-[11px]">
                            {responseBody}
                          </pre>
                        ) : null}
                      </>
                    ) : (
                      <p className="text-muted-foreground">{t('curl.history.noResponse')}</p>
                    )}
                  </>
                )}
              </div>
            </ScrollArea>

            <div className="flex items-center justify-end gap-2 border-t border-border/60 px-3 py-2">
              <Button size="sm" variant="outline" className="h-8 gap-1 text-xs" onClick={() => onReplay(entry)}>
                <Play size={12} /> {t('curl.history.replay')}
              </Button>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
};
