const assert = require("node:assert/strict");
const test = require("node:test");
const { EventEmitter } = require("node:events");

const { JdbcSidecar } = require("./jdbcSidecar.cjs");

test("an exited sidecar reports its signal and notifies the owner", async () => {
  let notified = null;
  const instance = new JdbcSidecar({ onExit: (info) => { notified = info; } });
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write: () => true };
  instance.child = child;
  const pending = instance.request("QUERY", { sql: "select 1" });
  instance.stderrTail = "";
  instance.onExit(null, "SIGKILL");
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "sidecar-exit");
  assert.match(result.error.message, /signal SIGKILL/);
  assert.deepEqual(notified, { code: null, signal: "SIGKILL" });
  assert.equal(instance.child, null);
});

test("a crashed sidecar keeps its stderr tail in the message", async () => {
  const instance = new JdbcSidecar({});
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write: () => true };
  instance.child = child;
  const pending = instance.request("QUERY", { sql: "select 1" });
  instance.stderrTail = "Exception in thread \"main\" java.lang.OutOfMemoryError";
  instance.onExit(1, null);
  const result = await pending;
  assert.match(result.error.message, /code 1/);
  assert.match(result.error.message, /OutOfMemoryError/);
});
