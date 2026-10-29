import type { HostTotpConfig } from "./models";
import { isEncryptedCredentialPlaceholder } from "./credentials";

/** Connection payload for a host TOTP secret. Device-bound ciphertext is omitted. */
export function connectionTotpFromHost(
  host: { totp?: HostTotpConfig } | null | undefined,
  options?: { menuAutoSubmit?: boolean },
): HostTotpConfig | undefined {
  const totp = host?.totp;
  const rawUri = totp?.uri?.trim();
  const uri = rawUri && !isEncryptedCredentialPlaceholder(rawUri) ? rawUri : "";
  const menuAutoSubmit = options?.menuAutoSubmit !== false;
  // Bastion menus need a payload even when the host has no TOTP secret.
  if (!uri && !menuAutoSubmit) return undefined;
  const promptPattern = totp?.promptPattern?.trim();
  return {
    uri,
    autoSubmit: totp?.autoSubmit !== false,
    menuAutoSubmit,
    ...(promptPattern ? { promptPattern } : {}),
  };
}

export function connectionTotpFields(
  host: { totp?: HostTotpConfig } | null | undefined,
  options?: { menuAutoSubmit?: boolean },
): { totp?: HostTotpConfig } {
  const totp = connectionTotpFromHost(host, options);
  return totp ? { totp } : {};
}
