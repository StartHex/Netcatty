import assert from 'node:assert/strict';
import test from 'node:test';

import { createRequire } from 'node:module';

import {
  buildOtpAuthenticatorUri,
  clearOtpAuthenticatorReferences,
  countOtpAuthenticatorReferences,
  createOtpAuthenticator,
  getOtpAuthenticator,
  isValidOtpSecret,
  materializeHostTotp,
  parseOtpAuthenticatorUri,
  rematerializeHostsForAuthenticator,
  sanitizeOtpAuthenticators,
  upsertOtpAuthenticator,
  validateOtpAuthenticatorDraft,
} from './otpAuthenticator';
import type { Host, OtpAuthenticator } from './models';

const require = createRequire(import.meta.url);
const { generateTotp, parseTotpInput } = require('./totp.shared.cjs') as {
  generateTotp: (input: { secret: Buffer; algorithm: string; digits: number; period: number; timestamp?: number }) => string;
  parseTotpInput: (text: string) => {
    ok: boolean;
    error?: string;
    secret?: Buffer;
    algorithm?: string;
    digits?: number;
    period?: number;
    issuer?: string;
    label?: string;
    uri?: string;
  };
};

const SECRET = 'JBSWY3DPEHPK3PXP';

const baseDraft = {
  label: 'Bastion admin',
  secret: SECRET,
  algorithm: 'SHA1' as const,
  digits: 6 as const,
  period: 30,
};

function makeAuthenticator(overrides: Partial<OtpAuthenticator> = {}): OtpAuthenticator {
  return {
    id: 'otp-1',
    label: 'Bastion',
    type: 'totp',
    secret: SECRET,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    createdAt: 1,
    ...overrides,
  };
}

test('normalizes and validates base32 secrets', () => {
  assert.equal(isValidOtpSecret('jbswy3dp ehpk3pxp'), true);
  assert.equal(isValidOtpSecret('JBSW-Y3DP-EHPK-3PXP'), true);
  assert.equal(isValidOtpSecret(''), false);
  assert.equal(isValidOtpSecret('SHORTB32'), false);
  assert.equal(isValidOtpSecret('JBSWY3DPEHPK3PX1'), false);
});

test('builds an otpauth URI the main-process parser accepts', () => {
  const built = buildOtpAuthenticatorUri({
    ...baseDraft,
    issuer: 'Corp',
    algorithm: 'SHA256',
    digits: 8,
    period: 60,
  });
  const parsed = parseTotpInput(built);
  assert.equal(parsed.ok, true, parsed.error);
  assert.equal(parsed.algorithm, 'SHA256');
  assert.equal(parsed.digits, 8);
  assert.equal(parsed.period, 60);
  assert.equal(parsed.issuer, 'Corp');
  assert.equal(parsed.label, 'Bastion admin');
});

test('generates the same code as the shared main-process engine', () => {
  const built = buildOtpAuthenticatorUri(baseDraft);
  const parsed = parseTotpInput(built);
  assert.equal(parsed.ok, true);
  const secret = parsed.secret!;
  const timestamp = 1_700_000_000_000;
  assert.equal(
    generateTotp({ secret, algorithm: 'SHA1', digits: 6, period: 30, timestamp }),
    generateTotp({ secret, algorithm: 'SHA1', digits: 6, period: 30, timestamp }),
  );
});

test('round-trips an authenticator through the otpauth URI', () => {
  const built = buildOtpAuthenticatorUri({ ...baseDraft, issuer: 'Corp' });
  const parsed = parseOtpAuthenticatorUri(built);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.draft.secret, SECRET);
  assert.equal(parsed.draft.issuer, 'Corp');
  assert.equal(parsed.draft.account, 'Bastion admin');
  assert.equal(parsed.draft.algorithm, 'SHA1');
  assert.equal(parsed.draft.digits, 6);
  assert.equal(parsed.draft.period, 30);
});

test('rejects malformed otpauth input', () => {
  assert.deepEqual(parseOtpAuthenticatorUri('not-a-uri'), { ok: false, error: 'invalid-uri' });
  assert.deepEqual(
    parseOtpAuthenticatorUri(`otpauth://hotp/x?secret=${SECRET}`),
    { ok: false, error: 'hotp' },
  );
  assert.deepEqual(
    parseOtpAuthenticatorUri('otpauth://totp/x?secret=AAAA'),
    { ok: false, error: 'invalid-secret' },
  );
});

test('validates drafts and creates TOTP authenticators', () => {
  assert.equal(validateOtpAuthenticatorDraft(baseDraft).ok, true);
  assert.deepEqual(validateOtpAuthenticatorDraft({ ...baseDraft, label: ' ' }).errors, ['label']);
  assert.deepEqual(validateOtpAuthenticatorDraft({ ...baseDraft, type: 'hotp' }).errors, ['type']);

  const created = createOtpAuthenticator(baseDraft, 'otp-9', 42);
  assert.equal(created.type, 'totp');
  assert.equal(created.createdAt, 42);
  assert.equal(created.secret, SECRET);
  assert.equal(validateOtpAuthenticatorDraft({ ...created, secret: created.secret ?? '' }).ok, true);
});

test('sanitizes imported authenticators and drops broken records', () => {
  const list = sanitizeOtpAuthenticators([
    { id: 'a', label: 'A', secret: SECRET, algorithm: 'sha256', digits: 7, period: 30, createdAt: 1 },
    { id: 'b', label: 'B', secret: 'nope', createdAt: 1 },
    { id: '', label: 'C', secret: SECRET },
    null,
  ]);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'a');
  assert.equal(list[0].algorithm, 'SHA256');
  assert.equal(list[0].digits, 7);
});

test('upserts by id', () => {
  const first = makeAuthenticator();
  const second = makeAuthenticator({ id: 'otp-2', label: 'Second' });
  const inserted = upsertOtpAuthenticator([first], second);
  assert.deepEqual(inserted.map((entry) => entry.id), ['otp-1', 'otp-2']);
  const updated = upsertOtpAuthenticator(inserted, { ...first, label: 'Renamed' });
  assert.equal(updated.length, 2);
  assert.equal(getOtpAuthenticator(updated, 'otp-1')?.label, 'Renamed');
});

test('materializes a host TOTP config and keeps auto-submit preferences', () => {
  const auth = makeAuthenticator({ issuer: 'Corp' });
  const totp = materializeHostTotp(auth, { uri: 'otpauth://totp/old?secret=OLD', autoSubmit: false, promptPattern: '^OTP:' });
  const parsed = parseTotpInput(totp.uri);
  assert.equal(parsed.ok, true);
  assert.equal(totp.autoSubmit, false);
  assert.equal(totp.promptPattern, '^OTP:');
});

test('re-materializes only hosts that reference the edited authenticator', () => {
  const auth = makeAuthenticator();
  const hosts = [
    { id: 'h1', otpAuthenticatorId: auth.id, totp: { uri: 'otpauth://totp/x?secret=OLD' } },
    { id: 'h2', totp: { uri: 'otpauth://totp/y?secret=KEEP' } },
  ] as unknown as Host[];
  const next = rematerializeHostsForAuthenticator(hosts, { ...auth, algorithm: 'SHA512' });
  assert.match(next[0]?.totp?.uri ?? '', /algorithm=SHA512/);
  assert.equal(next[1]?.totp?.uri, 'otpauth://totp/y?secret=KEEP');
  assert.equal(countOtpAuthenticatorReferences(hosts, auth.id), 1);
});

test('clears references when the authenticator is deleted', () => {
  const hosts = [
    { id: 'h1', otpAuthenticatorId: 'otp-1', totp: { uri: 'otpauth://totp/x?secret=OLD' } },
    { id: 'h2', otpAuthenticatorId: 'otp-2', totp: { uri: 'otpauth://totp/y?secret=KEEP' } },
  ] as unknown as Host[];
  const cleared = clearOtpAuthenticatorReferences(hosts, 'otp-1');
  assert.equal(cleared[0]?.otpAuthenticatorId, undefined);
  assert.equal(cleared[0]?.totp, undefined);
  assert.equal(cleared[1]?.totp?.uri, 'otpauth://totp/y?secret=KEEP');
});
