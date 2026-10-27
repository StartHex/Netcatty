import { useCallback, useMemo, useSyncExternalStore } from 'react';

import { sanitizeCurlFolderPath } from '../../domain/models/http';
import { STORAGE_KEY_CURL_FOLDER_UI } from '../../infrastructure/config/storageKeys';
import { localStorageAdapter } from '../../infrastructure/persistence/localStorageAdapter';

/**
 * Device-local UI state for the curl collection tree (which folders are
 * collapsed). This never enters the vault or the sync payload — it is a
 * per-machine view preference, like the notes/hosts tree expansion state.
 */
interface CurlFolderUiState {
  collapsed: string[];
}

const EMPTY_STATE: CurlFolderUiState = { collapsed: [] };

const listeners = new Set<() => void>();

let snapshot: CurlFolderUiState | null = null;

function normalizeCollapsed(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const paths = new Set<string>();
  for (const entry of input) {
    const path = sanitizeCurlFolderPath(entry);
    if (path) paths.add(path);
  }
  return [...paths].sort((left, right) => left.localeCompare(right));
}

function readState(): CurlFolderUiState {
  try {
    const parsed = localStorageAdapter.read<Partial<CurlFolderUiState>>(STORAGE_KEY_CURL_FOLDER_UI);
    if (!parsed) return EMPTY_STATE;
    return { collapsed: normalizeCollapsed(parsed.collapsed) };
  } catch {
    // No DOM storage (SSR/tests): fall back to the in-memory snapshot.
    return EMPTY_STATE;
  }
}

function getSnapshot(): CurlFolderUiState {
  if (snapshot === null) snapshot = readState();
  return snapshot;
}

function emit(): void {
  for (const listener of Array.from(listeners)) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function writeState(next: CurlFolderUiState): void {
  snapshot = next;
  try {
    localStorageAdapter.write(STORAGE_KEY_CURL_FOLDER_UI, next);
  } catch {
    // Quota/private mode: the in-memory state still works for this session.
  }
  emit();
}

/** Test seam: drop the cached snapshot so the next read hits storage again. */
export function resetCurlFolderUiStoreForTests(): void {
  snapshot = null;
  emit();
}

export function readCollapsedCurlFolders(): string[] {
  return getSnapshot().collapsed;
}

export function isCurlFolderCollapsed(path: string): boolean {
  const sanitized = sanitizeCurlFolderPath(path);
  if (!sanitized) return false;
  return getSnapshot().collapsed.includes(sanitized);
}

export function setCurlFolderCollapsed(path: string, collapsed: boolean): void {
  const sanitized = sanitizeCurlFolderPath(path);
  if (!sanitized) return;
  const current = getSnapshot().collapsed;
  const has = current.includes(sanitized);
  if (collapsed === has) return;
  writeState({
    collapsed: normalizeCollapsed(collapsed
      ? [...current, sanitized]
      : current.filter((entry) => entry !== sanitized)),
  });
}

export function toggleCurlFolderCollapsed(path: string): void {
  setCurlFolderCollapsed(path, !isCurlFolderCollapsed(path));
}

/** Drop collapsed entries that no longer point at an existing folder. */
export function pruneCollapsedCurlFolders(folders: readonly string[]): void {
  const known = new Set(folders);
  const current = getSnapshot().collapsed;
  const next = current.filter((entry) => known.has(entry));
  if (next.length === current.length) return;
  writeState({ collapsed: next });
}

export function useCurlFolderCollapse(): {
  collapsed: ReadonlySet<string>;
  isCollapsed: (path: string) => boolean;
  toggleCollapsed: (path: string) => void;
  setCollapsed: (path: string, collapsed: boolean) => void;
} {
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const collapsed = useMemo(() => new Set(state.collapsed), [state.collapsed]);
  const isCollapsed = useCallback((path: string) => collapsed.has(path), [collapsed]);
  return {
    collapsed,
    isCollapsed,
    toggleCollapsed: toggleCurlFolderCollapsed,
    setCollapsed: setCurlFolderCollapsed,
  };
}
