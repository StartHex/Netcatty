import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pickOtpMenuChoice, planOtpMenuAutoSubmit } from './totpMenu.shared.mjs';

test('picks the OTP entry from a numbered menu', () => {
  assert.equal(pickOtpMenuChoice('请选择验证方式：\n1) OTP 动态口令\n2) SMS 短信验证码'), 1);
  assert.equal(pickOtpMenuChoice('1) SMS 短信验证码\n2) OTP 动态口令'), 2);
  assert.equal(pickOtpMenuChoice('1. Authenticator code\n2. Email'), 1);
});

test('ignores menus without an OTP entry and plain prompts', () => {
  assert.equal(pickOtpMenuChoice('1) SMS 短信验证码\n2) 语音验证'), null);
  assert.equal(pickOtpMenuChoice('Password:'), null);
  assert.equal(pickOtpMenuChoice(''), null);
});

test('auto-submits only for a single menu prompt', () => {
  const menu = { prompt: '1) OTP 动态口令\n2) SMS 短信验证码' };
  assert.deepEqual(planOtpMenuAutoSubmit({ prompts: [menu] }), {
    action: 'submit',
    responses: ['1'],
    choice: 1,
  });
  assert.deepEqual(planOtpMenuAutoSubmit({ prompts: [menu, { prompt: 'Password:' }] }), { action: 'skip' });
  assert.deepEqual(planOtpMenuAutoSubmit({ prompts: [menu], autoSubmit: false }), { action: 'skip' });
  assert.deepEqual(planOtpMenuAutoSubmit({ prompts: [{ prompt: '[OTP Code]:' }] }), { action: 'skip' });
});
