"use strict";

/**
 * Locate a usable JRE for the JDBC sidecar.
 *
 * Order: explicit settings override, NETCATTY_JAVA_HOME, JAVA_HOME, PATH, then
 * per-platform well-known install locations. Returns the java binary path only
 * after `java -version` succeeds, so a broken symlink never looks healthy.
 */

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const cache = new Map();

function isExecutableFile(candidate) {
  try {
    const stat = fs.statSync(candidate);
    if (!stat.isFile()) return false;
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function javaBinaryIn(home) {
  if (!home) return null;
  const candidates =
    process.platform === "win32"
      ? [path.join(home, "bin", "java.exe"), path.join(home, "bin", "java")]
      : [path.join(home, "bin", "java")];
  return candidates.find(isExecutableFile) || null;
}

function probe(binary) {
  try {
    const output = execFileSync(binary, ["-version"], {
      encoding: "utf8",
      timeout: 8000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, version: output.split("\n")[0].trim() };
  } catch (error) {
    // `java -version` writes to stderr on success; spawn failures throw.
    if (error && error.status === 0) return { ok: true, version: "" };
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function defaultHomes() {
  if (process.platform === "darwin") {
    const root = "/Library/Java/JavaVirtualMachines";
    try {
      return fs
        .readdirSync(root)
        .map((entry) => path.join(root, entry, "Contents", "Home"))
        .sort()
        .reverse();
    } catch {
      return [];
    }
  }
  if (process.platform === "win32") {
    const roots = [
      process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Java"),
      process.env["ProgramFiles(x86)"] && path.join(process.env["ProgramFiles(x86)"], "Java"),
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "Eclipse Adoptium"),
    ].filter(Boolean);
    const homes = [];
    for (const root of roots) {
      try {
        for (const entry of fs.readdirSync(root)) homes.push(path.join(root, entry));
      } catch {
        // ignore missing roots
      }
    }
    return homes;
  }
  const root = "/usr/lib/jvm";
  try {
    return fs.readdirSync(root).map((entry) => path.join(root, entry));
  } catch {
    return [];
  }
}

function resolveJava(options = {}) {
  const key = `${options.javaHome || ""}|${options.javaPath || ""}`;
  if (cache.has(key)) return cache.get(key);

  const tried = [];
  const candidates = [];
  if (options.javaPath) candidates.push(options.javaPath);
  if (options.javaHome) candidates.push(javaBinaryIn(options.javaHome));
  if (process.env.NETCATTY_JAVA_HOME) candidates.push(javaBinaryIn(process.env.NETCATTY_JAVA_HOME));
  if (process.env.JAVA_HOME) candidates.push(javaBinaryIn(process.env.JAVA_HOME));
  candidates.push(process.platform === "win32" ? "java.exe" : "java");
  for (const home of defaultHomes()) candidates.push(javaBinaryIn(home));

  for (const candidate of candidates.filter(Boolean)) {
    tried.push(candidate);
    if (!candidate.includes(path.sep) && candidate === "java") {
      // Bare command name: let the OS resolve PATH, probing validates it exists.
      const result = probe(candidate);
      if (result.ok) {
        const resolved = { ok: true, path: candidate, version: result.version, tried };
        cache.set(key, resolved);
        return resolved;
      }
      continue;
    }
    if (!isExecutableFile(candidate)) continue;
    const result = probe(candidate);
    if (result.ok) {
      const resolved = { ok: true, path: candidate, version: result.version, tried };
      cache.set(key, resolved);
      return resolved;
    }
  }
  const resolved = {
    ok: false,
    tried,
    error:
      "未找到可用的 Java 运行时。请安装 JRE 21+（如 Temurin），或在设置中指定 java 路径。",
  };
  cache.set(key, resolved);
  return resolved;
}

module.exports = { resolveJava };
