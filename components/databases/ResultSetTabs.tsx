import { AlertTriangle } from 'lucide-react';
import React from 'react';

import type { DatabaseResultSet } from '../../application/state/useDatabaseWorkbench';
import { useI18n } from '../../application/i18n/I18nProvider';
import { cn } from '../../lib/utils';

interface ResultSetTabsProps {
  resultSets: readonly DatabaseResultSet[];
  /** Index of the result set currently mirrored into the tab fields. */
  activeIndex: number;
  onSelect: (index: number) => void;
}

/**
 * Result tabs for a multi-statement script. Each statement the sidecar ran gets
 * one tab; selecting it swaps the grid (and any error banner) to that
 * statement's outcome. A statement that failed is flagged so a partially
 * executed script is obvious at a glance.
 */
export const ResultSetTabs: React.FC<ResultSetTabsProps> = ({ resultSets, activeIndex, onSelect }) => {
  const { t } = useI18n();
  return (
    <div
      role="tablist"
      aria-label={t('databases.workbench.resultSets')}
      data-testid="db-result-set-tabs"
      className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border/60 bg-muted/30 px-2 py-1"
    >
      {resultSets.map((resultSet, index) => {
        const isActive = activeIndex === index;
        return (
          <button
            key={`${resultSet.index}-${resultSet.startLine}`}
            type="button"
            role="tab"
            aria-selected={isActive}
            data-testid={`db-result-set-tab-${index}`}
            title={`${t('databases.workbench.resultSetHint', {
              index: String(resultSet.index),
              line: String(resultSet.startLine),
            })}\n${resultSet.sql}`}
            onClick={() => onSelect(index)}
            className={cn(
              'flex shrink-0 items-center gap-1.5 rounded px-2 py-0.5 text-[11px] transition-colors',
              isActive
                ? 'bg-background text-foreground shadow-sm ring-1 ring-border/60'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <span>{t('databases.workbench.resultSet', { index: String(resultSet.index) })}</span>
            {resultSet.error ? (
              <AlertTriangle className="h-3 w-3 text-destructive" data-testid="db-result-set-failed" />
            ) : (
              <span className="tabular-nums opacity-70" data-testid="db-result-set-rows">
                {resultSet.result?.rowCount ?? 0}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
};
