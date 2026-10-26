/**
 * Models for the built-in Curl tool (HTTP request workspace). Requests are
 * plain data so they can live in the encrypted vault and travel through sync.
 */

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;
export type HttpMethod = typeof HTTP_METHODS[number];

export type HttpScheme = 'http' | 'https';

export interface HttpKeyValue {
  id: string;
  key: string;
  value: string;
  enabled: boolean;
}

export type HttpBodyKind = 'none' | 'json' | 'text' | 'form';

export interface HttpBody {
  kind: HttpBodyKind;
  text: string;
}

export type HttpAuthKind = 'none' | 'basic' | 'bearer' | 'apiKey';

export interface HttpAuth {
  kind: HttpAuthKind;
  username?: string;
  password?: string;
  token?: string;
  apiKeyName?: string;
  apiKeyValue?: string;
  apiKeyIn?: 'header' | 'query';
}

export interface HttpRequestOptions {
  followRedirects: boolean;
  maxRedirects: number;
  verifyTls: boolean;
  timeoutMs: number;
}

export interface CurlRequest {
  id: string;
  name: string;
  folder?: string;
  method: HttpMethod;
  /** Authoritative URL text; host/port/path are derived from it. */
  url: string;
  /** View of the URL query (rebuilt from `url`). */
  params: HttpKeyValue[];
  headers: HttpKeyValue[];
  cookies: HttpKeyValue[];
  body: HttpBody;
  auth: HttpAuth;
  options: HttpRequestOptions;
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
}

export interface CurlWireRequest {
  id: string;
  method: HttpMethod;
  url: string;
  headers: Array<{ key: string; value: string }>;
  bodyText?: string;
  timeoutMs: number;
  followRedirects: boolean;
  maxRedirects: number;
  verifyTls: boolean;
}

export type CurlResponseBodyKind = 'text' | 'json' | 'html' | 'xml' | 'binary' | 'empty';

export interface CurlResponse {
  status: number;
  statusText: string;
  httpVersion?: string;
  headers: Array<{ key: string; value: string }>;
  durationMs: number;
  sizeBytes: number;
  truncated: boolean;
  redirects: Array<{ status: number; location: string }>;
  contentType?: string;
  bodyKind: CurlResponseBodyKind;
  bodyText?: string;
  bodyBase64?: string;
}

export interface CurlError {
  code: string;
  message: string;
  detail?: string;
}

export type CurlSendResult =
  | { ok: true; response: CurlResponse }
  | { ok: false; error: CurlError };

export const DEFAULT_HTTP_TIMEOUT_MS = 30000;
export const MAX_HTTP_TIMEOUT_MS = 120000;
export const DEFAULT_MAX_REDIRECTS = 10;
export const MAX_REDIRECTS_LIMIT = 20;

export const SENSITIVE_HEADER_NAMES = [
  'authorization',
  'cookie',
  'set-cookie',
  'proxy-authorization',
  'x-api-key',
  'api-key',
  'x-auth-token',
];

export function isSensitiveHeaderName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  if (!normalized) return false;
  if (SENSITIVE_HEADER_NAMES.includes(normalized)) return true;
  return normalized.includes('token') || normalized.includes('secret') || normalized.includes('api-key');
}

export function createEmptyCurlRequest(id: string, overrides?: Partial<CurlRequest>): CurlRequest {
  const now = Date.now();
  return {
    id,
    name: '',
    method: 'GET',
    url: 'https://',
    params: [],
    headers: [],
    cookies: [],
    body: { kind: 'none', text: '' },
    auth: { kind: 'none' },
    options: {
      followRedirects: true,
      maxRedirects: DEFAULT_MAX_REDIRECTS,
      verifyTls: true,
      timeoutMs: DEFAULT_HTTP_TIMEOUT_MS,
    },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function clampTimeout(value: unknown): number {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_HTTP_TIMEOUT_MS;
  return Math.min(MAX_HTTP_TIMEOUT_MS, Math.max(1000, Math.round(numeric)));
}

function clampRedirects(value: unknown): number {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_MAX_REDIRECTS;
  return Math.min(MAX_REDIRECTS_LIMIT, Math.max(0, Math.round(numeric)));
}

function sanitizeKeyValues(input: unknown): HttpKeyValue[] {
  if (!Array.isArray(input)) return [];
  const result: HttpKeyValue[] = [];
  for (const entry of input) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const key = typeof record.key === 'string' ? record.key : '';
    const value = typeof record.value === 'string' ? record.value : '';
    if (!key && !value) continue;
    result.push({
      id: typeof record.id === 'string' && record.id ? record.id : `kv-${result.length}-${key}`,
      key,
      value,
      enabled: record.enabled !== false,
    });
  }
  return result;
}

function sanitizeBodyKind(value: unknown): HttpBodyKind {
  return value === 'json' || value === 'text' || value === 'form' ? value : 'none';
}

function sanitizeAuthKind(value: unknown): HttpAuthKind {
  return value === 'basic' || value === 'bearer' || value === 'apiKey' ? value : 'none';
}

export function sanitizeCurlRequest(input: unknown): CurlRequest | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const record = input as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id.trim() : '';
  if (!id) return undefined;
  const method = HTTP_METHODS.includes(record.method as HttpMethod) ? (record.method as HttpMethod) : 'GET';
  const options = (record.options && typeof record.options === 'object' ? record.options : {}) as Record<string, unknown>;
  const body = (record.body && typeof record.body === 'object' ? record.body : {}) as Record<string, unknown>;
  const auth = (record.auth && typeof record.auth === 'object' ? record.auth : {}) as Record<string, unknown>;
  const createdAt = typeof record.createdAt === 'number' ? record.createdAt : Date.now();
  const updatedAt = typeof record.updatedAt === 'number' ? record.updatedAt : createdAt;
  const sanitized: CurlRequest = {
    id,
    name: typeof record.name === 'string' ? record.name : '',
    method,
    url: typeof record.url === 'string' ? record.url : 'https://',
    params: sanitizeKeyValues(record.params),
    headers: sanitizeKeyValues(record.headers),
    cookies: sanitizeKeyValues(record.cookies),
    body: { kind: sanitizeBodyKind(body.kind), text: typeof body.text === 'string' ? body.text : '' },
    auth: {
      kind: sanitizeAuthKind(auth.kind),
      username: typeof auth.username === 'string' ? auth.username : undefined,
      password: typeof auth.password === 'string' ? auth.password : undefined,
      token: typeof auth.token === 'string' ? auth.token : undefined,
      apiKeyName: typeof auth.apiKeyName === 'string' ? auth.apiKeyName : undefined,
      apiKeyValue: typeof auth.apiKeyValue === 'string' ? auth.apiKeyValue : undefined,
      apiKeyIn: auth.apiKeyIn === 'query' ? 'query' : auth.apiKeyIn === 'header' ? 'header' : undefined,
    },
    options: {
      followRedirects: options.followRedirects !== false,
      maxRedirects: clampRedirects(options.maxRedirects),
      verifyTls: options.verifyTls !== false,
      timeoutMs: clampTimeout(options.timeoutMs),
    },
    createdAt,
    updatedAt,
  };
  if (typeof record.folder === 'string' && record.folder.trim()) sanitized.folder = record.folder.trim();
  if (typeof record.lastUsedAt === 'number') sanitized.lastUsedAt = record.lastUsedAt;
  return sanitized;
}

export function sanitizeCurlRequests(input: unknown): CurlRequest[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const result: CurlRequest[] = [];
  for (const entry of input) {
    const sanitized = sanitizeCurlRequest(entry);
    if (!sanitized || seen.has(sanitized.id)) continue;
    seen.add(sanitized.id);
    result.push(sanitized);
  }
  return result;
}

export function sortCurlRequests(requests: readonly CurlRequest[]): CurlRequest[] {
  return [...requests].sort((left, right) => {
    const folderCompare = (left.folder ?? '').localeCompare(right.folder ?? '');
    if (folderCompare !== 0) return folderCompare;
    return left.name.localeCompare(right.name);
  });
}

export function curlRequestDisplayTarget(request: CurlRequest): string {
  const withoutScheme = request.url.replace(/^https?:\/\//i, '');
  return withoutScheme.split(/[/?#]/, 1)[0] || request.url;
}

/** Copy safe to upload through cloud sync: encrypted credentials never leave the device. */
export function redactCurlRequestForSync(request: CurlRequest): CurlRequest {
  const headers = request.headers.map((header) =>
    header.value && isSensitiveHeaderName(header.key) ? { ...header, value: '' } : header
  );
  const cookies = request.cookies.map((cookie) => ({ ...cookie, value: '' }));
  return {
    ...request,
    headers,
    cookies,
    auth: {
      ...request.auth,
      password: undefined,
      token: undefined,
      apiKeyValue: undefined,
    },
  };
}
