/**
 * One-shot SQL generation/explanation that reuses the same AI provider
 * configuration as the in-app AI panel (`STORAGE_KEY_AI_PROVIDERS` +
 * active provider/model). Kept separate from the chat runtime because the
 * workbench only needs a single request/response round trip.
 */

import { useCallback, useMemo, useState } from 'react';
import { generateText } from 'ai';

import type { ProviderConfig } from '../../infrastructure/ai/types';
import { createModelFromConfig } from '../../infrastructure/ai/sdk/providers';
import { localStorageAdapter } from '../../infrastructure/persistence/localStorageAdapter';
import {
  STORAGE_KEY_AI_ACTIVE_MODEL,
  STORAGE_KEY_AI_ACTIVE_PROVIDER,
  STORAGE_KEY_AI_PROVIDERS,
} from '../../infrastructure/config/storageKeys';
import { buildSqlAssistantMessages, type SqlAssistantMode } from '../../domain/database/sqlAssistant';

export interface SqlAssistantAnswer {
  ok: boolean;
  text?: string;
  error?: string;
}

export interface SqlAssistantInput {
  mode: SqlAssistantMode;
  question: string;
  sql?: string;
  schema?: string;
  dialect?: string;
}

export interface SqlAssistantApi {
  available: boolean;
  providerLabel: string | undefined;
  running: boolean;
  run: (input: SqlAssistantInput) => Promise<SqlAssistantAnswer>;
}

function resolveActiveProvider(): ProviderConfig | undefined {
  const providers = localStorageAdapter.read<ProviderConfig[]>(STORAGE_KEY_AI_PROVIDERS) ?? [];
  if (!Array.isArray(providers)) return undefined;
  const activeId = localStorageAdapter.readString(STORAGE_KEY_AI_ACTIVE_PROVIDER) ?? '';
  const enabled = providers.filter((provider) => provider && provider.enabled !== false);
  const provider = enabled.find((candidate) => candidate.id === activeId) ?? enabled[0];
  if (!provider) return undefined;
  const activeModel = localStorageAdapter.readString(STORAGE_KEY_AI_ACTIVE_MODEL) ?? '';
  return { ...provider, defaultModel: activeModel || provider.defaultModel };
}

export function useSqlAssistant(): SqlAssistantApi {
  const [running, setRunning] = useState(false);
  const provider = useMemo(() => resolveActiveProvider(), []);

  const run = useCallback(async (input: SqlAssistantInput): Promise<SqlAssistantAnswer> => {
    const active = resolveActiveProvider();
    if (!active) {
      return { ok: false, error: 'no-provider' };
    }
    if (!active.defaultModel) {
      return { ok: false, error: 'no-model' };
    }
    setRunning(true);
    try {
      const { system, prompt } = buildSqlAssistantMessages({
        mode: input.mode,
        question: input.question,
        sql: input.sql,
        schema: input.schema,
        dialect: input.dialect,
      });
      const result = await generateText({
        model: createModelFromConfig(active),
        system,
        prompt,
        temperature: 0.2,
      });
      const text = result.text?.trim();
      if (!text) return { ok: false, error: 'empty-response' };
      return { ok: true, text };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: message };
    } finally {
      setRunning(false);
    }
  }, []);

  return {
    available: Boolean(provider?.defaultModel),
    providerLabel: provider?.name,
    running,
    run,
  };
}
