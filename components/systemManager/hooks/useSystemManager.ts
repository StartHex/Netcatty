import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../../../application/i18n/I18nProvider';
import type { I18nContextValue } from '../../../application/i18n/I18nProvider';
import { sessionCapabilitiesStore } from '../../../application/state/sessionCapabilitiesStore';
import type { SessionCapabilities } from '../../../domain/systemManager/types';
import type { useSystemManagerBackend } from '../../../application/state/useSystemManagerBackend';
import { nextPollData } from '../listStable';

type Backend = ReturnType<typeof useSystemManagerBackend>;

/** Stable i18n ref so polling fetchers do not reset when locale re-renders. */
export function useStableTranslate(): I18nContextValue['t'] {
  const { t } = useI18n();
  const tRef = useRef(t);
  tRef.current = t;
  return useCallback(
    (key, values) => tRef.current(key, values),
    [],
  );
}

export function useSessionCapabilities(
  sessionId: string | null,
  isConnected: boolean,
  backend: Backend,
  enabled: boolean,
) {
  const [capabilities, setCapabilities] = useState<SessionCapabilities | undefined>(
    () => (sessionId ? sessionCapabilitiesStore.get(sessionId) : undefined),
  );
  const [probing, setProbing] = useState(false);

  useEffect(() => {
    if (!sessionId) return undefined;
    return sessionCapabilitiesStore.subscribe(sessionId, () => {
      setCapabilities(sessionCapabilitiesStore.get(sessionId));
    });
  }, [sessionId]);

  const probe = useCallback(async () => {
    if (!sessionId || !isConnected) return;
    setProbing(true);
    try {
      const result = await backend.probeSystemCapabilities(sessionId);
      if (result.success && result.capabilities) {
        sessionCapabilitiesStore.set(sessionId, result.capabilities);
      }
    } finally {
      setProbing(false);
    }
  }, [backend, isConnected, sessionId]);

  useEffect(() => {
    if (!sessionId || !isConnected || !enabled) return undefined;
    if (sessionCapabilitiesStore.get(sessionId)) return undefined;
    void probe();
    return undefined;
  }, [enabled, sessionId, isConnected, probe]);

  return { capabilities, probing, refreshCapabilities: probe };
}

/** Prefetch capabilities only for the given session ids (e.g. when System panel opens). */
export function useSystemCapabilitiesWarmup(
  sessionIds: string[],
  backend: Backend,
  enabled: boolean,
) {
  const backendRef = useRef(backend);
  backendRef.current = backend;
  const inflightRef = useRef(new Set<string>());

  const sessionKey = enabled ? sessionIds.slice().sort().join(',') : '';

  useEffect(() => {
    if (!sessionKey) return undefined;
    for (const sessionId of sessionKey.split(',')) {
      if (!sessionId || sessionCapabilitiesStore.get(sessionId)) continue;
      if (inflightRef.current.has(sessionId)) continue;
      inflightRef.current.add(sessionId);
      void backendRef.current.probeSystemCapabilities(sessionId).then((result) => {
        inflightRef.current.delete(sessionId);
        if (result.success && result.capabilities) {
          sessionCapabilitiesStore.set(sessionId, result.capabilities);
        }
      });
    }
    return undefined;
  }, [sessionKey]);
}

export function usePolling<T>(
  fetcher: () => Promise<T | null>,
  intervalMs: number,
  enabled: boolean,
  merge?: (prev: T | null, next: T) => T,
) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const failuresRef = useRef(0);
  const hasDataRef = useRef(false);
  const inflightRef = useRef(false);
  const fetcherRef = useRef(fetcher);
  const mergeRef = useRef(merge);

  fetcherRef.current = fetcher;
  mergeRef.current = merge;

  const run = useCallback(async (options?: { withLoading?: boolean }) => {
    if (!enabled || inflightRef.current) return;
    inflightRef.current = true;
    const showLoading = options?.withLoading ?? !hasDataRef.current;
    if (showLoading) setLoading(true);
    try {
      const result = await fetcherRef.current();
      if (result !== null) {
        setData((prev) => {
          const mergeFn = mergeRef.current;
          const next = mergeFn ? mergeFn(prev, result) : nextPollData(prev, result);
          if (next !== prev) hasDataRef.current = true;
          return next;
        });
        setError(null);
        failuresRef.current = 0;
      }
    } catch (err) {
      failuresRef.current += 1;
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      inflightRef.current = false;
      if (showLoading) setLoading(false);
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) {
      setData(null);
      setError(null);
      failuresRef.current = 0;
      hasDataRef.current = false;
      return undefined;
    }
    void run({ withLoading: true });
    if (failuresRef.current >= 3) return undefined;
    const id = setInterval(() => {
      if (failuresRef.current >= 3) return;
      void run({ withLoading: false });
    }, intervalMs);
    return () => clearInterval(id);
  }, [enabled, intervalMs, run]);

  const refresh = useCallback(() => run({ withLoading: true }), [run]);

  return { data, error, loading, refresh };
}
