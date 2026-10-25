import test from "node:test";
import assert from "node:assert/strict";

import { resultToCsv, suggestExportFileName } from "./sqlResultExport.ts";
import type { DbQueryResult } from "../models/database";

const result = (values: DbQueryResult["rows"]): DbQueryResult => ({
  columns: [
    { name: "id", type: "int4" },
    { name: "name", type: "text" },
  ],
  rows: values,
  rowCount: values.length,
  truncated: false,
  command: "SELECT",
  durationMs: 1,
});

test("resultToCsv escapes quotes, commas and newlines", () => {
  const csv = resultToCsv(result([
    [1, 'plain'],
    [2, 'has, comma'],
    [3, 'say "hi"'],
    [4, null],
    [5, 'line\nbreak'],
  ]));
  assert.equal(
    csv,
    'id,name\r\n1,plain\r\n2,"has, comma"\r\n3,"say ""hi"""\r\n4,\r\n5,"line\nbreak"',
  );
});

test("resultToCsv returns an empty string without a result", () => {
  assert.equal(resultToCsv(undefined), "");
});

test("suggestExportFileName strips unsafe characters and stamps the time", () => {
  const name = suggestExportFileName("Prod / PG: main", "csv", Date.UTC(2026, 0, 2, 3, 4, 5));
  assert.equal(name, "Prod-PG-main-2026-01-02-03-04-05.csv");
  assert.equal(suggestExportFileName("", "csv", 0), "query-1970-01-01-00-00-00.csv");
});
