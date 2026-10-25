import assert from 'node:assert/strict';
import test from 'node:test';

import en from './en.ts';
import ru from './ru.ts';
import es from './es.ts';
import zhCN from './zh-CN.ts';
import zhTW from './zh-TW.ts';

const KEYS = [
  'vault.nav.authenticators',
  'otpAuthenticators.action.add',
  'otpAuthenticators.action.copyCode',
  'otpAuthenticators.search.placeholder',
  'otpAuthenticators.sectionTitle',
  'otpAuthenticators.count',
  'otpAuthenticators.empty.title',
  'otpAuthenticators.empty.desc',
  'otpAuthenticators.panel.newTitle',
  'otpAuthenticators.field.label',
  'otpAuthenticators.field.labelPlaceholder',
  'otpAuthenticators.field.secret',
  'otpAuthenticators.field.secretHint',
  'otpAuthenticators.field.secretMissing',
  'otpAuthenticators.field.type',
  'otpAuthenticators.field.algorithm',
  'otpAuthenticators.field.digits',
  'otpAuthenticators.field.digitsShort',
  'otpAuthenticators.field.period',
  'otpAuthenticators.preview',
  'otpAuthenticators.previewCountdown',
  'otpAuthenticators.previewEmpty',
  'otpAuthenticators.usage',
  'otpAuthenticators.missingSecret',
  'otpAuthenticators.copied',
  'otpAuthenticators.copyFailed',
  'otpAuthenticators.copySuffix',
  'otpAuthenticators.delete.title',
  'otpAuthenticators.delete.message',
  'otpAuthenticators.error.label',
  'otpAuthenticators.error.secret',
  'otpAuthenticators.error.algorithm',
  'otpAuthenticators.error.digits',
  'otpAuthenticators.error.period',
  'otpAuthenticators.error.type',
  'hostDetails.totp.authenticatorSource',
  'hostDetails.totp.authenticatorManual',
  'hostDetails.totp.authenticatorHint',
  'hostDetails.totp.fromAuthenticator',
  'hostDetails.totp.authenticatorMissingSecret',
] as const;

const locales = { en, ru, es, zhCN, zhTW };

test('OTP authenticator copy exists in every locale', () => {
  for (const [locale, messages] of Object.entries(locales)) {
    const missing = KEYS.filter((key) => !messages[key]);
    assert.deepEqual(missing, [], `${locale} is missing OTP authenticator copy`);
  }
});

test('OTP authenticator copy keeps its placeholders', () => {
  for (const messages of Object.values(locales)) {
    assert.match(messages['otpAuthenticators.count'] ?? '', /\{count\}/);
    assert.match(messages['otpAuthenticators.usage'] ?? '', /\{count\}/);
    assert.match(messages['otpAuthenticators.delete.message'] ?? '', /\{count\}/);
    assert.match(messages['otpAuthenticators.previewCountdown'] ?? '', /\{seconds\}/);
    assert.match(messages['hostDetails.totp.fromAuthenticator'] ?? '', /\{label\}/);
  }
});
