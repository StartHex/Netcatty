"use strict";

/**
 * Database bridge — main-process side of the SQL workbench.
 *
 * Drivers are loaded lazily so a missing native dependency only breaks the
 * affected database kind instead of the whole app. Connections are pooled per
 * connection id (one live session at a time, queries serialized), and every
 * handler returns a plain JSON object the renderer can render directly.
 *
 * Security: the renderer resolves credentials (vault decryption, SSH auth) and
 * passes them per call. Nothing is persisted here.
 */

const net = require("net");
const path = require("path");

const DEFAULT_MAX_ROWS = 1000;
const HARD_MAX_ROWS = 5000;
const DEFAULT_TIMEOUT_MS = 30000;
const CONNECT_TIMEOUT_MS = 15000;

const sessions = new Map();

// ---------------------------------------------------------------------------
// Small helpers (exported for tests)
// ---------------------------------------------------------------------------

function clampMaxRows(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_ROWS;
  return Math.min(Math.trunc(n), HARD_MAX_ROWS);
}

function clampTimeout(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.trunc(n), 10 * 60 * 1000);
}

function toCellValue(value) {
  if (value === null || value === undefined) return null;
  const type = typeof value;
  if (type === "string" || type === "boolean") return value;
  if (type === "number") return Number.isFinite(value) ? value : String(value);
  if (type === "bigint") {
    const asNumber = Number(value);
    return Number.isSafeInteger(asNumber) ? asNumber : value.toString();
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return Buffer.from(value).toString("base64");
  }
  if (Array.isArray(value)) return value.map(toCellValue);
  if (type === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function normalizeError(error) {
  if (!error) return { message: "Unknown database error" };
  const message = String(error.message || error);
  return {
    message,
    code: typeof error.code === "string" ? error.code : undefined,
    sqlState: typeof error.sqlState === "string" ? error.sqlState : undefined,
    position:
      typeof error.position === "number" || typeof error.position === "string"
        ? error.position
        : undefined,
    detail: typeof error.detail === "string" ? error.detail : undefined,
    hint: typeof error.hint === "string" ? error.hint : undefined,
  };
}

function failure(error) {
  return { ok: false, error: normalizeError(error) };
}

/** Map generic sslMode to pg-style ssl options. */
function pgSslOptions(mode) {
  switch (mode) {
    case "disable":
      return false;
    case "require":
    case "prefer":
      return { rejectUnauthorized: false };
    case "verify-ca":
      return { rejectUnauthorized: true };
    case "verify-full":
      return { rejectUnauthorized: true };
    default:
      return undefined;
  }
}

/** Map generic sslMode to mysql2-style ssl options. */
function mysqlSslOptions(mode) {
  switch (mode) {
    case "disable":
      return undefined;
    case "require":
    case "prefer":
      return { rejectUnauthorized: false };
    case "verify-ca":
    case "verify-full":
      return { rejectUnauthorized: true };
    default:
      return undefined;
  }
}

function rowsToMatrix(rows, columnNames) {
  return rows.map((row) => columnNames.map((name) => toCellValue(row?.[name])));
}

function numberOrUndefined(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

// ---------------------------------------------------------------------------
// Driver sessions
// ---------------------------------------------------------------------------

function createPgSession(target) {
  const { Client } = require("pg");
  let client = null;
  let connecting = null;

  async function ensure() {
    if (client) return client;
    if (connecting) return connecting;
    connecting = (async () => {
      const instance = new Client({
        host: target.host,
        port: target.port,
        database: target.database,
        user: target.username,
        password: target.password,
        ssl: pgSslOptions(target.sslMode),
        connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
        keepAlive: true,
        application_name: "Netcatty",
      });
      instance.on("error", () => {
        client = null;
      });
      await instance.connect();
      client = instance;
      return instance;
    })();
    try {
      return await connecting;
    } finally {
      connecting = null;
    }
  }

  return {
    kind: "postgresql",
    ensure,
    async serverVersion() {
      const instance = await ensure();
      const result = await instance.query("select version() as version");
      return String(result.rows?.[0]?.version || "");
    },
    async query(sql, { maxRows }) {
      const instance = await ensure();
      const started = Date.now();
      const result = await instance.query(sql);
      const results = Array.isArray(result) ? result : [result];
      const last = results[results.length - 1] || {};
      const fields = last.fields || [];
      const names = fields.map((field) => field.name);
      const rows = (last.rows || []).slice(0, maxRows).map((row) => names.map((name) => toCellValue(row[name])));
      const total = Number.isFinite(last.rowCount) ? last.rowCount : rows.length;
      return {
        columns: fields.map((field) => ({ name: field.name, type: String(field.dataTypeID ?? "") })),
        rows,
        rowCount: total,
        truncated: rows.length < (last.rows?.length || 0) || total > rows.length,
        command: last.command,
        durationMs: Date.now() - started,
      };
    },
    async control(action) {
      const instance = await ensure();
      const statement =
        action === "begin" ? "BEGIN" : action === "commit" ? "COMMIT" : "ROLLBACK";
      await instance.query(statement);
    },
    cancel() {
      try {
        client?.connection?.stream?.destroy();
      } catch {
        /* ignore */
      }
      client = null;
    },
    async close() {
      const instance = client;
      client = null;
      if (!instance) return;
      try {
        await instance.end();
      } catch {
        try {
          instance.connection?.stream?.destroy();
        } catch {
          /* ignore */
        }
      }
    },
  };
}

function createMysqlSession(target) {
  const mysql = require("mysql2/promise");
  let connection = null;
  let connecting = null;

  async function ensure() {
    if (connection) return connection;
    if (connecting) return connecting;
    connecting = (async () => {
      const instance = await mysql.createConnection({
        host: target.host,
        port: target.port,
        user: target.username,
        password: target.password,
        database: target.database,
        ssl: mysqlSslOptions(target.sslMode),
        connectTimeout: CONNECT_TIMEOUT_MS,
        multipleStatements: true,
        dateStrings: false,
        supportBigNumbers: true,
        bigNumberStrings: false,
      });
      connection = instance;
      return instance;
    })();
    try {
      return await connecting;
    } finally {
      connecting = null;
    }
  }

  return {
    kind: "mysql",
    ensure,
    async serverVersion() {
      const instance = await ensure();
      const [rows] = await instance.query("select version() as version");
      return String(rows?.[0]?.version || "");
    },
    async query(sql, { maxRows }) {
      const instance = await ensure();
      const started = Date.now();
      const [result, fields] = await instance.query(sql);
      const packets = Array.isArray(result) ? result : [result];
      const fieldList = Array.isArray(fields) ? fields : [];
      const lastPacket = packets[packets.length - 1];

      // INSERT/UPDATE/DDL: mysql2 returns an OkPacket (no rows).
      if (!Array.isArray(lastPacket)) {
        return {
          columns: [],
          rows: [],
          rowCount: Number(lastPacket?.affectedRows ?? 0),
          truncated: false,
          command: "OK",
          durationMs: Date.now() - started,
        };
      }

      // SELECT with multiple statements: fields is an array of field arrays.
      let columns = fieldList;
      if (Array.isArray(fieldList[0])) {
        columns = fieldList[fieldList.length - 1] || [];
      }
      const names = columns.map((field) => field.name);
      const sliced = lastPacket.slice(0, maxRows);
      return {
        columns: columns.map((field) => ({ name: field.name, type: String(field.type ?? "") })),
        rows: rowsToMatrix(sliced, names),
        rowCount: lastPacket.length,
        truncated: sliced.length < lastPacket.length,
        command: "SELECT",
        durationMs: Date.now() - started,
      };
    },
    cancel() {
      try {
        connection?.destroy?.();
      } catch {
        /* ignore */
      }
      connection = null;
    },
    async control(action) {
      const instance = await ensure();
      if (action === "begin") await instance.beginTransaction();
      else if (action === "commit") await instance.commit();
      else await instance.rollback();
    },
    async close() {
      const instance = connection;
      connection = null;
      if (!instance) return;
      try {
        await instance.end();
      } catch {
        try {
          instance.destroy?.();
        } catch {
          /* ignore */
        }
      }
    },
  };
}

function createOracleSession(target) {
  const oracledb = require("oracledb");
  let connection = null;
  let connecting = null;

  function connectString() {
    const port = target.port || 1521;
    const service = target.database || "ORCL";
    return `${target.host}:${port}/${service}`;
  }

  async function ensure() {
    if (connection) return connection;
    if (connecting) return connecting;
    connecting = (async () => {
      oracledb.outFormat = oracledb.OUT_FORMAT_ARRAY;
      const instance = await oracledb.getConnection({
        user: target.username,
        password: target.password,
        connectString: connectString(),
      });
      connection = instance;
      return instance;
    })();
    try {
      return await connecting;
    } finally {
      connecting = null;
    }
  }

  return {
    kind: "oracle",
    ensure,
    async serverVersion() {
      const instance = await ensure();
      const result = await instance.execute("select banner from v$version where rownum = 1");
      return String(result.rows?.[0]?.[0] || "");
    },
    async query(sql, { maxRows }) {
      const instance = await ensure();
      const started = Date.now();
      const result = await instance.execute(sql, [], {
        outFormat: oracledb.OUT_FORMAT_ARRAY,
        maxRows,
        fetchArraySize: Math.min(maxRows, 200),
      });
      const names = (result.metaData || []).map((meta) => meta.name);
      const rows = (result.rows || []).map((row) => row.map(toCellValue));
      return {
        columns: (result.metaData || []).map((meta) => ({ name: meta.name, type: meta.dbTypeName || "" })),
        rows,
        rowCount: Number.isFinite(result.rowsAffected) && result.rowsAffected > 0
          ? result.rowsAffected
          : rows.length,
        truncated: rows.length >= maxRows,
        command: "SELECT",
        durationMs: Date.now() - started,
      };
    },
    async control(action) {
      const instance = await ensure();
      if (action === "commit") await instance.commit();
      else if (action === "rollback") await instance.rollback();
      // Oracle starts a transaction implicitly on the first DML statement.
    },
    cancel() {
      try {
        connection?.break?.(() => {});
      } catch {
        /* ignore */
      }
    },
    async close() {
      const instance = connection;
      connection = null;
      if (!instance) return;
      try {
        await instance.close();
      } catch {
        /* ignore */
      }
    },
  };
}

function createSqliteSession(target) {
  let DatabaseSync = null;
  try {
    ({ DatabaseSync } = require("node:sqlite"));
  } catch {
    throw new Error("SQLite support is unavailable in this build (node:sqlite missing)");
  }

  const file = target.sqlitePath || ":memory:";
  const db = new DatabaseSync(file);

  return {
    kind: "sqlite",
    ensure: async () => db,
    async serverVersion() {
      const row = db.prepare("select sqlite_version() as version").get();
      return String(row?.version || "");
    },
    async query(sql, { maxRows }) {
      const started = Date.now();
      const statement = db.prepare(sql);
      const columns = typeof statement.columns === "function" ? statement.columns() : [];
      if (columns.length === 0) {
        const info = statement.run();
        return {
          columns: [],
          rows: [],
          rowCount: Number(info?.changes ?? 0),
          truncated: false,
          command: "OK",
          durationMs: Date.now() - started,
        };
      }
      const names = columns.map((column) => column.name);
      const all = statement.all();
      const sliced = all.slice(0, maxRows);
      return {
        columns: columns.map((column) => ({ name: column.name, type: column.type || "" })),
        rows: sliced.map((row) => names.map((name) => toCellValue(row[name]))),
        rowCount: all.length,
        truncated: sliced.length < all.length,
        command: "SELECT",
        durationMs: Date.now() - started,
      };
    },
    async control(action) {
      const statement =
        action === "begin" ? "BEGIN" : action === "commit" ? "COMMIT" : "ROLLBACK";
      db.exec(statement);
    },
    cancel() {
      /* synchronous driver: nothing to cancel */
    },
    async close() {
      db.close();
    },
  };
}

async function createJdbcSession() {
  const error = new Error(
    "JDBC connections need the Java sidecar, which is not enabled in this build yet",
  );
  error.code = "jdbc-unavailable";
  throw error;
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

function driverFor(kind) {
  switch (kind) {
    case "postgresql":
      return createPgSession;
    case "mysql":
    case "mariadb":
      return createMysqlSession;
    case "oracle":
      return createOracleSession;
    case "sqlite":
      return createSqliteSession;
    case "jdbc":
      return createJdbcSession;
    default: {
      const error = new Error(`Unsupported database kind: ${kind}`);
      error.code = "unsupported-kind";
      throw error;
    }
  }
}

function targetKey(target) {
  return target.id || [
    target.kind,
    target.host,
    target.port,
    target.database,
    target.username,
    target.sqlitePath,
  ].join("|");
}

function getSession(target) {
  const key = targetKey(target);
  let entry = sessions.get(key);
  if (!entry) {
    const session = driverFor(target.kind)(target);
    let chain = Promise.resolve();
    entry = {
      session,
      target,
      run(task) {
        const next = chain.then(task, task);
        // Keep the chain alive after failures so later queries still run.
        chain = next.catch(() => {});
        return next;
      },
      async close() {
        await session.close();
        sessions.delete(key);
      },
    };
    sessions.set(key, entry);
  }
  return entry;
}

function withTimeout(promise, ms, onTimeout) {
  let timer = null;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      try {
        onTimeout?.();
      } catch {
        /* ignore */
      }
      const error = new Error(`Query timed out after ${ms} ms`);
      error.code = "query-timeout";
      reject(error);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

const handlers = {
  async test(target) {
    const started = Date.now();
    let entry;
    try {
      entry = getSession(target);
    } catch (error) {
      return failure(error);
    }
    try {
      const serverVersion = await entry.run(() => entry.session.serverVersion());
      return { ok: true, durationMs: Date.now() - started, serverVersion };
    } catch (error) {
      return failure(error);
    } finally {
      await entry.close().catch(() => {});
    }
  },

  async connect(target) {
    const started = Date.now();
    let entry;
    try {
      entry = getSession(target);
    } catch (error) {
      return failure(error);
    }
    try {
      const serverVersion = await entry.run(() => entry.session.serverVersion());
      return { ok: true, durationMs: Date.now() - started, serverVersion };
    } catch (error) {
      await entry.close().catch(() => {});
      return failure(error);
    }
  },

  async query({ target, sql, maxRows, timeoutMs }) {
    if (!sql || typeof sql !== "string" || !sql.trim()) {
      return failure(new Error("Empty SQL statement"));
    }
    let entry;
    try {
      entry = getSession(target);
    } catch (error) {
      return failure(error);
    }
    const limit = clampMaxRows(maxRows);
    const timeout = clampTimeout(timeoutMs);
    try {
      const result = await entry.run(() =>
        withTimeout(entry.session.query(sql, { maxRows: limit }), timeout, () => entry.session.cancel()),
      );
      return { ok: true, result };
    } catch (error) {
      if (error?.code === "query-timeout") {
        await entry.close().catch(() => {});
      }
      return failure(error);
    }
  },

  async control({ target, action }) {
    if (!["begin", "commit", "rollback"].includes(action)) {
      return failure(new Error(`Unsupported transaction action: ${action}`));
    }
    let entry;
    try {
      entry = getSession(target);
    } catch (error) {
      return failure(error);
    }
    try {
      await entry.run(() => entry.session.control(action));
      return { ok: true, action };
    } catch (error) {
      return failure(error);
    }
  },

  async cancel({ id }) {
    const entry = sessions.get(id);
    if (!entry) return { ok: true };
    entry.session.cancel();
    return { ok: true };
  },

  async disconnect({ id }) {
    const entry = sessions.get(id);
    if (!entry) return { ok: true };
    await entry.close().catch(() => {});
    return { ok: true };
  },

  async dispose() {
    const entries = Array.from(sessions.values());
    sessions.clear();
    await Promise.all(entries.map((entry) => entry.session.close().catch(() => {})));
    return { ok: true };
  },
};

function registerDbHandlers(ipcMain) {
  ipcMain.handle("netcatty:db:test", (_event, target) => handlers.test(target));
  ipcMain.handle("netcatty:db:connect", (_event, target) => handlers.connect(target));
  ipcMain.handle("netcatty:db:query", (_event, payload) => handlers.query(payload || {}));
  ipcMain.handle("netcatty:db:control", (_event, payload) => handlers.control(payload || {}));
  ipcMain.handle("netcatty:db:cancel", (_event, payload) => handlers.cancel(payload || {}));
  ipcMain.handle("netcatty:db:disconnect", (_event, payload) => handlers.disconnect(payload || {}));
  ipcMain.handle("netcatty:db:dispose", () => handlers.dispose());
}

module.exports = {
  registerDbHandlers,
  handlers,
  __test: {
    clampMaxRows,
    clampTimeout,
    toCellValue,
    normalizeError,
    pgSslOptions,
    mysqlSslOptions,
    rowsToMatrix,
    numberOrUndefined,
    sessions,
  },
};
