import { Loader2, Sparkles, ClipboardCopy, CornerDownLeft } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';

import { useI18n } from '../../application/i18n/I18nProvider';
import { useSqlAssistant } from '../../application/state/useSqlAssistant';
import {
  extractSqlFromAnswer,
  looksLikeSqlAnswer,
  type SqlAssistantMode,
} from '../../domain/database/sqlAssistant';
import { Button } from '../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import { Textarea } from '../ui/textarea';

export interface SqlAssistantDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentSql: string;
  schemaText?: string;
  dialect?: string;
  onApply: (sql: string) => void;
}

export const SqlAssistantDialog: React.FC<SqlAssistantDialogProps> = ({
  open,
  onOpenChange,
  currentSql,
  schemaText,
  dialect,
  onApply,
}) => {
  const { t } = useI18n();
  const assistant = useSqlAssistant();
  const [mode, setMode] = useState<SqlAssistantMode>(currentSql.trim() ? 'explain' : 'generate');
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    if (!open) return;
    setMode(currentSql.trim() ? 'explain' : 'generate');
    setAnswer('');
    setError(undefined);
  }, [open, currentSql]);

  const submit = useCallback(async () => {
    setError(undefined);
    const result = await assistant.run({
      mode,
      question,
      sql: currentSql,
      schema: schemaText,
      dialect,
    });
    if (!result.ok) {
      setError(result.error === 'no-provider' || result.error === 'no-model'
        ? t('databases.ai.noProvider')
        : result.error === 'empty-response'
          ? t('databases.ai.emptyResponse')
          : result.error);
      setAnswer('');
      return;
    }
    setAnswer(result.text ?? '');
  }, [assistant, currentSql, dialect, mode, question, schemaText, t]);

  const sqlAnswer = useMemo(() => extractSqlFromAnswer(answer), [answer]);
  const canApply = Boolean(answer) && looksLikeSqlAnswer(answer);

  const copy = useCallback(() => {
    if (!answer) return;
    void navigator.clipboard?.writeText(looksLikeSqlAnswer(answer) ? sqlAnswer : answer);
  }, [answer, sqlAnswer]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4" />
            {t('databases.ai.title')}
          </DialogTitle>
          <DialogDescription>
            {assistant.available
              ? t('databases.ai.description', { provider: assistant.providerLabel ?? '' })
              : t('databases.ai.noProvider')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Select value={mode} onValueChange={(value) => setMode(value as SqlAssistantMode)}>
              <SelectTrigger className="h-8 w-[190px] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="generate">{t('databases.ai.modeGenerate')}</SelectItem>
                <SelectItem value="explain">{t('databases.ai.modeExplain')}</SelectItem>
                <SelectItem value="optimize">{t('databases.ai.modeOptimize')}</SelectItem>
              </SelectContent>
            </Select>
            <span className="truncate text-[11px] text-muted-foreground">
              {schemaText ? t('databases.ai.schemaHint') : t('databases.ai.noSchemaHint')}
            </span>
          </div>

          <Textarea
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder={mode === 'generate'
              ? t('databases.ai.questionGenerate')
              : t('databases.ai.questionExplain')}
            className="min-h-[70px] resize-y text-xs"
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                event.preventDefault();
                void submit();
              }
            }}
          />

          <div className="min-h-[140px] max-h-[320px] overflow-auto rounded-md border border-border/60 bg-muted/30 p-3">
            {answer ? (
              <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed">{answer}</pre>
            ) : (
              <p className="text-[11px] text-muted-foreground">
                {error ?? t('databases.ai.placeholder')}
              </p>
            )}
          </div>
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" onClick={copy} disabled={!answer}>
              <ClipboardCopy className="mr-1 h-3 w-3" />
              {t('databases.ai.copy')}
            </Button>
            {canApply ? (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  onApply(sqlAnswer);
                  onOpenChange(false);
                }}
              >
                <CornerDownLeft className="mr-1 h-3 w-3" />
                {t('databases.ai.apply')}
              </Button>
            ) : null}
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" onClick={() => onOpenChange(false)}>
              {t('databases.cancel')}
            </Button>
            <Button size="sm" onClick={() => void submit()} disabled={assistant.running || !assistant.available}>
              {assistant.running ? (
                <Loader2 className="mr-1 h-3 w-3 animate-spin" />
              ) : (
                <Sparkles className="mr-1 h-3 w-3" />
              )}
              {t('databases.ai.ask')}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
