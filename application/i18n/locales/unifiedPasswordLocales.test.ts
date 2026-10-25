import assert from 'node:assert/strict';
import test from 'node:test';

import en from './en.ts';
import ru from './ru.ts';
import es from './es.ts';
import zhCN from './zh-CN.ts';
import zhTW from './zh-TW.ts';

const KEYS = [
  'vault.groups.details.unifiedPassword.label',
  'vault.groups.details.unifiedPassword.hint',
  'vault.groups.details.unifiedPassword.scope',
  'vault.groups.details.unifiedPassword.source',
  'vault.groups.details.unifiedPassword.pickSource',
  'vault.groups.details.unifiedPassword.changeSource',
  'vault.groups.details.unifiedPassword.passwordRequired',
  'vault.groups.details.unifiedPassword.pickTitle',
  'vault.groups.details.unifiedPassword.pickDescription',
  'vault.groups.details.unifiedPassword.pickSearch',
  'vault.groups.details.unifiedPassword.pickEmpty',
  'vault.groups.details.unifiedPassword.pickInGroup',
  'vault.groups.details.unifiedPassword.pickScope',
  'vault.groups.details.unifiedPassword.useManual',
] as const;

test('unified password copy exists in every locale', () => {
  for (const [locale, messages] of Object.entries({ en, ru, es, zhCN, zhTW })) {
    const missing = KEYS.filter((key) => !messages[key]);
    assert.deepEqual(missing, [], `${locale} is missing unified password copy`);
  }
});

test('unified password counts interpolate the host total', () => {
  for (const messages of [en, ru, es, zhCN, zhTW]) {
    for (const key of [
      'vault.groups.details.unifiedPassword.scope',
      'vault.groups.details.unifiedPassword.pickScope',
    ] as const) {
      assert.match(messages[key] ?? '', /\{count\}/, `${key} must keep the {count} placeholder`);
    }
  }
});
