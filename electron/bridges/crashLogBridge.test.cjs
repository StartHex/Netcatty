const test = require("node:test");
const assert = require("node:assert/strict");

const { _private } = require("./crashLogBridge.cjs");

test("formats renderer exit codes as unsigned Windows-style hex", () => {
  assert.equal(_private.formatExitCodeHex(1073807364), "0x40010004");
  assert.equal(_private.formatExitCodeHex(-1073741510), "0xC000013A");
});

test("explains Windows external termination exit code in diagnostics", () => {
  const diagnostic = _private.buildDiagnostic(
    { reason: "killed", exitCode: 1073807364 },
    "win32",
  );

  assert.equal(diagnostic.exitCodeHex, "0x40010004");
  assert.match(diagnostic.windowsExitCodeMeaning, /external process termination/);
});

test("keeps non-Windows diagnostics to portable exit-code data", () => {
  const diagnostic = _private.buildDiagnostic(
    { reason: "killed", exitCode: 1073807364 },
    "darwin",
  );

  assert.deepEqual(diagnostic, {
    exitCodeHex: "0x40010004",
    windowsExitCodeMeaning: undefined,
  });
});
