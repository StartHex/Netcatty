/**
 * Response body decoding helpers for the Curl tool.
 *
 * The main process always returns the raw bytes (base64) next to the utf-8
 * decoded text, so the renderer can re-decode with another charset without
 * sending the request again.
 */

export const RESPONSE_ENCODINGS = [
  'auto',
  'utf-8',
  'gb18030',
  'big5',
  'shift_jis',
  'iso-8859-1',
  'utf-16le',
] as const;

export type ResponseEncoding = typeof RESPONSE_ENCODINGS[number];

/** TextDecoder labels; `auto` falls back to utf-8. */
const DECODER_LABELS: Record<Exclude<ResponseEncoding, 'auto'>, string> = {
  'utf-8': 'utf-8',
  gb18030: 'gb18030',
  big5: 'big5',
  shift_jis: 'shift_jis',
  'iso-8859-1': 'iso-8859-1',
  'utf-16le': 'utf-16le',
};

const ALIASES: Record<string, Exclude<ResponseEncoding, 'auto'>> = {
  utf8: 'utf-8',
  'utf-8': 'utf-8',
  gb2312: 'gb18030',
  gbk: 'gb18030',
  gb18030: 'gb18030',
  big5: 'big5',
  'big-5': 'big5',
  sjis: 'shift_jis',
  shiftjis: 'shift_jis',
  'shift-jis': 'shift_jis',
  'iso-8859-1': 'iso-8859-1',
  latin1: 'iso-8859-1',
  'latin-1': 'iso-8859-1',
  'utf-16le': 'utf-16le',
  'utf-16': 'utf-16le',
};

export function normalizeResponseEncoding(value: unknown): ResponseEncoding {
  if (typeof value !== 'string') return 'auto';
  const normalized = value.trim().toLowerCase();
  if ((RESPONSE_ENCODINGS as readonly string[]).includes(normalized)) return normalized as ResponseEncoding;
  return ALIASES[normalized] ?? 'auto';
}

export function charsetFromContentType(contentType: string | undefined): ResponseEncoding | null {
  if (!contentType) return null;
  const match = /charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType);
  if (!match) return null;
  const normalized = normalizeResponseEncoding(match[1]);
  return normalized === 'auto' ? null : normalized;
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Decodes base64 without relying on atob (works in tests and workers). */
export function base64ToBytes(base64: string): Uint8Array | null {
  if (typeof base64 !== 'string') return null;
  const clean = base64.replace(/[^A-Za-z0-9+/=]/g, '');
  if (!clean) return base64.trim() ? null : new Uint8Array(0);
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  const body = padding ? clean.slice(0, clean.length - padding) : clean;
  const bytes = new Uint8Array(Math.floor((body.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let offset = 0;
  for (const char of body) {
    const index = BASE64_ALPHABET.indexOf(char);
    if (index < 0) return null;
    buffer = (buffer << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[offset] = (buffer >> bits) & 0xff;
      offset += 1;
    }
  }
  return bytes.subarray(0, offset);
}

export function decodeBodyBytes(bytes: Uint8Array, encoding: ResponseEncoding): string {
  const label = encoding === 'auto' ? 'utf-8' : DECODER_LABELS[encoding];
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

/**
 * Decodes the response with the requested charset. Returns null when the
 * bridge did not ship raw bytes (bodies above the base64 mirror limit).
 */
export function decodeResponseBody(
  bodyBase64: string | undefined,
  encoding: ResponseEncoding,
): string | null {
  if (!bodyBase64) return null;
  const bytes = base64ToBytes(bodyBase64);
  if (!bytes) return null;
  return decodeBodyBytes(bytes, encoding);
}

export function formatJsonText(text: string, indent = 2): { ok: true; text: string } | { ok: false; message: string } {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, message: 'Empty body' };
  try {
    return { ok: true, text: JSON.stringify(JSON.parse(trimmed), null, indent) };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'Invalid JSON' };
  }
}

export function minifyJsonText(text: string): { ok: true; text: string } | { ok: false; message: string } {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, message: 'Empty body' };
  try {
    return { ok: true, text: JSON.stringify(JSON.parse(trimmed)) };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'Invalid JSON' };
  }
}

export function safeParseJson(text: string | undefined): unknown {
  if (!text || !text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Short one-line shape used in collapsed tree rows. */
export function jsonNodeSummary(value: unknown): string {
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? '' : 's'}`;
  if (value && typeof value === 'object') {
    const size = Object.keys(value as Record<string, unknown>).length;
    return `${size} key${size === 1 ? '' : 's'}`;
  }
  if (typeof value === 'string') return 'string';
  if (value === null) return 'null';
  return typeof value;
}
