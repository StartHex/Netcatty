// Numbered bastion menus (`1) OTP  2) SMS`) are not TOTP code prompts, so the
// code path never answers them. These helpers pick the OTP entry instead.


/**
 * Bastion hosts often greet with a numbered menu instead of a code prompt
 * (`1) OTP  2) SMS`). Picking the OTP entry removes the manual "type 1" step.
 * Returns the option number to send, or null when no OTP-ish entry exists.
 */
export function pickOtpMenuChoice(promptText) {
  if (typeof promptText !== "string" || !promptText) return null;
  const lines = promptText.split(/\r?\n/);
  let best = null;
  for (const line of lines) {
    const match = /^\s*[\[(]?(\d{1,2})[\]).:-]?\s+(.+)$/.exec(line);
    if (!match) continue;
    const label = match[2].trim();
    if (!label) continue;
    if (/sms|短信|短信验证|邮件|郵件|email|push|语音|voice/i.test(label)) continue;
    if (!/otp|totp|动态|動態|令牌|authenticator|one[- ]?time|验证器|驗證器/i.test(label)) continue;
    const value = Number(match[1]);
    if (!Number.isInteger(value)) continue;
    if (best === null) best = value;
  }
  return best;
}

export function planOtpMenuAutoSubmit({ prompts, autoSubmit } = {}) {
  if (autoSubmit === false) return { action: "skip" };
  if (!Array.isArray(prompts) || prompts.length !== 1) return { action: "skip" };
  const choice = pickOtpMenuChoice(prompts[0]?.prompt);
  if (choice === null) return { action: "skip" };
  return { action: "submit", responses: [String(choice)], choice };
}
