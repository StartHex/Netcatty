#!/usr/bin/env node
/**
 * Compile the JDBC sidecar with the local JDK.
 *
 * The jar is a build artifact (not committed). When no JDK is present the step
 * degrades to a warning: the app then ships without JDBC support instead of
 * failing the whole packaging run.
 */

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const source = path.join(root, "electron", "jdbc-sidecar", "src", "NetcattyJdbcSidecar.java");
const outDir = path.join(root, "dist", "jdbc-sidecar");
const classesDir = path.join(outDir, "classes");
const jarPath = path.join(outDir, "netcatty-jdbc-sidecar.jar");
const { resolveJava } = require(path.join(root, "electron", "bridges", "javaRuntime.cjs"));

function findJdkTool(name) {
  const java = resolveJava({});
  const candidates = [];
  if (java.ok && java.path && java.path.includes(path.sep)) {
    candidates.push(path.join(path.dirname(java.path), process.platform === "win32" ? `${name}.exe` : name));
  }
  if (process.env.JAVA_HOME) {
    candidates.push(path.join(process.env.JAVA_HOME, "bin", process.platform === "win32" ? `${name}.exe` : name));
  }
  candidates.push(name);
  for (const candidate of candidates) {
    try {
      if (!candidate.includes(path.sep)) {
        execFileSync(candidate, ["-version"], { stdio: "ignore" });
        return candidate;
      }
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // try next candidate
    }
  }
  return null;
}

function main() {
  if (process.env.NETCATTY_SKIP_JDBC_SIDECAR === "1") {
    console.log("[jdbc-sidecar] skipped via NETCATTY_SKIP_JDBC_SIDECAR=1");
    return;
  }
  const javac = findJdkTool("javac");
  const jar = findJdkTool("jar");
  if (!javac || !jar) {
    console.warn("[jdbc-sidecar] javac/jar not found — JDBC support will be unavailable in this build");
    return;
  }
  fs.rmSync(classesDir, { recursive: true, force: true });
  fs.mkdirSync(classesDir, { recursive: true });
  execFileSync(javac, ["-encoding", "UTF-8", "-d", classesDir, source], { stdio: "inherit" });
  fs.rmSync(jarPath, { force: true });
  execFileSync(jar, ["cfe", jarPath, "NetcattyJdbcSidecar", "-C", classesDir, "."], { stdio: "inherit" });
  // Ship a copy next to jdbcSidecar.cjs so it lands inside app.asar: the packaged
  // app resolves the sidecar jar relative to the bridge directory.
  const packagedDir = path.join(root, "electron", "bridges", "jdbc-sidecar");
  fs.mkdirSync(packagedDir, { recursive: true });
  fs.copyFileSync(jarPath, path.join(packagedDir, path.basename(jarPath)));
  const size = fs.statSync(jarPath).size;
  console.log(`[jdbc-sidecar] built ${path.relative(root, jarPath)} (${size} bytes)`);
}

main();
