import test from "node:test";
import assert from "node:assert/strict";

import { enDatabaseMessages } from "./en/database.ts";
import { zhCNDatabaseMessages } from "./zh-CN/database.ts";
import { zhTNDatabaseMessages } from "./zh-TW/database.ts";
import { ruDatabaseMessages } from "./ru/database.ts";
import { esDatabaseMessages } from "./es/database.ts";

const LOCALES = {
  en: enDatabaseMessages,
  "zh-CN": zhCNDatabaseMessages,
  "zh-TW": zhTNDatabaseMessages,
  ru: ruDatabaseMessages,
  es: esDatabaseMessages,
};

const REQUIRED_KEYS = Object.keys(enDatabaseMessages);

const PLACEHOLDER_KEYS: Record<string, string[]> = {
  "databases.count": ["{count}"],
  "databases.testOk": ["{ms}", "{version}"],
  "databases.deleteDescription": ["{label}"],
  "databases.workbench.rowCount": ["{count}"],
  "databases.workbench.pageOf": ["{page}", "{pages}"],
  "databases.workbench.elapsed": ["{ms}"],
  "databases.workbench.statementOk": ["{command}"],
};

test("database messages exist in every bundled locale", () => {
  for (const [locale, messages] of Object.entries(LOCALES)) {
    for (const key of REQUIRED_KEYS) {
      const value = messages[key];
      assert.equal(typeof value, "string", `${locale} is missing ${key}`);
      assert.ok(value.trim().length > 0, `${locale} has an empty value for ${key}`);
    }
  }
});

test("database placeholders survive translation", () => {
  for (const [locale, messages] of Object.entries(LOCALES)) {
    for (const [key, placeholders] of Object.entries(PLACEHOLDER_KEYS)) {
      for (const placeholder of placeholders) {
        assert.ok(
          messages[key].includes(placeholder),
          `${locale} lost ${placeholder} in ${key}`,
        );
      }
    }
  }
});
