"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { resolveJava, parseJavaMajor, isDirLike } = require("./javaRuntime.cjs");

const posixOnly = process.platform === "win32" ? test.skip : test;

function fakeJava(versionLine) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nc-java-"));
  const file = path.join(dir, "java");
  fs.writeFileSync(file, `#!/bin/sh\necho '${versionLine}' >&2\nexit 0\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

test("parses modern and legacy version strings", () => {
  assert.equal(parseJavaMajor('openjdk version "21.0.13" 2025-10-21'), 21);
  assert.equal(parseJavaMajor('java version "17.0.2" 2022-01-18'), 17);
  assert.equal(parseJavaMajor('java version "1.8.0_402"'), 8);
  assert.equal(parseJavaMajor(""), 0);
});

posixOnly("accepts a Java 17+ runtime given explicitly", () => {
  const binary = fakeJava('openjdk version "17.0.11" 2024-04-16');
  const resolved = resolveJava({ javaPath: binary });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.path, binary);
  assert.equal(resolved.major, 17);
});

posixOnly("rejects an old runtime and explains why", () => {
  const binary = fakeJava('java version "1.8.0_402"');
  const resolved = resolveJava({ javaPath: binary });
  assert.equal(resolved.ok, false);
  assert.equal(resolved.foundButTooOld.major, 8);
  assert.match(resolved.error, /Java 8/);
});

posixOnly("treats symlinked JDK directories as homes (Homebrew layout)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nc-opt-"));
  const real = path.join(dir, "Cellar", "openjdk@21", "21.0.11", "libexec", "openjdk.jdk");
  fs.mkdirSync(real, { recursive: true });
  const link = path.join(dir, "openjdk@21");
  fs.symlinkSync(real, link);
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const linked = entries.find((entry) => entry.name === "openjdk@21");
  assert.equal(isDirLike(linked), true);
});

test("listJavaCandidates returns absolute, de-duplicated binaries with the explicit path first", () => {
  const { listJavaCandidates } = require("./javaRuntime.cjs");
  const withPath = listJavaCandidates({ javaPath: "/opt/example/bin/java" });
  assert.equal(withPath[0], "/opt/example/bin/java");
  assert.equal(new Set(withPath).size, withPath.length);
  assert.ok(withPath.every((candidate) => candidate.startsWith("/") || candidate.includes(":\\")));
  const plain = listJavaCandidates({});
  assert.ok(Array.isArray(plain));
  assert.equal(new Set(plain).size, plain.length);
});
