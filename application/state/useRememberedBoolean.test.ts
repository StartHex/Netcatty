import test from "node:test";
import assert from "node:assert/strict";

import {
  readRememberedBoolean,
  resolveRememberedBooleanUpdate,
} from "./useRememberedBoolean.ts";

test("readRememberedBoolean falls back when localStorage is unavailable", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Reflect.deleteProperty(globalThis, "localStorage");
  try {
    assert.equal(readRememberedBoolean("missing", true), true);
    assert.equal(readRememberedBoolean("missing", false), false);
  } finally {
    if (previous) {
      Object.defineProperty(globalThis, "localStorage", previous);
    }
  }
});

test("resolveRememberedBooleanUpdate accepts values and updater functions", () => {
  assert.equal(resolveRememberedBooleanUpdate(false, true), true);
  assert.equal(resolveRememberedBooleanUpdate(true, (current) => !current), false);
});
