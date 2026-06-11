const test = require("node:test");
const assert = require("node:assert/strict");
const { getDriver, listBackends, DRIVER_REGISTRY } = require("./index.cjs");

test("registry exposes claude/codex/copilot/cursor", () => {
  assert.deepEqual(listBackends().sort(), ["claude", "codex", "copilot", "cursor"]);
});

test("getDriver returns a driver with runTurn", () => {
  for (const key of ["claude", "codex", "copilot", "cursor"]) {
    const d = getDriver(key);
    assert.equal(typeof d.runTurn, "function", `${key} must expose runTurn`);
  }
});

test("getDriver throws on unknown backend", () => {
  assert.throws(() => getDriver("gemini"), /No SDK driver registered for backend: gemini/);
});

test("claude/copilot/codex/cursor drivers expose listModels; codex returns [] (no catalog)", async () => {
  for (const key of ["claude", "codex", "copilot", "cursor"]) {
    assert.equal(typeof getDriver(key).listModels, "function", `${key} must expose listModels`);
  }
  assert.deepEqual(await getDriver("codex").listModels({}), []);
});
