"use strict";

/**
 * Locate a usable JRE for the JDBC sidecar.
 *
 * Order: explicit settings override, NETCATTY_JAVA_HOME, JAVA_HOME, PATH,
 * per-platform install locations, then JREs bundled with tools the user may
 * already run (DBeaver, JetBrains IDEs). A candidate only counts after
 * `java -version` succeeds and reports Java 17+, so a broken symlink or a Java 8
 * runtime never looks healthy.
 */

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");

const MIN_JAVA_MAJOR = 17;
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

/** "21.0.13" → 21, "1.8.0_402" → 8. Returns 0 when unparseable. */
function parseJavaMajor(versionLine) {
  const match = /version\s+"(\d+)(?:\.(\d+))?/.exec(versionLine || "");
  if (!match) return 0;
  const major = Number(match[1]);
  if (major === 1) return Number(match[2] || 0);
  return major;
}

function probe(binary) {
  const result = spawnSync(binary, ["-version"], {
    encoding: "utf8",
    timeout: 8000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    return { ok: false, error: result.error.message };
  }
  if (result.status !== 0) {
    return { ok: false, error: `exit ${result.status}` };
  }
  const text = `${result.stderr || ""}\n${result.stdout || ""}`;
  const versionLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /version\s+"/.test(line)) || "";
  const major = parseJavaMajor(versionLine);
  if (major < MIN_JAVA_MAJOR) {
    return { ok: false, tooOld: true, major, version: versionLine };
  }
  return { ok: true, version: versionLine || "java", major };
}

/** Homebrew links are symlinks, so treat them as directories too. */
function isDirLike(entry) {
  return entry.isDirectory() || entry.isSymbolicLink();
}

function readDirSafe(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function expandHomeDirs(root, filter) {
  const homes = [];
  for (const entry of readDirSafe(root)) {
    if (!isDirLike(entry)) continue;
    if (filter && !filter(entry.name)) continue;
    homes.push(path.join(root, entry.name));
  }
  return homes;
}

/** JREs shipped inside other desktop tools; avoids asking the user to install one. */
function bundledJreHomes() {
  const homes = [];
  if (process.platform === "darwin") {
    homes.push("/Applications/DBeaver.app/Contents/Eclipse/jre/Contents/Home");
    for (const entry of readDirSafe("/Applications")) {
      if (!entry.isDirectory()) continue;
      if (/^IntelliJ IDEA/.test(entry.name) || entry.name === "Android Studio") {
        homes.push(`/Applications/${entry.name}/Contents/jbr/Contents/Home`);
      }
    }
    return homes;
  }
  if (process.platform === "win32") {
    const programFiles = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]].filter(Boolean);
    for (const root of programFiles) {
      homes.push(path.join(root, "DBeaver", "jre"));
      homes.push(path.join(root, "DBeaverEE", "jre"));
    }
    if (process.env.LOCALAPPDATA) {
      homes.push(path.join(process.env.LOCALAPPDATA, "DBeaver", "jre"));
      homes.push(path.join(process.env.LOCALAPPDATA, "Programs", "DBeaver", "jre"));
      const toolbox = path.join(process.env.LOCALAPPDATA, "JetBrains", "Toolbox", "apps");
      for (const product of readDirSafe(toolbox).slice(0, 12)) {
        if (!product.isDirectory()) continue;
        const productDir = path.join(toolbox, product.name);
        for (const build of readDirSafe(productDir).slice(0, 6)) {
          if (!build.isDirectory()) continue;
          homes.push(path.join(productDir, build.name, "jbr"));
        }
      }
    }
    return homes;
  }
  homes.push(
    "/usr/share/dbeaver/jre",
    "/usr/share/dbeaver-ce/jre",
    "/opt/dbeaver/jre",
    "/opt/dbeaver-ce/jre",
  );
  return homes;
}

function defaultHomes() {
  if (process.platform === "darwin") {
    const homes = [];
    for (const root of [
      "/Library/Java/JavaVirtualMachines",
      path.join(os.homedir(), "Library", "Java", "JavaVirtualMachines"),
    ]) {
      homes.push(...expandHomeDirs(root).map((home) => path.join(home, "Contents", "Home")));
    }
    for (const root of ["/opt/homebrew/opt", "/usr/local/opt"]) {
      for (const entry of readDirSafe(root)) {
        if (isDirLike(entry) && /^openjdk/.test(entry.name)) {
          homes.push(path.join(root, entry.name, "libexec", "openjdk.jdk", "Contents", "Home"));
        }
      }
    }
    return homes.sort().reverse();
  }
  if (process.platform === "win32") {
    const roots = [
      process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Java"),
      process.env["ProgramFiles(x86)"] && path.join(process.env["ProgramFiles(x86)"], "Java"),
      process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Eclipse Adoptium"),
      process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Eclipse Foundation"),
      process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Microsoft"),
      process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Zulu"),
      process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Amazon Corretto"),
      process.env.ProgramFiles && path.join(process.env.ProgramFiles, "BellSoft"),
      process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Semeru"),
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "Eclipse Adoptium"),
    ].filter(Boolean);
    const homes = [];
    for (const root of roots) {
      for (const entry of readDirSafe(root)) {
        if (!entry.isDirectory()) continue;
        const candidate = path.join(root, entry.name);
        homes.push(candidate);
        // Vendor roots nest one level further (jdk-21.0.x, jdk-21.0.x+y).
        for (const nested of readDirSafe(candidate)) {
          if (nested.isDirectory() && /^jdk/i.test(nested.name)) {
            homes.push(path.join(candidate, nested.name));
          }
        }
      }
    }
    return homes.sort().reverse();
  }
  return expandHomeDirs("/usr/lib/jvm").sort().reverse();
}

function resolveJava(options = {}) {
  const key = `${options.javaHome || ""}|${options.javaPath || ""}`;
  if (cache.has(key)) return cache.get(key);

  const tried = [];
  let sawTooOld = null;
  const explicit = [];
  if (options.javaPath) explicit.push(options.javaPath);
  if (options.javaHome) explicit.push(javaBinaryIn(options.javaHome));
  if (process.env.NETCATTY_JAVA_HOME) explicit.push(javaBinaryIn(process.env.NETCATTY_JAVA_HOME));
  if (process.env.JAVA_HOME) explicit.push(javaBinaryIn(process.env.JAVA_HOME));
  const candidates = [...explicit];
  candidates.push(process.platform === "win32" ? "java.exe" : "java");
  for (const home of defaultHomes()) candidates.push(javaBinaryIn(home));
  for (const home of bundledJreHomes()) candidates.push(javaBinaryIn(home));

  for (const candidate of candidates.filter(Boolean)) {
    const isBareCommand = !candidate.includes(path.sep) && !candidate.includes("/");
    if (!isBareCommand && !isExecutableFile(candidate)) continue;
    tried.push(candidate);
    const result = probe(candidate);
    if (result.ok) {
      const resolved = { ok: true, path: candidate, version: result.version, major: result.major, tried };
      cache.set(key, resolved);
      return resolved;
    }
    if (result.tooOld) {
      sawTooOld = { path: candidate, version: result.version, major: result.major };
      // An explicitly configured runtime is authoritative: report it instead of
      // silently switching to a different Java the user did not pick.
      if (explicit.includes(candidate)) break;
    }
  }
  const resolved = {
    ok: false,
    tried,
    foundButTooOld: sawTooOld,
    error: sawTooOld
      ? `检测到 Java ${sawTooOld.major}（${sawTooOld.path}），但数据库工作台需要 Java ${MIN_JAVA_MAJOR}+。请安装 Temurin 17/21，或在数据库连接的「Java 路径」里填 java 可执行文件。`
      : `未找到可用的 Java 运行时（需要 Java ${MIN_JAVA_MAJOR}+）。请安装 Temurin 17/21，或在数据库连接的「Java 路径」里填 java 可执行文件（Windows 如 C:\\Program Files\\Java\\jdk-21\\bin\\java.exe）。`,
  };
  cache.set(key, resolved);
  return resolved;
}

module.exports = { resolveJava, parseJavaMajor, isDirLike, MIN_JAVA_MAJOR };
