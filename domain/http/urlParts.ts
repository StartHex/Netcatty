/**
 * Pure URL <-> { scheme, host, port, path, query } helpers for the Curl tool.
 *
 * The URL bar is authoritative. The four-part input is a live view over the
 * same string: editing either side recomposes the other one through these
 * helpers, which keeps a single source of truth and avoids sync loops.
 */

export type HttpScheme = 'http' | 'https';

export interface HttpUrlParts {
  scheme: HttpScheme;
  /** Host without brackets; IPv6 literals keep their inner colons. */
  host: string;
  /** Explicit port, or null when the scheme default applies. */
  port: number | null;
  /** Always starts with "/". */
  path: string;
  /** Raw query without the leading "?", duplicates and order preserved. */
  query: string;
}

export const HTTP_DEFAULT_PORTS: Record<HttpScheme, number> = {
  http: 80,
  https: 443,
};

export type HttpUrlParseFailure =
  | 'empty'
  | 'unsupported-scheme'
  | 'invalid-host'
  | 'invalid-port';

export interface HttpUrlParseNotes {
  userInfo?: { username: string; password: string };
  fragment?: string;
}

export type HttpUrlParseResult =
  | { ok: true; parts: HttpUrlParts; notes: HttpUrlParseNotes }
  | { ok: false; reason: HttpUrlParseFailure };

const SCHEME_PATTERN = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//;

const isValidHost = (host: string): boolean => {
  if (!host) return false;
  if (/[\s/?#@[\]]/.test(host)) return false;
  return true;
};

const safeDecode = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

/**
 * Parse a user-typed URL. Missing scheme defaults to https; a fragment is
 * dropped; `user:pass@` credentials are extracted so the URL text itself never
 * carries secrets.
 */
export function parseHttpUrl(input: string): HttpUrlParseResult {
  const trimmed = (input ?? '').trim();
  if (!trimmed) return { ok: false, reason: 'empty' };

  let rest = trimmed;
  let scheme: HttpScheme = 'https';
  const schemeMatch = SCHEME_PATTERN.exec(rest);
  if (schemeMatch) {
    const raw = schemeMatch[1].toLowerCase();
    if (raw !== 'http' && raw !== 'https') {
      return { ok: false, reason: 'unsupported-scheme' };
    }
    scheme = raw;
    rest = rest.slice(schemeMatch[0].length);
  } else if (rest.startsWith('//')) {
    rest = rest.slice(2);
  }

  const notes: HttpUrlParseNotes = {};

  // Strip the fragment first: it never reaches the server.
  const hashIndex = rest.indexOf('#');
  if (hashIndex >= 0) {
    notes.fragment = rest.slice(hashIndex + 1);
    rest = rest.slice(0, hashIndex);
  }

  // Split authority from path/query.
  let authority = rest;
  let remainder = '';
  const authorityEnd = rest.search(/[/?]/);
  if (authorityEnd >= 0) {
    authority = rest.slice(0, authorityEnd);
    remainder = rest.slice(authorityEnd);
  }

  // userinfo
  const atIndex = authority.lastIndexOf('@');
  if (atIndex >= 0) {
    const userInfo = authority.slice(0, atIndex);
    authority = authority.slice(atIndex + 1);
    const colonIndex = userInfo.indexOf(':');
    notes.userInfo = {
      username: colonIndex >= 0 ? safeDecode(userInfo.slice(0, colonIndex)) : safeDecode(userInfo),
      password: colonIndex >= 0 ? safeDecode(userInfo.slice(colonIndex + 1)) : '',
    };
  }

  // host + port
  let host = authority;
  let portText: string | null = null;
  if (authority.startsWith('[')) {
    const closeIndex = authority.indexOf(']');
    if (closeIndex < 0) return { ok: false, reason: 'invalid-host' };
    host = authority.slice(1, closeIndex);
    const after = authority.slice(closeIndex + 1);
    if (after.startsWith(':')) portText = after.slice(1);
    else if (after) return { ok: false, reason: 'invalid-host' };
  } else {
    const firstColon = authority.indexOf(':');
    const lastColon = authority.lastIndexOf(':');
    if (firstColon >= 0 && firstColon === lastColon) {
      host = authority.slice(0, firstColon);
      portText = authority.slice(firstColon + 1);
    } else if (firstColon >= 0) {
      // Bare IPv6 literal without brackets: the whole authority is the host.
      host = authority;
      portText = null;
    }
  }

  if (!isValidHost(host)) return { ok: false, reason: 'invalid-host' };

  let port: number | null = null;
  if (portText !== null && portText !== '') {
    if (!/^\d+$/.test(portText)) return { ok: false, reason: 'invalid-port' };
    const parsed = Number(portText);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      return { ok: false, reason: 'invalid-port' };
    }
    port = parsed;
  } else if (portText === '') {
    // "host:" means "no explicit port".
    port = null;
  }

  if (port !== null && port === HTTP_DEFAULT_PORTS[scheme]) {
    port = null;
  }

  let path = '/';
  let query = '';
  if (remainder) {
    const queryIndex = remainder.indexOf('?');
    const rawPath = queryIndex >= 0 ? remainder.slice(0, queryIndex) : remainder;
    query = queryIndex >= 0 ? remainder.slice(queryIndex + 1) : '';
    if (rawPath) {
      path = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
    }
  }

  return { ok: true, parts: { scheme, host, port, path, query }, notes };
}

/** Build the canonical URL text for a parts object (drops default ports). */
export function composeHttpUrl(parts: HttpUrlParts): string {
  const scheme: HttpScheme = parts.scheme === 'http' ? 'http' : 'https';
  const port =
    parts.port !== null && parts.port !== HTTP_DEFAULT_PORTS[scheme] ? `:${parts.port}` : '';
  const hostText = parts.host.includes(':') ? `[${parts.host}]` : parts.host;
  let path = parts.path || '/';
  if (!path.startsWith('/')) path = `/${path}`;
  const query = parts.query ? `?${parts.query}` : '';
  return `${scheme}://${hostText}${port}${path}${query}`;
}

/**
 * Merge a patch into existing parts. Changing the scheme keeps an explicit
 * port, except when that port was the previous scheme's default (it would be
 * meaningless after the switch, so it collapses back to "default").
 */
export function updateHttpUrlParts(
  parts: HttpUrlParts,
  patch: Partial<HttpUrlParts>,
): HttpUrlParts {
  const next: HttpUrlParts = { ...parts, ...patch };
  if (patch.scheme && patch.scheme !== parts.scheme && parts.port !== null) {
    if (parts.port === HTTP_DEFAULT_PORTS[parts.scheme]) {
      next.port = null;
    }
  }
  if (next.path && !next.path.startsWith('/')) next.path = `/${next.path}`;
  if (!next.path) next.path = '/';
  return next;
}

export function httpEffectivePort(parts: HttpUrlParts): number {
  return parts.port ?? HTTP_DEFAULT_PORTS[parts.scheme];
}

export interface QueryRow {
  key: string;
  value: string;
}

/**
 * Split a raw query string into editable rows. Values are kept raw (no
 * decode/encode round-trip) so editing a row never rewrites unrelated bytes.
 */
export function splitQueryString(query: string): QueryRow[] {
  if (!query) return [];
  return query.split('&').map((chunk) => {
    if (chunk === '') return { key: '', value: '' };
    const eqIndex = chunk.indexOf('=');
    if (eqIndex < 0) return { key: chunk, value: '' };
    return { key: chunk.slice(0, eqIndex), value: chunk.slice(eqIndex + 1) };
  });
}

export function joinQueryString(rows: readonly QueryRow[]): string {
  return rows
    .filter((row) => row.key !== '' || row.value !== '')
    .map((row) => (row.key ? `${row.key}=${row.value}` : row.value))
    .join('&');
}

/** Human-friendly target for list rows: "https://host:port". */
export function httpUrlOrigin(parts: HttpUrlParts): string {
  const port =
    parts.port !== null && parts.port !== HTTP_DEFAULT_PORTS[parts.scheme] ? `:${parts.port}` : '';
  const hostText = parts.host.includes(':') ? `[${parts.host}]` : parts.host;
  return `${parts.scheme}://${hostText}${port}`;
}
