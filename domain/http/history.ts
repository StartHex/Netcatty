/**
 * Request history for the Curl tool. History is convenience data: it is stored
 * unencrypted in localStorage and deliberately keeps only method/url/status —
 * never headers, bodies or credentials.
 */

export const HTTP_HISTORY_LIMIT = 200;

export interface HttpHistoryEntry {
  id: string;
  method: string;
  url: string;
  status: number;
  durationMs: number;
  at: number;
}

export function sanitizeHttpHistory(input: unknown): HttpHistoryEntry[] {
  if (!Array.isArray(input)) return [];
  const result: HttpHistoryEntry[] = [];
  for (const entry of input) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.url !== 'string' || !record.url) continue;
    result.push({
      id: typeof record.id === 'string' && record.id ? record.id : `hist-${result.length}`,
      method: typeof record.method === 'string' ? record.method : 'GET',
      url: record.url,
      status: typeof record.status === 'number' ? record.status : 0,
      durationMs: typeof record.durationMs === 'number' ? record.durationMs : 0,
      at: typeof record.at === 'number' ? record.at : Date.now(),
    });
  }
  return result.slice(0, HTTP_HISTORY_LIMIT);
}

/** Newest first; repeating the same method+url moves the entry to the top. */
export function addHttpHistoryEntry(
  entries: readonly HttpHistoryEntry[],
  entry: HttpHistoryEntry,
): HttpHistoryEntry[] {
  const rest = entries.filter((item) => !(item.method === entry.method && item.url === entry.url));
  return [entry, ...rest].slice(0, HTTP_HISTORY_LIMIT);
}
