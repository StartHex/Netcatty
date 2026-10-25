import type {
  Host,
  HostTotpConfig,
  OtpAuthenticator,
  OtpAuthenticatorAlgorithm,
  OtpAuthenticatorType,
} from './models';

/** Same alphabet and bounds as domain/totp.shared.cjs (main-process TOTP engine). */
const ALGORITHMS: readonly OtpAuthenticatorAlgorithm[] = ['SHA1', 'SHA256', 'SHA512'];
const DIGITS: readonly (6 | 7 | 8)[] = [6, 7, 8];
const MIN_SECRET_CHARS = 16;
const MAX_SECRET_CHARS = 2048;
const MIN_PERIOD = 1;
const MAX_PERIOD = 300;

export interface OtpAuthenticatorDraft {
  label: string;
  type?: OtpAuthenticatorType;
  secret: string;
  algorithm?: OtpAuthenticatorAlgorithm;
  digits?: 6 | 7 | 8;
  period?: number;
  issuer?: string;
  account?: string;
  counter?: number;
}

export interface OtpAuthenticatorValidation {
  ok: boolean;
  errors: string[];
}

export interface ParseOtpAuthenticatorUriResult {
  ok: boolean;
  draft?: OtpAuthenticatorDraft;
  error?: string;
}

export function normalizeOtpSecret(input: string | undefined | null): string {
  return String(input ?? '')
    .replace(/[\s-]+/g, '')
    .replace(/=+$/g, '')
    .toUpperCase();
}

export function isValidOtpSecret(secret: string | undefined | null): boolean {
  const cleaned = normalizeOtpSecret(secret);
  if (cleaned.length < MIN_SECRET_CHARS || cleaned.length > MAX_SECRET_CHARS) return false;
  if (/[^A-Z2-7]/.test(cleaned)) return false;
  // Every 8 base32 characters carry 5 bytes; a single leftover character is not decodable.
  return cleaned.length % 8 !== 1;
}

export function isOtpAlgorithm(value: unknown): value is OtpAuthenticatorAlgorithm {
  if (typeof value !== 'string') return false;
  return ALGORITHMS.includes(value.toUpperCase() as OtpAuthenticatorAlgorithm);
}

export function isOtpDigits(value: unknown): value is 6 | 7 | 8 {
  return typeof value === 'number' && (DIGITS as readonly number[]).includes(value);
}

export function isOtpPeriod(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= MIN_PERIOD && value <= MAX_PERIOD;
}

export function buildOtpAuthenticatorUri(
  draft: Pick<OtpAuthenticator, 'label' | 'secret' | 'algorithm' | 'digits' | 'period'> & {
    issuer?: string;
    account?: string;
    type?: OtpAuthenticatorType;
  },
): string {
  const type = draft.type === 'hotp' ? 'hotp' : 'totp';
  const issuer = draft.issuer?.trim();
  const label = (draft.account?.trim() || draft.label.trim() || 'OTP');
  const pathLabel = issuer && !label.startsWith(`${issuer}:`) ? `${issuer}:${label}` : label;
  const params = new URLSearchParams();
  params.set('secret', normalizeOtpSecret(draft.secret));
  params.set('algorithm', isOtpAlgorithm(draft.algorithm) ? draft.algorithm : 'SHA1');
  params.set('digits', String(isOtpDigits(draft.digits) ? draft.digits : 6));
  params.set('period', String(isOtpPeriod(draft.period) ? draft.period : 30));
  if (issuer) params.set('issuer', issuer);
  return `otpauth://${type}/${encodeURIComponent(pathLabel)}?${params.toString()}`;
}

export function parseOtpAuthenticatorUri(uri: string): ParseOtpAuthenticatorUriResult {
  let url: URL;
  try {
    url = new URL(uri.trim());
  } catch {
    return { ok: false, error: 'invalid-uri' };
  }
  const type = (url.hostname || '').toLowerCase();
  if (type === 'hotp') return { ok: false, error: 'hotp' };
  if (type !== 'totp') return { ok: false, error: 'invalid-uri' };
  const secret = url.searchParams.get('secret') ?? '';
  if (!isValidOtpSecret(secret)) return { ok: false, error: 'invalid-secret' };
  const algorithmRaw = (url.searchParams.get('algorithm') || 'SHA1').toUpperCase();
  if (!isOtpAlgorithm(algorithmRaw)) return { ok: false, error: 'invalid-algorithm' };
  const digitsRaw = Number(url.searchParams.get('digits') ?? 6);
  if (!isOtpDigits(digitsRaw)) return { ok: false, error: 'invalid-digits' };
  const periodRaw = Number(url.searchParams.get('period') ?? 30);
  if (type === 'totp' && !isOtpPeriod(periodRaw)) return { ok: false, error: 'invalid-period' };
  const issuer = url.searchParams.get('issuer') ?? '';
  const pathLabel = decodeURIComponent((url.pathname || '').replace(/^\/+/, ''));
  const label = issuer && pathLabel.startsWith(`${issuer}:`) ? pathLabel.slice(issuer.length + 1) : pathLabel;
  return {
    ok: true,
    draft: {
      label: label || issuer || 'OTP',
      type,
      secret: normalizeOtpSecret(secret),
      algorithm: algorithmRaw,
      digits: digitsRaw,
      period: type === 'totp' ? periodRaw : 30,
      issuer: issuer || undefined,
      account: label || undefined,
    },
  };
}

export function validateOtpAuthenticatorDraft(draft: OtpAuthenticatorDraft): OtpAuthenticatorValidation {
  const errors: string[] = [];
  if (!draft.label.trim()) errors.push('label');
  if (!isValidOtpSecret(draft.secret)) errors.push('secret');
  if (draft.algorithm !== undefined && !isOtpAlgorithm(draft.algorithm)) errors.push('algorithm');
  if (draft.digits !== undefined && !isOtpDigits(draft.digits)) errors.push('digits');
  if (draft.period !== undefined && !isOtpPeriod(draft.period)) errors.push('period');
  if (draft.type !== undefined && draft.type !== 'totp') errors.push('type');
  return { ok: errors.length === 0, errors };
}

export function createOtpAuthenticator(draft: OtpAuthenticatorDraft, id: string, now = Date.now()): OtpAuthenticator {
  return {
    id,
    label: draft.label.trim(),
    type: 'totp',
    secret: normalizeOtpSecret(draft.secret),
    algorithm: isOtpAlgorithm(draft.algorithm) ? draft.algorithm : 'SHA1',
    digits: isOtpDigits(draft.digits) ? draft.digits : 6,
    period: isOtpPeriod(draft.period) ? draft.period : 30,
    issuer: draft.issuer?.trim() || undefined,
    account: draft.account?.trim() || undefined,
    createdAt: now,
    updatedAt: now,
  };
}

export function sanitizeOtpAuthenticator(raw: unknown): OtpAuthenticator | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const id = typeof value.id === 'string' ? value.id.trim() : '';
  const label = typeof value.label === 'string' ? value.label.trim() : '';
  const secret = normalizeOtpSecret(typeof value.secret === 'string' ? value.secret : '');
  // Cloud-sync payloads strip the device-bound secret but keep the entry so
  // host references and labels survive. Empty secrets are therefore allowed.
  if (!id || !label) return null;
  if (secret && !isValidOtpSecret(secret)) return null;
  const type: OtpAuthenticatorType = value.type === 'hotp' ? 'hotp' : 'totp';
  const algorithm = isOtpAlgorithm(value.algorithm)
    ? (value.algorithm.toUpperCase() as OtpAuthenticatorAlgorithm)
    : 'SHA1';
  const digits = isOtpDigits(value.digits) ? value.digits : 6;
  const period = isOtpPeriod(value.period) ? value.period : 30;
  const createdAt = typeof value.createdAt === 'number' ? value.createdAt : Date.now();
  const updatedAt = typeof value.updatedAt === 'number' ? value.updatedAt : undefined;
  const order = typeof value.order === 'number' ? value.order : undefined;
  return {
    id,
    label,
    type,
    ...(secret ? { secret } : {}),
    algorithm,
    digits,
    period,
    ...(type === 'hotp' ? { counter: typeof value.counter === 'number' ? value.counter : 0 } : {}),
    issuer: typeof value.issuer === 'string' && value.issuer.trim() ? value.issuer.trim() : undefined,
    account: typeof value.account === 'string' && value.account.trim() ? value.account.trim() : undefined,
    order,
    createdAt,
    updatedAt,
  };
}

export function sanitizeOtpAuthenticators(raw: unknown): OtpAuthenticator[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(sanitizeOtpAuthenticator)
    .filter((entry): entry is OtpAuthenticator => entry !== null);
}

export function sortOtpAuthenticators(authenticators: readonly OtpAuthenticator[]): OtpAuthenticator[] {
  return [...authenticators].sort((a, b) => {
    const orderA = a.order ?? Number.MAX_SAFE_INTEGER;
    const orderB = b.order ?? Number.MAX_SAFE_INTEGER;
    if (orderA !== orderB) return orderA - orderB;
    return a.label.localeCompare(b.label);
  });
}

export function getOtpAuthenticator(
  authenticators: readonly OtpAuthenticator[] | undefined,
  id: string | undefined,
): OtpAuthenticator | undefined {
  if (!id || !authenticators) return undefined;
  return authenticators.find((entry) => entry.id === id);
}

export function upsertOtpAuthenticator(
  authenticators: readonly OtpAuthenticator[],
  next: OtpAuthenticator,
): OtpAuthenticator[] {
  const exists = authenticators.some((entry) => entry.id === next.id);
  return exists
    ? authenticators.map((entry) => (entry.id === next.id ? next : entry))
    : [...authenticators, next];
}

/** Keep the per-host auto-submit preferences while replacing the secret material. */
export function materializeHostTotp(
  authenticator: OtpAuthenticator,
  existing?: HostTotpConfig,
): HostTotpConfig {
  return {
    uri: buildOtpAuthenticatorUri(authenticator),
    autoSubmit: existing?.autoSubmit ?? true,
    ...(existing?.promptPattern ? { promptPattern: existing.promptPattern } : {}),
  };
}

export function countOtpAuthenticatorReferences(hosts: readonly Host[], id: string): number {
  return hosts.filter((host) => host.otpAuthenticatorId === id).length;
}

export function rematerializeHostsForAuthenticator(hosts: readonly Host[], authenticator: OtpAuthenticator): Host[] {
  if (!authenticator.secret) return [...hosts];
  return hosts.map((host) => (
    host.otpAuthenticatorId === authenticator.id
      ? { ...host, totp: materializeHostTotp(authenticator, host.totp) }
      : host
  ));
}

export function clearOtpAuthenticatorReferences(hosts: readonly Host[], id: string): Host[] {
  return hosts.map((host) => (
    host.otpAuthenticatorId === id
      ? { ...host, otpAuthenticatorId: undefined, totp: undefined }
      : host
  ));
}

export function describeOtpAuthenticator(authenticator: OtpAuthenticator): string {
  const parts = [
    (authenticator.type === 'hotp' ? 'HOTP' : 'TOTP'),
    authenticator.algorithm,
    `${authenticator.digits} digits`,
  ];
  if (authenticator.type !== 'hotp') parts.push(`${authenticator.period}s`);
  return parts.join(' · ');
}

export { ALGORITHMS as OTP_ALGORITHMS, DIGITS as OTP_DIGITS };
