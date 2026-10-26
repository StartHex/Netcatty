/**
 * Request history for the Curl tool. History is convenience data: it is stored
 * unencrypted in localStorage, so it never keeps auth headers or credentials —
 * only the request line, plain headers, and a size-capped response snapshot.
 */

import { isSensitiveHeaderName, type CurlResponse } from '../models';

export const HTTP_HISTORY_LIMIT = 200;
/** Response bodies above this size are dropped from the snapshot. */
export const HTTP_HISTORY_BODY_LIMIT = 64 * 1024;
export const HTTP_HISTORY_HEADER_LIMIT = 100;
export const HTTP_HISTORY_HEADER_VALUE_LIMIT = 4000;

export interface HttpHistoryHeader {
  key: string;
  value: string;
}

export interface HttpHistoryRequestSnapshot {
  method: string;
  url: string;
  headers: HttpHistoryHeader[];
  bodyKind?: string;
  bodyText?: string;
  bodyOmitted?: boolean;
}

export interface HttpHistoryResponseSnapshot {
  status: number;
  statusText: string;
  durationMs: number;
  sizeBytes: number;
  contentType?: string;
  bodyKind?: string;
  headers: HttpHistoryHeader[];
  bodyText?: string;
  bodyOmitted?: boolean;
  truncated?: boolean;
  error?: { code: string; message: string };
}

export interface HttpHistoryEntry {
  id: string;
  method: string;
  url: string;
  status: number;
  durationMs: number;
  at: number;
  request?: HttpHistoryRequestSnapshot;
  response?: HttpHistoryResponseSnapshot;
}

const sanitizeHeaders = (input: unknown): HttpHistoryHeader[] => {
  if (!Array.isArray(input)) return [];
  const headers: HttpHistoryHeader[] = [];
  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    if (typeof record.key !== 'string' || !record.key) continue;
    headers.push({
      key: record.key,
      value: typeof record.value === 'string' ? record.value.slice(0, HTTP_HISTORY_HEADER_VALUE_LIMIT) : '',
    });
    if (headers.length >= HTTP_HISTORY_HEADER_LIMIT) break;
  }
  return headers;
};

const sanitizeBody = (input: unknown): { bodyText?: string; bodyOmitted?: boolean } => {
  if (typeof input !== 'string' || !input) return {};
  if (input.length > HTTP_HISTORY_BODY_LIMIT) return { bodyOmitted: true };
  return { bodyText: input };
};

const sanitizeRequestSnapshot = (input: unknown): HttpHistoryRequestSnapshot | undefined => {
  if (!input || typeof input !== 'object') return undefined;
  const record = input as Record<string, unknown>;
  if (typeof record.url !== 'string' || !record.url) return undefined;
  return {
    method: typeof record.method === 'string' ? record.method : 'GET',
    url: record.url,
    headers: sanitizeHeaders(record.headers),
    ...(typeof record.bodyKind === 'string' ? { bodyKind: record.bodyKind } : {}),
    ...sanitizeBody(record.bodyText),
  };
};

const sanitizeResponseSnapshot = (input: unknown): HttpHistoryResponseSnapshot | undefined => {
  if (!input || typeof input !== 'object') return undefined;
  const record = input as Record<string, unknown>;
  const errorRecord = record.error && typeof record.error === 'object'
    ? (record.error as Record<string, unknown>)
    : null;
  const error = errorRecord
    ? {
        code: typeof errorRecord.code === 'string' ? errorRecord.code : 'unknown',
        message: typeof errorRecord.message === 'string' ? errorRecord.message : 'Request failed',
      }
    : undefined;
  return {
    status: typeof record.status === 'number' ? record.status : 0,
    statusText: typeof record.statusText === 'string' ? record.statusText : '',
    durationMs: typeof record.durationMs === 'number' ? record.durationMs : 0,
    sizeBytes: typeof record.sizeBytes === 'number' ? record.sizeBytes : 0,
    ...(typeof record.contentType === 'string' ? { contentType: record.contentType } : {}),
    ...(typeof record.bodyKind === 'string' ? { bodyKind: record.bodyKind } : {}),
    headers: sanitizeHeaders(record.headers),
    ...sanitizeBody(record.bodyText),
    ...(record.truncated === true ? { truncated: true } : {}),
    ...(error ? { error } : {}),
  };
};

export function sanitizeHttpHistory(input: unknown): HttpHistoryEntry[] {
  if (!Array.isArray(input)) return [];
  const result: HttpHistoryEntry[] = [];
  for (const entry of input) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.url !== 'string' || !record.url) continue;
    const request = sanitizeRequestSnapshot(record.request);
    const response = sanitizeResponseSnapshot(record.response);
    result.push({
      id: typeof record.id === 'string' && record.id ? record.id : `hist-${result.length}`,
      method: typeof record.method === 'string' ? record.method : 'GET',
      url: record.url,
      status: typeof record.status === 'number' ? record.status : 0,
      durationMs: typeof record.durationMs === 'number' ? record.durationMs : 0,
      at: typeof record.at === 'number' ? record.at : Date.now(),
      ...(request ? { request } : {}),
      ...(response ? { response } : {}),
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

export function historyEntryHasBody(entry: HttpHistoryEntry): boolean {
  return Boolean(entry.response?.bodyText);
}

/** Snapshot helpers: history lives in plain localStorage, so secrets are redacted. */
const redactHeaders = (headers: readonly { key: string; value: string }[]): HttpHistoryHeader[] =>
  headers.map((header) => ({
    key: header.key,
    value: isSensitiveHeaderName(header.key) ? '***' : header.value,
  }));

export function requestSnapshotFrom(
  method: string,
  url: string,
  headers: readonly { key: string; value: string }[],
  bodyKind: string,
  bodyText: string | undefined,
): HttpHistoryRequestSnapshot {
  return {
    method,
    url,
    headers: redactHeaders(headers),
    ...(bodyKind !== 'none' ? { bodyKind } : {}),
    ...(bodyText ? sanitizeBody(bodyText) : {}),
  };
}

export function responseSnapshotFrom(
  response: CurlResponse,
  decodedBody: string | undefined,
): HttpHistoryResponseSnapshot {
  return {
    status: response.status,
    statusText: response.statusText,
    durationMs: response.durationMs,
    sizeBytes: response.sizeBytes,
    ...(response.contentType ? { contentType: response.contentType } : {}),
    ...(response.bodyKind ? { bodyKind: response.bodyKind } : {}),
    headers: redactHeaders(response.headers),
    ...(decodedBody ? sanitizeBody(decodedBody) : {}),
    ...(response.truncated ? { truncated: true } : {}),
  };
}

export function errorSnapshotFrom(error: { code: string; message: string }): HttpHistoryResponseSnapshot {
  return {
    status: 0,
    statusText: '',
    durationMs: 0,
    sizeBytes: 0,
    headers: [],
    error: { code: error.code, message: error.message },
  };
}
