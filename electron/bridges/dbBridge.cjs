"use strict";

const { readDriverClassesFromJar } = require("./jdbcJar.cjs");
const { resolveJava } = require("./javaRuntime.cjs");

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

const fs = require("fs");
const net = require("net");
const path = require("path");


/** Append length/precision to a base SQL type so the schema tree shows `char(10)`. */
function withTypeSize(type, size, scale) {
  const base = String(type || "");
  if (!base) return base;
  const sized = /char|binary|text|bit|varbinary|varchar/i.test(base);
  const numeric = /decimal|numeric|number/i.test(base);
  const length = Number(size);
  if (sized && Number.isFinite(length) && length > 0) return `${base}(${length})`;
  if (numeric && Number.isFinite(length) && length > 0) {
    const digits = Number(scale);
    return Number.isFinite(digits) && digits > 0 ? `${base}(${length},${digits})` : `${base}(${length})`;
  }
  return base;
}


let mysqlTypeNames = null;
/** mysql2 reports numeric field types; expose readable names when possible. */
function mysqlTypeName(code) {
  if (!mysqlTypeNames) {
    try {
      const { Types } = require("mysql2");
      mysqlTypeNames = new Map(Object.entries(Types).map(([name, value]) => [value, name.toLowerCase()]));
    } catch {
      mysqlTypeNames = new Map();
    }
  }
  return mysqlTypeNames.get(Number(code)) ?? String(code ?? "");
}

const CTE_STATEMENT_VERBS = new Set(["SELECT", "INSERT", "UPDATE", "DELETE", "MERGE"]);
const SQL_LEADING_NOISE = /^\s*(?:--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|\s)*/;

/**
 * Best-effort command label for a statement that returned no result set, so the
 * UI can tell an UPDATE apart from a CREATE. Drivers disagree on this: postgres
 * reports `command` itself, most others leave the caller to infer it.
 */
function commandFromSql(sql) {
  const head = String(sql || "").replace(SQL_LEADING_NOISE, "");
  const first = /^([a-zA-Z]+)/.exec(head);
  if (!first) return "OK";
  const keyword = first[1].toUpperCase();
  if (keyword !== "WITH") return keyword;
  // The verb that follows a CTE lives at paren depth 0; the SELECTs inside the
  // CTE definitions are nested, so scan depth-aware instead of regex-matching.
  let depth = 0;
  for (let index = 0; index < head.length; index += 1) {
    const char = head[index];
    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth !== 0 || index === 0 || /[A-Za-z0-9_$]/.test(head[index - 1])) continue;
    const word = /^[A-Za-z]+/.exec(head.slice(index));
    if (!word) continue;
    const upper = word[0].toUpperCase();
    if (CTE_STATEMENT_VERBS.has(upper)) return upper;
    index += word[0].length - 1;
  }
  return keyword;
}

/**
 * Shape a mysql2 query result. mysql2 returns rows (object array) for a single
 * SELECT, an OkPacket object for DML/DDL, and — because multipleStatements is
 * enabled — an array of result sets for multi-statement scripts.
 */
function shapeMysqlResult(result, fields, maxRows, startedAt, sql) {
  const fieldSets = Array.isArray(fields) ? fields : [];
  const multiStatement = Array.isArray(fieldSets[0]);

  if (multiStatement) {
    const lastResult = Array.isArray(result) ? result[result.length - 1] : result;
    const lastFields = fieldSets[fieldSets.length - 1] || [];
    if (!Array.isArray(lastResult)) {
      return {
        columns: [],
        rows: [],
        rowCount: Number(lastResult?.affectedRows ?? 0),
        truncated: false,
        command: commandFromSql(sql),
        durationMs: Date.now() - startedAt,
      };
    }
    return buildSelectResult(lastResult, lastFields, maxRows, startedAt);
  }

  // Single statement: rows for SELECT, OkPacket otherwise.
  if (!Array.isArray(result)) {
    return {
      columns: [],
      rows: [],
      rowCount: Number(result?.affectedRows ?? 0),
      truncated: false,
      command: commandFromSql(sql),
      durationMs: Date.now() - startedAt,
    };
  }
  return buildSelectResult(result, fieldSets, maxRows, startedAt);
}

function buildSelectResult(rowObjects, fields, maxRows, startedAt) {
  const columns = Array.isArray(fields) ? fields : [];
  const names = columns.map((field) => field.name);
  const sliced = rowObjects.slice(0, maxRows);
  return {
    columns: columns.map((field) => ({ name: field.name, type: mysqlTypeName(field.type) })),
    rows: rowsToMatrix(sliced, names),
    rowCount: rowObjects.length,
    truncated: sliced.length < rowObjects.length,
    command: "SELECT",
    durationMs: Date.now() - startedAt,
  };
}

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
  let message = String(error.message || error);
  // JDBC drivers that ship native libraries fail with a dlopen arch mismatch.
  // Say what to do instead of echoing the loader path.
  if (/incompatible architecture|mach-o file|dlopen\(/i.test(message)) {
    message = `${message}\n提示：该 JDBC 驱动自带的本地库与当前 Java 架构不一致（Apple Silicon 上多为 x86_64 库），请安装或指定 x86_64 的 Java（Rosetta）后重试。`;
  }
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
    async tables() {
      const instance = await ensure();
      const result = await instance.query(
        "select table_schema as schema, table_name as name, table_type as type " +
          "from information_schema.tables " +
          "where table_schema not in ('pg_catalog', 'information_schema') " +
          "order by table_schema, table_name",
      );
      return result.rows.map((row) => ({
        schema: row.schema,
        name: row.name,
        type: String(row.type || "").includes("VIEW") ? "view" : "table",
      }));
    },
    async columns(schema, table) {
      const instance = await ensure();
      const result = await instance.query(
        "select c.column_name as name, c.data_type as type, c.is_nullable as nullable, " +
          "c.character_maximum_length as size, c.numeric_precision as precision, c.numeric_scale as scale, " +
          "exists (" +
          "  select 1 from information_schema.table_constraints tc " +
          "  join information_schema.key_column_usage kcu " +
          "    on kcu.constraint_schema = tc.constraint_schema " +
          "   and kcu.constraint_name = tc.constraint_name " +
          "   and kcu.table_name = tc.table_name " +
          "  where tc.constraint_type = 'PRIMARY KEY' and tc.table_schema = c.table_schema " +
          "    and tc.table_name = c.table_name and kcu.column_name = c.column_name" +
          ") as is_pk " +
          "from information_schema.columns c where c.table_schema = $1 and c.table_name = $2 " +
          "order by c.ordinal_position",
        [schema, table],
      );
      return result.rows.map((row) => ({
        name: row.name,
        type: withTypeSize(row.type, row.size ?? row.precision, row.scale),
        nullable: row.nullable === "YES",
        primaryKey: row.is_pk === true,
      }));
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
      return shapeMysqlResult(result, fields, maxRows, started, sql);
    },
    async tables() {
      const instance = await ensure();
      const [rows] = await instance.query(
        "select table_schema as `schema`, table_name as name, table_type as type " +
          "from information_schema.tables " +
          "where table_schema not in ('mysql', 'information_schema', 'performance_schema', 'sys') " +
          "order by table_schema, table_name",
      );
      return (rows || []).map((row) => ({
        schema: row.schema,
        name: row.name,
        type: String(row.type || "").includes("VIEW") ? "view" : "table",
      }));
    },
    async columns(schema, table) {
      const instance = await ensure();
      const [rows] = await instance.query(
        "select c.column_name as name, c.column_type as type, c.is_nullable as nullable, " +
          "exists (" +
          "  select 1 from information_schema.key_column_usage kcu " +
          "  where kcu.constraint_name = 'PRIMARY' and kcu.table_schema = c.table_schema " +
          "    and kcu.table_name = c.table_name and kcu.column_name = c.column_name" +
          ") as is_pk " +
          "from information_schema.columns c where c.table_schema = ? and c.table_name = ? " +
          "order by c.ordinal_position",
        [schema, table],
      );
      return (rows || []).map((row) => ({
        name: row.name,
        type: row.type,
        nullable: row.nullable === "YES",
        primaryKey: Number(row.is_pk) === 1,
      }));
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
        command: (result.metaData || []).length > 0 ? "SELECT" : commandFromSql(sql),
        durationMs: Date.now() - started,
      };
    },
    async tables() {
      const instance = await ensure();
      const result = await instance.execute(
        "select owner as schema, table_name as name, 'table' as type from all_tables " +
          "where owner not in ('SYS', 'SYSTEM', 'XDB', 'MDSYS', 'CTXSYS', 'ORDSYS') " +
          "order by owner, table_name",
        [],
        { outFormat: oracledb.OUT_FORMAT_ARRAY, maxRows: 5000 },
      );
      return (result.rows || []).map((row) => ({
        schema: String(row[0] || ""),
        name: String(row[1] || ""),
        type: "table",
      }));
    },
    async columns(schema, table) {
      const instance = await ensure();
      const result = await instance.execute(
        "select c.column_name, c.data_type, c.nullable, c.data_length, c.char_length, c.data_precision, c.data_scale, " +
          "(select count(*) from all_cons_columns cc " +
          "  join all_constraints con on con.owner = cc.owner and con.constraint_name = cc.constraint_name " +
          "  where con.constraint_type = 'P' and cc.owner = c.owner and cc.table_name = c.table_name " +
          "    and cc.column_name = c.column_name) as pk " +
          "from all_tab_columns c where c.owner = :1 and c.table_name = :2 order by c.column_id",
        [schema, table],
        { outFormat: oracledb.OUT_FORMAT_ARRAY },
      );
      return (result.rows || []).map((row) => {
        const baseType = String(row[1] || "");
        const charLength = Number(row[4]) || Number(row[3]);
        const precision = Number(row[5]);
        const size = /char/i.test(baseType) ? charLength : precision;
        return {
          name: String(row[0] || ""),
          type: withTypeSize(baseType, size, row[6]),
          nullable: row[2] === "Y",
          primaryKey: Number(row[7]) > 0,
        };
      });
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
          command: commandFromSql(sql),
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
    async tables() {
      const rows = db
        .prepare(
          "select name, type from sqlite_master where type in ('table', 'view') " +
            "and name not like 'sqlite_%' order by name",
        )
        .all();
      return rows.map((row) => ({
        schema: "main",
        name: String(row.name),
        type: row.type === "view" ? "view" : "table",
      }));
    },
    async columns(_schema, table) {
      const rows = db.prepare(`pragma table_info(${JSON.stringify(table)})`).all();
      return rows.map((row) => ({
        name: String(row.name),
        type: String(row.type || ""),
        nullable: Number(row.notnull) === 0,
        primaryKey: Number(row.pk) > 0,
      }));
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

function createJdbcSession(target) {
  const { JdbcSidecar } = require("./jdbcSidecar.cjs");
  const { listJavaCandidates } = require("./javaRuntime.cjs");
  let sidecar = new JdbcSidecar({ javaPath: target.javaPath });
  const connId = "conn-1";
  let connecting = null;
  // x86_64-only driver libraries cannot load into an arm64 JVM. Remember which
  // runtime worked (or failed) so retries do not reopen a doomed process.
  const rejectedJava = new Set();

  const connectOn = async (instance) => {
    const started = await instance.start();
    if (!started.ok) {
      const error = new Error(started.error || "JDBC sidecar failed to start");
      error.code = started.code || "jdbc-unavailable";
      throw error;
    }
    const response = await instance.request("CONNECT", {
      connId,
      url: target.jdbcUrl,
      user: target.username,
      password: target.password,
      driverClass: target.jdbcDriverClass,
      jars: Array.isArray(target.jdbcDriverPaths)
        ? target.jdbcDriverPaths.join(require("node:path").delimiter)
        : target.jdbcDriverPaths,
    });
    if (!response.ok) {
      const error = new Error(response.error?.message || "JDBC connect failed");
      error.code = response.error?.code || "jdbc-error";
      error.sqlState = response.error?.sqlState;
      throw error;
    }
    return response.fields || {};
  };

  const isArchMismatch = (error) =>
    /incompatible architecture|mach-o file|wrong ELF class|Can't load AMD 64/i.test(
      String(error?.message || ""),
    );

  const connectWithFallback = async () => {
    try {
      return await connectOn(sidecar);
    } catch (error) {
      if (!isArchMismatch(error)) throw error;
      const currentPath = sidecar.java?.path;
      if (currentPath) rejectedJava.add(currentPath);
      for (const candidate of listJavaCandidates({})) {
        if (rejectedJava.has(candidate)) continue;
        const next = new JdbcSidecar({ javaPath: candidate });
        try {
          const fields = await connectOn(next);
          const previous = sidecar;
          sidecar = next;
          try {
            await previous.stop();
          } catch {
            /* ignore */
          }
          return fields;
        } catch (retryError) {
          rejectedJava.add(candidate);
          try {
            await next.stop();
          } catch {
            /* ignore */
          }
        }
      }
      throw error;
    }
  };

  const ensure = async () => {
    if (!connecting) {
      connecting = (async () => connectWithFallback())();
      connecting = connecting.catch((error) => {
        connecting = null;
        throw error;
      });
    }
    return connecting;
  };

  return {
    async serverVersion() {
      const fields = await ensure();
      const product = fields.product || "JDBC";
      const version = fields.version || "";
      return version ? `${product} ${version}` : product;
    },
    async query(sql, { maxRows }) {
      await ensure();
      const response = await sidecar.request("QUERY", { connId, sql, maxRows });
      if (!response.ok) {
        const error = new Error(response.error?.message || "JDBC query failed");
        error.code = response.error?.code || "jdbc-error";
        error.sqlState = response.error?.sqlState;
        throw error;
      }
      const started = Date.now();
      // Statements without a result set (INSERT/UPDATE/DDL) come back as a
      // `fields.update` tail carrying the driver's update count.
      if (response.fields?.update === "true") {
        return {
          columns: [],
          rows: [],
          rowCount: Number(response.fields?.rows || 0),
          truncated: false,
          command: commandFromSql(sql),
          durationMs: Date.now() - started,
        };
      }
      const columns = response.columns || [];
      const truncated = response.fields?.truncated === "true";
      const rows = (response.rows || []).map((row) =>
        row.map((cell) => (cell === null || cell === undefined ? null : cell)),
      );
      return {
        columns: columns.map((column) => ({ name: column.name, type: column.type })),
        rows,
        rowCount: rows.length,
        truncated,
        command: "SELECT",
        durationMs: Date.now() - started,
      };
    },
    async execute(sql) {
      await ensure();
      const response = await sidecar.request("UPDATE", { connId, sql });
      if (!response.ok) {
        const error = new Error(response.error?.message || "JDBC statement failed");
        error.code = response.error?.code || "jdbc-error";
        error.sqlState = response.error?.sqlState;
        throw error;
      }
      return { rowCount: Number(response.fields?.rows || 0) };
    },
    async tables() {
      await ensure();
      const response = await sidecar.request("METATABLES", { connId });
      if (!response.ok) {
        const error = new Error(response.error?.message || "JDBC metadata failed");
        error.code = response.error?.code || "jdbc-error";
        throw error;
      }
      return (response.rows || []).map((row) => ({
        schema: row[0] || "",
        name: row[1] || "",
        type: row[2] === "view" ? "view" : "table",
      }));
    },
    async columns(schema, table) {
      await ensure();
      const response = await sidecar.request("METACOLUMNS", { connId, schema, table });
      if (!response.ok) {
        const error = new Error(response.error?.message || "JDBC metadata failed");
        error.code = response.error?.code || "jdbc-error";
        throw error;
      }
      return (response.rows || []).map((row) => ({
        name: row[0] || "",
        type: row[1] || "",
        nullable: row[2] === "true",
        primaryKey: row[3] === "true",
      }));
    },
    async control(action) {
      await ensure();
      const method = action === "begin" ? null : action === "commit" ? "COMMIT" : "ROLLBACK";
      if (method) {
        const response = await sidecar.request(method, { connId });
        if (!response.ok) {
          const error = new Error(response.error?.message || "JDBC transaction failed");
          error.code = response.error?.code || "jdbc-error";
          throw error;
        }
      }
    },
    async cancel() {
      // The sidecar runs statements serially; cancelling is best effort.
    },
    async close() {
      try {
        if (connecting) await sidecar.request("DISCONNECT", { connId });
      } catch {
        // ignore
      }
      await sidecar.stop();
    },
  };
}


function createSqlServerSession(target) {
  const tedious = require("tedious");
  let connection = null;
  let connecting = null;

  function connect() {
    return new Promise((resolve, reject) => {
      const config = {
        server: target.host,
        authentication: {
          type: "default",
          options: { userName: target.username, password: target.password },
        },
        options: {
          port: target.port || 1433,
          database: target.database || undefined,
          encrypt: target.sslMode !== "disable",
          trustServerCertificate: target.sslMode !== "verify-ca" && target.sslMode !== "verify-full",
          rowCollectionOnRequestCompletion: true,
          useColumnNames: false,
          connectTimeout: CONNECT_TIMEOUT_MS,
          requestTimeout: 0,
        },
      };
      const instance = new tedious.Connection(config);
      instance.on("connect", (error) => {
        if (error) {
          reject(normalizeError(error));
          return;
        }
        resolve(instance);
      });
      instance.on("error", () => {
        connection = null;
      });
      instance.connect();
    });
  }

  async function ensure() {
    if (connection) return connection;
    if (connecting) return connecting;
    connecting = connect().then((instance) => {
      connection = instance;
      return instance;
    });
    try {
      return await connecting;
    } finally {
      connecting = null;
    }
  }

  function exec(instance, sql, maxRows) {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const request = new tedious.Request(sql, (error, rowCount, rows) => {
        if (error) {
          reject(normalizeError(error));
          return;
        }
        const collected = rows || [];
        const columns = (collected[0] || []).map((cell) => ({
          name: cell.metadata.colName,
          type: cell.metadata.type?.name,
        }));
        const matrix = collected
          .slice(0, maxRows)
          .map((row) => row.map((cell) => toCellValue(cell.value)));
        resolve({
          columns,
          rows: matrix,
          rowCount: Number.isFinite(rowCount) ? rowCount : matrix.length,
          truncated: matrix.length < collected.length || (rowCount || 0) > matrix.length,
          command: /^\s*(select|show|with)/i.test(sql) ? "SELECT" : commandFromSql(sql),
          durationMs: Date.now() - started,
        });
      });
      instance.execSql(request);
    });
  }

  return {
    kind: "sqlserver",
    ensure,
    async serverVersion() {
      const instance = await ensure();
      const result = await exec(instance, "select @@version as version", 1);
      return String(result.rows?.[0]?.[0] || "");
    },
    async query(sql, { maxRows }) {
      const instance = await ensure();
      return exec(instance, sql, maxRows);
    },
    async tables() {
      const instance = await ensure();
      const result = await exec(
        instance,
        "select table_schema as [schema], table_name as [name], table_type as [type] " +
          "from information_schema.tables order by table_schema, table_name",
        HARD_MAX_ROWS,
      );
      return result.rows.map((row) => ({
        schema: String(row[0] || ""),
        name: String(row[1] || ""),
        type: /view/i.test(String(row[2] || "")) ? "view" : "table",
      }));
    },
    async columns(schema, table) {
      const instance = await ensure();
      const escapedSchema = String(schema || "dbo").replace(/'/g, "''");
      const escapedTable = String(table || "").replace(/'/g, "''");
      const result = await exec(
        instance,
        "select c.column_name as [name], c.data_type as [type], c.is_nullable as [nullable], " +
          "c.character_maximum_length as [size], c.numeric_precision as [precision], c.numeric_scale as [scale], " +
          "case when exists (" +
          "  select 1 from information_schema.table_constraints tc " +
          "  join information_schema.key_column_usage kcu " +
          "    on kcu.constraint_name = tc.constraint_name and kcu.table_schema = tc.table_schema " +
          "  where tc.constraint_type = 'PRIMARY KEY' and tc.table_schema = c.table_schema " +
          "    and tc.table_name = c.table_name and kcu.column_name = c.column_name" +
          ") then 1 else 0 end as [is_pk] " +
          `from information_schema.columns c where c.table_schema = '${escapedSchema}' and c.table_name = '${escapedTable}' ` +
          "order by c.ordinal_position",
        HARD_MAX_ROWS,
      );
      return result.rows.map((row) => ({
        name: String(row[0] || ""),
        type: withTypeSize(row[1], row.size ?? row.precision, row.scale),
        nullable: String(row[2] || "").toUpperCase() === "YES",
        primaryKey: Number(row[6]) === 1,
      }));
    },
    async control() {
      throw Object.assign(new Error("Transactions are managed by SQL Server itself"), {
        code: "control-unsupported",
      });
    },
    async cancel() {
      // tedious has no per-request cancel; closing the session is the escape hatch.
    },
    async close() {
      if (connection) {
        try {
          connection.close();
        } catch {
          // ignore
        }
        connection = null;
      }
    },
  };
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
    case "sqlserver":
      return createSqlServerSession;
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

/** Very small SQL splitter: enough for init scripts, not a full parser. */
function splitSqlStatements(script) {
  const statements = [];
  let current = "";
  let quote = null;
  for (let index = 0; index < script.length; index += 1) {
    const char = script[index];
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      current += char;
      continue;
    }
    if (char === "-" && script[index + 1] === "-") {
      const end = script.indexOf("\n", index);
      index = end === -1 ? script.length : end;
      continue;
    }
    if (char === ";") {
      if (current.trim()) statements.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
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
      ready: Promise.resolve(),
      initError: null,
      async close() {
        await session.close();
        sessions.delete(key);
      },
    };
    if (typeof target.initSql === "string" && target.initSql.trim()) {
      entry.ready = entry
        .run(async () => {
          for (const statement of splitSqlStatements(target.initSql)) {
            await session.query(statement, { maxRows: 1 });
          }
        })
        .catch((error) => {
          entry.initError = normalizeError(error);
        });
    }
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
      await entry.ready;
      if (entry.initError) throw entry.initError;
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
      await entry.ready;
      if (entry.initError) throw entry.initError;
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
      await entry.ready;
      if (entry.initError) throw entry.initError;
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

  async tables({ target }) {
    let entry;
    try {
      entry = getSession(target);
    } catch (error) {
      return failure(error);
    }
    try {
      const tables = await entry.run(() => entry.session.tables());
      return { ok: true, tables };
    } catch (error) {
      return failure(error);
    }
  },

  async columns({ target, schema, table }) {
    if (!table || typeof table !== "string") {
      return failure(new Error("Table name is required"));
    }
    let entry;
    try {
      entry = getSession(target);
    } catch (error) {
      return failure(error);
    }
    try {
      const columns = await entry.run(() => entry.session.columns(schema, table));
      return { ok: true, columns };
    } catch (error) {
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

const MAX_SQL_FILE_BYTES = 5 * 1024 * 1024;

/** Reports the Java runtime the JDBC sidecar would use, for the editor hint. */
function javaRuntimeInfo(payload) {
  return resolveJava({ javaPath: payload?.javaPath, javaHome: payload?.javaHome });
}

/** Lists the JDBC driver classes declared by a driver jar. */
function driverClassesFromJar(payload) {
  const jarPath = payload?.jarPath;
  if (typeof jarPath !== "string" || !jarPath) return { ok: true, classes: [] };
  try {
    return { ok: true, classes: readDriverClassesFromJar(jarPath) };
  } catch (error) {
    return { ok: false, classes: [], error: { message: error?.message || String(error) } };
  }
}

/** Reads a .sql script picked by the renderer; bounded so a huge file can't block. */
async function readSqlFile(rawPath) {
  const filePath = typeof rawPath === "string" ? rawPath : rawPath?.path;
  if (!filePath) return { ok: false, error: "missing-path" };
  try {
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) return { ok: false, error: "not-a-file" };
    if (stat.size > MAX_SQL_FILE_BYTES) return { ok: false, error: "too-large" };
    const text = await fs.promises.readFile(filePath, "utf8");
    return { ok: true, text, path: filePath };
  } catch (error) {
    return { ok: false, error: error?.code || error?.message || "read-failed" };
  }
}

const MAX_TEXT_FILE_BYTES = 20 * 1024 * 1024;
const MAX_BINARY_FILE_BYTES = 64 * 1024 * 1024;

/** Saves a text file the renderer produced (exports, DDL dumps). */
async function saveTextFile(payload) {
  const { defaultName, content } = payload || {};
  if (typeof content !== "string") return { ok: false, error: "nothing-to-save" };
  if (Buffer.byteLength(content, "utf8") > MAX_TEXT_FILE_BYTES) {
    return { ok: false, error: "too-large" };
  }
  try {
    const { dialog } = require("electron");
    const result = await dialog.showSaveDialog({
      defaultPath: typeof defaultName === "string" ? defaultName : undefined,
    });
    if (result.canceled || !result.filePath) return { ok: true, canceled: true };
    await fs.promises.writeFile(result.filePath, content, "utf8");
    return { ok: true, path: result.filePath };
  } catch (error) {
    return { ok: false, error: error?.message || "write-failed" };
  }
}

/**
 * Saves a binary export (xlsx and friends). The renderer hands over base64
 * because IPC serialises strings, and main converts it back to bytes.
 */
async function saveBinaryFile(payload) {
  const { defaultName, base64 } = payload || {};
  if (typeof base64 !== "string" || base64.length === 0) {
    return { ok: false, error: "nothing-to-save" };
  }
  const buffer = Buffer.from(base64, "base64");
  if (buffer.byteLength > MAX_BINARY_FILE_BYTES) {
    return { ok: false, error: "too-large" };
  }
  try {
    const { dialog } = require("electron");
    const result = await dialog.showSaveDialog({
      defaultPath: typeof defaultName === "string" ? defaultName : undefined,
    });
    if (result.canceled || !result.filePath) return { ok: true, canceled: true };
    await fs.promises.writeFile(result.filePath, buffer);
    return { ok: true, path: result.filePath };
  } catch (error) {
    return { ok: false, error: error?.message || "write-failed" };
  }
}

function registerDbHandlers(ipcMain) {
  ipcMain.handle("netcatty:db:test", (_event, target) => handlers.test(target));
  ipcMain.handle("netcatty:db:connect", (_event, target) => handlers.connect(target));
  ipcMain.handle("netcatty:db:query", (_event, payload) => handlers.query(payload || {}));
  ipcMain.handle("netcatty:db:control", (_event, payload) => handlers.control(payload || {}));
  ipcMain.handle("netcatty:db:tables", (_event, payload) => handlers.tables(payload || {}));
  ipcMain.handle("netcatty:db:columns", (_event, payload) => handlers.columns(payload || {}));
  ipcMain.handle("netcatty:db:cancel", (_event, payload) => handlers.cancel(payload || {}));
  ipcMain.handle("netcatty:db:disconnect", (_event, payload) => handlers.disconnect(payload || {}));
  ipcMain.handle("netcatty:db:dispose", () => handlers.dispose());
  ipcMain.handle("netcatty:db:read-sql-file", (_event, payload) => readSqlFile(payload));
  ipcMain.handle("netcatty:db:save-text-file", (_event, payload) => saveTextFile(payload));
  ipcMain.handle("netcatty:db:save-binary-file", (_event, payload) => saveBinaryFile(payload));
  ipcMain.handle("netcatty:db:driver-classes", (_event, payload) => driverClassesFromJar(payload));
  ipcMain.handle("netcatty:db:java-runtime", (_event, payload) => javaRuntimeInfo(payload));
}

module.exports = {
  registerDbHandlers,
  handlers,
  readSqlFile,
  saveBinaryFile,
  __test: {
    clampMaxRows,
    clampTimeout,
    toCellValue,
    normalizeError,
    pgSslOptions,
    mysqlSslOptions,
    rowsToMatrix,
    numberOrUndefined,
    shapeMysqlResult,
    mysqlTypeName,
    commandFromSql,
    sessions,
  },
};
