/**
 * Turns a stored `CurlRequest` into the flat payload the main process sends.
 * Everything that requires interpretation (auth headers, cookies, content-type,
 * query extras) happens here, in pure code, so the bridge stays dumb.
 */

import type { CurlRequest, CurlWireRequest, HttpMethod } from '../models/http';
import { composeHttpUrl, parseHttpUrl, type HttpUrlParts } from './urlParts';

export type HttpWireWarning = 'body-dropped-for-method' | 'url-credentials-ignored';

export type HttpWireBuildResult =
  | { ok: true; wire: CurlWireRequest; warnings: HttpWireWarning[] }
  | { ok: false; reason: 'invalid-url' };

const METHOD_ALLOWS_BODY: Record<HttpMethod, boolean> = {
  GET: false,
  HEAD: false,
  POST: true,
  PUT: true,
  PATCH: true,
  DELETE: true,
  OPTIONS: false,
};

const CONTENT_TYPE_BY_BODY: Record<string, string> = {
  json: 'application/json',
  text: 'text/plain',
  form: 'application/x-www-form-urlencoded',
};

/** UTF-8 safe base64 (no atob/btoa dependence so this stays portable). */
export function base64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let output = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const byte1 = bytes[index];
    const byte2 = bytes[index + 1];
    const byte3 = bytes[index + 2];
    output += alphabet[byte1 >> 2];
    output += alphabet[((byte1 & 0x03) << 4) | ((byte2 ?? 0) >> 4)];
    output += byte2 === undefined ? '=' : alphabet[((byte2 & 0x0f) << 2) | ((byte3 ?? 0) >> 6)];
    output += byte3 === undefined ? '=' : alphabet[byte3 & 0x3f];
  }
  return output;
}

const hasHeader = (headers: ReadonlyArray<{ key: string }>, name: string): boolean => {
  const target = name.toLowerCase();
  return headers.some((header) => header.key.trim().toLowerCase() === target);
};

/**
 * Build the wire request. Returns warnings instead of throwing so the UI can
 * explain why a body or credential was ignored.
 */
export function buildHttpWireRequest(request: CurlRequest): HttpWireBuildResult {
  const parsed = parseHttpUrl(request.url);
  if (!parsed.ok) return { ok: false, reason: 'invalid-url' };

  const warnings: HttpWireWarning[] = [];
  const parts: HttpUrlParts = { ...parsed.parts };
  if (parsed.notes.userInfo) {
    // Credentials in the URL text are intentionally not forwarded; they belong
    // in the Auth tab where they can be encrypted at rest.
    warnings.push('url-credentials-ignored');
  }

  const headers: Array<{ key: string; value: string }> = request.headers
    .filter((header) => header.enabled && header.key.trim())
    .map((header) => ({ key: header.key.trim(), value: header.value }));

  const cookiePairs = request.cookies
    .filter((cookie) => cookie.enabled && cookie.key.trim())
    .map((cookie) => `${cookie.key.trim()}=${cookie.value}`);
  if (cookiePairs.length > 0 && !hasHeader(headers, 'cookie')) {
    headers.push({ key: 'Cookie', value: cookiePairs.join('; ') });
  }

  const auth = request.auth;
  if (auth.kind === 'basic' && auth.username) {
    const token = base64Utf8(`${auth.username}:${auth.password ?? ''}`);
    if (!hasHeader(headers, 'authorization')) {
      headers.push({ key: 'Authorization', value: `Basic ${token}` });
    }
  } else if (auth.kind === 'bearer' && auth.token) {
    if (!hasHeader(headers, 'authorization')) {
      headers.push({ key: 'Authorization', value: `Bearer ${auth.token}` });
    }
  } else if (auth.kind === 'apiKey' && auth.apiKeyName && auth.apiKeyValue) {
    if (auth.apiKeyIn === 'query') {
      const extra = `${encodeURIComponent(auth.apiKeyName)}=${encodeURIComponent(auth.apiKeyValue)}`;
      parts.query = parts.query ? `${parts.query}&${extra}` : extra;
    } else if (!hasHeader(headers, auth.apiKeyName)) {
      headers.push({ key: auth.apiKeyName, value: auth.apiKeyValue });
    }
  }

  let bodyText: string | undefined;
  if (request.body.kind !== 'none' && request.body.text) {
    if (!METHOD_ALLOWS_BODY[request.method]) {
      warnings.push('body-dropped-for-method');
    } else {
      bodyText = request.body.text;
      const contentType = CONTENT_TYPE_BY_BODY[request.body.kind];
      if (contentType && !hasHeader(headers, 'content-type')) {
        headers.push({ key: 'Content-Type', value: contentType });
      }
    }
  }

  const wire: CurlWireRequest = {
    id: request.id,
    method: request.method,
    url: composeHttpUrl(parts),
    headers,
    timeoutMs: request.options.timeoutMs,
    followRedirects: request.options.followRedirects,
    maxRedirects: request.options.maxRedirects,
    verifyTls: request.options.verifyTls,
  };
  if (bodyText !== undefined) wire.bodyText = bodyText;
  return { ok: true, wire, warnings };
}

/** Preview text for list rows: "GET https://api.example.com". */
export function describeCurlRequest(request: CurlRequest): string {
  const parsed = parseHttpUrl(request.url);
  if (!parsed.ok) return request.url || '—';
  return `${request.method} ${composeHttpUrl({ ...parsed.parts, path: '/', query: '' })}`;
}

/** Content type classification reused by the response panel. */
export function classifyResponseBody(contentType: string | undefined): 'json' | 'text' | 'html' | 'xml' | 'binary' {
  const normalized = (contentType ?? '').toLowerCase();
  if (normalized.includes('json')) return 'json';
  if (normalized.includes('html')) return 'html';
  if (normalized.includes('xml')) return 'xml';
  if (
    normalized.startsWith('text/') ||
    normalized.includes('javascript') ||
    normalized.includes('x-www-form-urlencoded')
  ) {
    return 'text';
  }
  return 'binary';
}
