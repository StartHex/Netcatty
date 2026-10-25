"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const bridge = require("./dbBridge.cjs");
const { __test, handlers } = bridge;

const {
  clampMaxRows,
  clampTimeout,
  toCellValue,
  normalizeError,
  pgSslOptions,
  mysqlSslOptions,
  rowsToMatrix,
} = __test;

test("clampMaxRows applies the default and hard ceiling", () => {
  assert.equal(clampMaxRows(undefined), 1000);
  assert.equal(clampMaxRows(0), 1000);
  assert.equal(clampMaxRows(50), 50);
  assert.equal(clampMaxRows(999999), 5000);
  assert.equal(clampMaxRows("25"), 25);
});

test("clampTimeout keeps timeouts inside the allowed window", () => {
  assert.equal(clampTimeout(undefined), 30000);
  assert.equal(clampTimeout(1), 1);
  assert.equal(clampTimeout(900000), 600000);
});

test("toCellValue normalizes driver values for the renderer", () => {
  assert.equal(toCellValue(null), null);
  assert.equal(toCellValue(undefined), null);
  assert.equal(toCellValue(42), 42);
  assert.equal(toCellValue(true), true);
  const date = new Date("2026-01-02T03:04:05.000Z");
  assert.equal(toCellValue(date), date.toISOString());
  assert.equal(toCellValue(Buffer.from("hi")), "aGk=");
  assert.equal(toCellValue(10n), 10);
  assert.equal(toCellValue({ a: 1 }), '{"a":1}');
});

test("normalizeError keeps driver error metadata", () => {
  const error = Object.assign(new Error("relation does not exist"), {
    code: "42P01",
    sqlState: "42P01",
    position: "15",
    detail: "detail text",
    hint: "hint text",
  });
  const normalized = normalizeError(error);
  assert.equal(normalized.message, "relation does not exist");
  assert.equal(normalized.code, "42P01");
  assert.equal(normalized.sqlState, "42P01");
  assert.equal(normalized.position, "15");
  assert.equal(normalized.detail, "detail text");
  assert.equal(normalized.hint, "hint text");
  assert.equal(normalizeError(null).message, "Unknown database error");
});

test("rowsToMatrix aligns values with the requested column order", () => {
  const rows = [
    { b: 2, a: 1 },
    { a: 3 },
  ];
  assert.deepEqual(rowsToMatrix(rows, ["a", "b"]), [
    [1, 2],
    [3, null],
  ]);
});

test("SSL option builders map modes to driver settings", () => {
  assert.equal(pgSslOptions("disable"), false);
  assert.deepEqual(pgSslOptions("require"), { rejectUnauthorized: false });
  assert.deepEqual(pgSslOptions("verify-full"), { rejectUnauthorized: true });
  assert.equal(mysqlSslOptions("disable"), undefined);
  assert.deepEqual(mysqlSslOptions("require"), { rejectUnauthorized: false });
});

test("sqlite: connect, create, insert and query keep the session alive", async () => {
  const target = { id: "sqlite-memory-test", kind: "sqlite", sqlitePath: ":memory:" };
  try {
    const connected = await handlers.connect(target);
    assert.equal(connected.ok, true, JSON.stringify(connected));
    assert.match(String(connected.serverVersion), /^\d+\./);

    const created = await handlers.query({ target, sql: "create table people (id integer primary key, name text)" });
    assert.equal(created.ok, true, JSON.stringify(created));

    const inserted = await handlers.query({
      target,
      sql: "insert into people (name) values ('Ada'), ('Linus')",
    });
    assert.equal(inserted.ok, true, JSON.stringify(inserted));

    const selected = await handlers.query({ target, sql: "select id, name from people order by id" });
    assert.equal(selected.ok, true, JSON.stringify(selected));
    assert.deepEqual(
      selected.result.columns.map((column) => column.name),
      ["id", "name"],
    );
    assert.deepEqual(selected.result.rows, [
      [1, "Ada"],
      [2, "Linus"],
    ]);
    assert.equal(selected.result.rowCount, 2);
    assert.equal(selected.result.truncated, false);
  } finally {
    await handlers.disconnect({ id: "sqlite-memory-test", kind: "sqlite", sqlitePath: ":memory:" });
  }
});

test("sqlite: maxRows marks the result truncated", async () => {
  const target = { id: "sqlite-limit-test", kind: "sqlite" };
  try {
    await handlers.query({ target, sql: "create table numbers (n integer)" });
    await handlers.query({ target, sql: "insert into numbers (n) values (1), (2), (3)" });
    const limited = await handlers.query({ target, sql: "select n from numbers", maxRows: 2 });
    assert.equal(limited.ok, true, JSON.stringify(limited));
    assert.equal(limited.result.rows.length, 2);
    assert.equal(limited.result.truncated, true);
  } finally {
    await handlers.disconnect({ id: "sqlite-limit-test", kind: "sqlite" });
  }
});

test("sqlite: unknown table reports a structured error", async () => {
  const target = { id: "sqlite-error-test", kind: "sqlite" };
  try {
    const failed = await handlers.query({ target, sql: "select * from missing_table" });
    assert.equal(failed.ok, false);
    assert.match(failed.error.message, /no such table/i);
  } finally {
    await handlers.disconnect({ id: "sqlite-error-test", kind: "sqlite" });
  }
});

test("unknown database kind fails with a clear error", async () => {
  const failed = await handlers.test({ id: "unknown", kind: "duckdb" });
  assert.equal(failed.ok, false);
  assert.match(failed.error.message, /unsupported database kind/i);
});

test("sqlite: transaction control commits and rolls back", async () => {
  const target = { id: "sqlite-tx-test", kind: "sqlite" };
  try {
    await handlers.query({ target, sql: "create table tx (n integer)" });
    const begun = await handlers.control({ target, action: "begin" });
    assert.equal(begun.ok, true, JSON.stringify(begun));
    await handlers.query({ target, sql: "insert into tx values (1)" });
    const rolled = await handlers.control({ target, action: "rollback" });
    assert.equal(rolled.ok, true, JSON.stringify(rolled));
    const afterRollback = await handlers.query({ target, sql: "select count(*) as c from tx" });
    assert.equal(afterRollback.result.rows[0][0], 0);

    await handlers.control({ target, action: "begin" });
    await handlers.query({ target, sql: "insert into tx values (2)" });
    await handlers.control({ target, action: "commit" });
    const afterCommit = await handlers.query({ target, sql: "select count(*) as c from tx" });
    assert.equal(afterCommit.result.rows[0][0], 1);
  } finally {
    await handlers.disconnect({ id: "sqlite-tx-test", kind: "sqlite" });
  }
});

test("transaction control rejects unknown actions", async () => {
  const failed = await handlers.control({
    target: { id: "sqlite-tx-invalid", kind: "sqlite" },
    action: "explode",
  });
  assert.equal(failed.ok, false);
  assert.match(failed.error.message, /unsupported transaction action/i);
});

test("sqlite: lists tables and columns for the schema tree", async () => {
  const target = { id: "sqlite-schema-test", kind: "sqlite" };
  try {
    await handlers.query({
      target,
      sql: "create table people (id integer primary key, name text not null)",
    });
    const tables = await handlers.tables({ target });
    assert.equal(tables.ok, true, JSON.stringify(tables));
    const people = tables.tables.find((entry) => entry.name === "people");
    assert.ok(people, JSON.stringify(tables.tables));
    assert.equal(people.type, "table");
    assert.equal(people.schema, "main");

    const columns = await handlers.columns({ target, schema: "main", table: "people" });
    assert.equal(columns.ok, true, JSON.stringify(columns));
    assert.deepEqual(
      columns.columns.map((entry) => entry.name),
      ["id", "name"],
    );
    assert.equal(columns.columns[1].nullable, false);
  } finally {
    await handlers.disconnect({ id: "sqlite-schema-test", kind: "sqlite" });
  }
});

test("columns rejects a missing table name", async () => {
  const failed = await handlers.columns({ target: { id: "x", kind: "sqlite" }, table: "" });
  assert.equal(failed.ok, false);
  assert.match(failed.error.message, /table name is required/i);
});
