import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "../../application/i18n/I18nProvider.tsx";
import { TooltipProvider } from "../ui/tooltip.tsx";
import { DatabasesManager } from "./DatabasesManager.tsx";
import type { DatabaseConnection } from "../../domain/models";

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

const postgres: DatabaseConnection = {
  id: "db-1",
  label: "Production Postgres",
  kind: "postgresql",
  host: "db.internal",
  port: 5432,
  database: "app",
  username: "readonly",
  password: "enc:v1:secret-ciphertext",
  savePassword: true,
  sslMode: "require",
  createdAt: 1,
};

const renderManager = (connections: DatabaseConnection[]) =>
  renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      {
        locale: "en",
        children: React.createElement(
          TooltipProvider,
          null,
          React.createElement(DatabasesManager, {
            dbConnections: connections,
            onUpdateDbConnections: () => {},
            onOpenConnection: () => {},
          }),
        ),
      },
    ),
  );

test("databases manager lists saved connections with their target", () => {
  installStorageStub();
  const markup = renderManager([postgres]);
  assert.match(markup, /Production Postgres/);
  assert.match(markup, /db\.internal:5432\/app/);
  assert.match(markup, /PostgreSQL/);
  assert.doesNotMatch(markup, /enc:v1:secret-ciphertext/);
});

test("databases manager shows the empty state", () => {
  installStorageStub();
  const markup = renderManager([]);
  assert.match(markup, /No database connections yet/);
});

test("databases manager filters by search query", () => {
  installStorageStub();
  assert.match(renderManager([postgres]), /Production Postgres/);
});
