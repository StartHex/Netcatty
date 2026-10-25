import test from "node:test";
import assert from "node:assert/strict";

import { addSqlHistoryEntry, listSqlHistory, sanitizeSqlHistory } from "./sqlHistory.ts";

test("addSqlHistoryEntry promotes duplicates to the front", () => {
  const first = addSqlHistoryEntry([], { sql: "select 1", at: 1, ok: true });
  const second = addSqlHistoryEntry(first, { sql: "select 2", at: 2, ok: true });
  const third = addSqlHistoryEntry(second, { sql: "  select 1  ", at: 3, ok: false });
  assert.deepEqual(third.map((entry) => entry.sql), ["select 1", "select 2"]);
  assert.equal(third[0].at, 3);
  assert.equal(third[0].ok, false);
});

test("addSqlHistoryEntry caps the list", () => {
  let entries = [] as ReturnType<typeof addSqlHistoryEntry>;
  for (let index = 0; index < 5; index += 1) {
    entries = addSqlHistoryEntry(entries, { sql: `select ${index}`, at: index, ok: true }, 3);
  }
  assert.deepEqual(entries.map((entry) => entry.sql), ["select 4", "select 3", "select 2"]);
});

test("sanitizeSqlHistory drops malformed entries and empty statements", () => {
  const cleaned = sanitizeSqlHistory({
    "db-1": [{ sql: "select 1", at: 1, ok: true }, { sql: "", at: 2 }, null, { at: 3 }],
    "db-2": "nope",
    "db-3": [{ sql: "select 3", at: 4 }],
  });
  assert.deepEqual(cleaned["db-1"].map((entry) => entry.sql), ["select 1"]);
  assert.equal(cleaned["db-2"], undefined);
  assert.equal(cleaned["db-3"][0].ok, false);
});

test("listSqlHistory limits the returned entries", () => {
  const entries = Array.from({ length: 30 }, (_, index) => ({ sql: `s${index}`, at: index, ok: true }));
  assert.equal(listSqlHistory(entries).length, 20);
  assert.equal(listSqlHistory(undefined).length, 0);
});
