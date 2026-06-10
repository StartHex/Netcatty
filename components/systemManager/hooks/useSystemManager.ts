import { useCallback, useEffect, useRef, useState } from 'react';
import { sessionCapabilitiesStore } from '../../../application/state/sessionCapabilitiesStore';
import type { SessionCapabilities } from '../../../domain/systemManager/types';
import type { useSystemManagerBackend } from '../../../application/state/useSystemManagerBackend';
import type { TerminalSession } from '../../../types';
import { nextPollData } from '../listStable';

type Backend = ReturnType<typeof useSystemManagerBackend>;

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
    return sessionCapabilitiesStore.subscribe(() => {
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
    if (!sessionId || !isConnected) return undefined;
    void probe();
    return undefined;
  }, [sessionId, isConnected, probe]);

  useEffect(() => {
    if (!enabled || !sessionId || !isConnected) return undefined;
    void probe();
    return undefined;
  }, [enabled, sessionId, isConnected, probe]);

  return { capabilities, probing, refreshCapabilities: probe };
}

/** Prefetch capabilities for connected sessions so the system panel opens faster. */
export function useSystemCapabilitiesWarmup(
  sessions: TerminalSession[],
  backend: Backend,
) {
  const backendRef = useRef(backend);
  backendRef.current = backend;

  useEffect(() => {
    const connected = sessions.filter((session) => session.status === 'connected');
    for (const session of connected) {
      if (sessionCapabilitiesStore.get(session.id)) continue;
      void backendRef.current.probeSystemCapabilities(session.id).then((result) => {
        if (result.success && result.capabilities) {
          sessionCapabilitiesStore.set(session.id, result.capabilities);
        }
      });
    }
  }, [sessions]);
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
  const fetcherRef = useRef(fetcher);
  const mergeRef = useRef(merge);

  fetcherRef.current = fetcher;
  mergeRef.current = merge;

  const run = useCallback(async (options?: { withLoading?: boolean }) => {
    if (!enabled) return;
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
