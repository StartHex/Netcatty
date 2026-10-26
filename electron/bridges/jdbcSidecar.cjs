"use strict";

/**
 * Thin JSON-free RPC over the JDBC sidecar's tab/base64 protocol.
 *
 * One long-lived java process per Netcatty session; requests are serialized
 * because a single JDBC Statement stream is not re-entrant.
 */

const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const { resolveJava } = require("./javaRuntime.cjs");

function encode(value) {
  return Buffer.from(String(value), "utf8").toString("base64");
}

function decode(value) {
  if (!value) return "";
  return Buffer.from(value, "base64").toString("utf8");
}

function parseFields(parts) {
  const fields = {};
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    fields[part.slice(0, eq)] = decode(part.slice(eq + 1));
  }
  return fields;
}

function extractBundledJar(jarInsideAsar) {
  try {
    const fs = require("node:fs");
    const os = require("node:os");
    const { app } = require("electron");
    const targetDir = path.join(app.getPath("userData"), "jdbc-sidecar");
    fs.mkdirSync(targetDir, { recursive: true });
    const target = path.join(targetDir, path.basename(jarInsideAsar));
    const source = fs.readFileSync(jarInsideAsar);
    const existing = (() => {
      try {
        return fs.readFileSync(target);
      } catch {
        return null;
      }
    })();
    if (!existing || existing.length !== source.length) fs.writeFileSync(target, source);
    return target;
  } catch {
    return undefined;
  }
}

/**
 * Paths inside app.asar look like ordinary files to fs but java cannot open
 * them, so they must be copied out before being handed to the JVM.
 */
function isInsideAsar(candidate) {
  return typeof candidate === "string" && candidate.includes(`.asar${path.sep}`);
}

/** Archive path → the real file electron-builder leaves for asarUnpack entries. */
function unpackedMirror(candidate) {
  if (!isInsideAsar(candidate)) return null;
  const marker = `.asar${path.sep}`;
  const index = candidate.indexOf(marker);
  return `${candidate.slice(0, index)}.asar.unpacked${candidate.slice(index + marker.length - 1)}`;
}

function resolveSidecarJar(options = {}) {
  const candidates = [
    options.jarPath,
    process.env.NETCATTY_JDBC_SIDECAR_JAR,
    path.join(__dirname, "jdbc-sidecar", "netcatty-jdbc-sidecar.jar"),
    path.join(process.resourcesPath || "", "jdbc-sidecar", "netcatty-jdbc-sidecar.jar"),
    path.join(__dirname, "..", "..", "dist", "jdbc-sidecar", "netcatty-jdbc-sidecar.jar"),
  ].filter(Boolean);
  const found = candidates.find((candidate) => {
    if (isInsideAsar(candidate)) return false;
    try {
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
  if (found) return found;
  // Packaged builds: asarUnpack mirrors are real files java can open directly.
  for (const candidate of candidates) {
    const mirror = unpackedMirror(candidate);
    if (!mirror) continue;
    try {
      if (fs.statSync(mirror).isFile()) return mirror;
    } catch {
      // fall through to extraction
    }
  }
  // Packaged builds keep the jar inside app.asar; java cannot open that path,
  // so copy it next to userData once and run from there.
  for (const candidate of candidates) {
    if (!isInsideAsar(candidate)) continue;
    try {
      if (fs.existsSync(candidate)) return extractBundledJar(candidate);
    } catch {
      // keep looking
    }
  }
  return undefined;
}

class JdbcSidecar {
  constructor(options = {}) {
    this.options = options;
    this.child = null;
    this.buffer = "";
    this.nextId = 1;
    this.pending = new Map();
    this.ready = null;
    this.java = null;
  }

  async start() {
    if (this.child) return { ok: true, java: this.java };
    this.java = resolveJava(this.options);
    if (!this.java.ok) return { ok: false, code: "java-not-found", error: this.java.error };
    const jar = resolveSidecarJar(this.options);
    if (!jar) {
      return {
        ok: false,
        code: "sidecar-missing",
        error: "JDBC 支撑包未安装（缺少 netcatty-jdbc-sidecar.jar）。",
      };
    }
    this.child = spawn(this.java.path, ["-jar", jar], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.onData(chunk));
    this.child.stderr.on("data", (chunk) => {
      // Keep the tail so a crash (bad class-file version, missing native lib)
      // surfaces the actual JVM message instead of a bare "process exited".
      this.stderrTail = `${this.stderrTail || ""}${chunk}`.slice(-2000);
      if (process.env.NETCATTY_DEBUG_JDBC) process.stderr.write(`[jdbc] ${chunk}`);
    });
    this.child.on("exit", (code) => this.onExit(code));
    return new Promise((resolve) => {
      this.readyResolve = resolve;
      setTimeout(() => resolve({ ok: false, code: "sidecar-timeout", error: "JDBC 进程启动超时。" }), 15000);
    });
  }

  onData(chunk) {
    this.buffer += chunk;
    let index;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, "");
      this.buffer = this.buffer.slice(index + 1);
      if (line) this.onLine(line);
    }
  }

  onLine(line) {
    const parts = line.split("\t");
    const kind = parts[0];
    const id = parts[1];
    if (kind === "READY") {
      if (this.readyResolve) {
        this.readyResolve({ ok: true, java: this.java });
        this.readyResolve = null;
      }
      return;
    }
    const entry = this.pending.get(id);
    if (!entry) return;
    if (kind === "COLS") {
      entry.columns = parts.slice(2).map((pair) => {
        const [name, type] = pair.split(":");
        return { name: decode(name), type: decode(type) };
      });
      return;
    }
    if (kind === "ROW") {
      entry.rows.push(parts.slice(2).map((cell) => (cell ? decode(cell) : null)));
      return;
    }
    this.pending.delete(id);
    if (kind === "ERR") {
      entry.resolve({
        ok: false,
        error: { message: decode(parts[2] || ""), code: "jdbc-error", sqlState: decode(parts[3] || "") },
      });
      return;
    }
    entry.resolve({
      ok: true,
      fields: parseFields(parts.slice(2)),
      columns: entry.columns,
      rows: entry.rows,
    });
  }

  onExit(code) {
    const detail = (this.stderrTail || "").trim();
    const message = detail
      ? `JDBC 进程已退出 (code ${code})：${detail.split(/\r?\n/).slice(-3).join(" ")}`
      : `JDBC 进程已退出 (code ${code})`;
    const error = {
      ok: false,
      error: { message, code: "sidecar-exit" },
    };
    for (const entry of this.pending.values()) entry.resolve(error);
    this.pending.clear();
    if (this.readyResolve) {
      this.readyResolve({ ok: false, code: "sidecar-exit", error: error.error.message });
      this.readyResolve = null;
    }
    this.child = null;
  }

  request(method, params = {}) {
    if (!this.child) return Promise.resolve({ ok: false, error: { message: "JDBC 进程未启动", code: "sidecar-exit" } });
    const id = String(this.nextId++);
    const fields = Object.entries(params)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => `${key}=${encode(value)}`);
    return new Promise((resolve) => {
      this.pending.set(id, { resolve, rows: [], columns: [] });
      this.child.stdin.write([id, method, ...fields].join("\t") + "\n");
    });
  }

  async stop() {
    if (!this.child) return;
    try {
      await this.request("SHUTDOWN");
    } catch {
      // ignore shutdown failures
    }
    try {
      this.child.stdin.end();
    } catch {
      // ignore
    }
    const child = this.child;
    this.child = null;
    setTimeout(() => {
      try {
        child.kill();
      } catch {
        // ignore
      }
    }, 500).unref?.();
  }
}

module.exports = { JdbcSidecar, resolveSidecarJar, isInsideAsar, unpackedMirror };
