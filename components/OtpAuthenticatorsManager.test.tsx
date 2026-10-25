import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "../application/i18n/I18nProvider.tsx";
import { TooltipProvider } from "./ui/tooltip.tsx";
import { OtpAuthenticatorsManager } from "./OtpAuthenticatorsManager.tsx";
import type { Host, OtpAuthenticator } from "../types.ts";

const installStorageStub = () => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
    },
  });
};

const authenticator: OtpAuthenticator = {
  id: "otp-1",
  label: "Bastion OTP",
  type: "totp",
  secret: "JBSWY3DPEHPK3PXP",
  algorithm: "SHA1",
  digits: 6,
  period: 30,
  createdAt: 1,
};

const host: Host = {
  id: "host-1",
  label: "Jump box",
  hostname: "192.0.2.10",
  port: 22,
  username: "root",
  protocol: "ssh",
  otpAuthenticatorId: "otp-1",
  totp: { uri: "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&algorithm=SHA1&digits=6&period=30" },
} as Host;

const renderManager = (authenticators: OtpAuthenticator[], hosts: Host[]) =>
  renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      {
        locale: "en",
        children: React.createElement(
          TooltipProvider,
          null,
          React.createElement(OtpAuthenticatorsManager, {
            authenticators,
            hosts,
            onUpdateAuthenticators: () => {},
            onUpdateHosts: () => {},
          }),
        ),
      },
    ),
  );

test("OTP authenticators manager lists saved authenticators and usage", () => {
  installStorageStub();
  const markup = renderManager([authenticator], [host]);
  assert.match(markup, /Bastion OTP/);
  assert.match(markup, /1 hosts use it/);
  assert.match(markup, /sha1/i);
});

test("OTP authenticators manager shows the empty state without secrets", () => {
  installStorageStub();
  const markup = renderManager([], []);
  assert.match(markup, /No authenticators yet/);
  assert.doesNotMatch(markup, /JBSWY3DPEHPK3PXP/);
});
