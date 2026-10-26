"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const zlib = require("node:zlib");

const { handlers, MAX_BODY_BYTES, __test } = require("./httpBridge.cjs");

let server;
let baseUrl;

const listen = () =>
  new Promise((resolve) => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname === "/json") {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "X-Trace": "trace-1" });
        res.end(JSON.stringify({ ok: true, path: "/json" }));
        return;
      }
      if (url.pathname === "/echo") {
        const chunks = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ method: req.method, body, auth: req.headers.authorization ?? null }));
        });
        return;
      }
      if (url.pathname === "/redirect") {
        res.writeHead(302, { Location: "/json" });
        res.end();
        return;
      }
      if (url.pathname === "/loop") {
        res.writeHead(302, { Location: "/loop" });
        res.end();
        return;
      }
      if (url.pathname === "/gzip") {
        const payload = zlib.gzipSync(Buffer.from(JSON.stringify({ compressed: true })));
        res.writeHead(200, { "Content-Type": "application/json", "Content-Encoding": "gzip" });
        res.end(payload);
        return;
      }
      if (url.pathname === "/binary") {
        res.writeHead(200, { "Content-Type": "application/octet-stream" });
        res.end(Buffer.from([0, 1, 2, 3, 255]));
        return;
      }
      if (url.pathname === "/slow") {
        setTimeout(() => {
          res.writeHead(200, { "Content-Type": "text/plain" });
          res.end("late");
        }, 3000);
        return;
      }
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("missing");
    });
    server.listen(0, "127.0.0.1", () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });

const wire = (overrides) => ({
  id: `test-${Math.random().toString(36).slice(2)}`,
  method: "GET",
  url: `${baseUrl}/json`,
  headers: [],
  timeoutMs: 5000,
  followRedirects: true,
  maxRedirects: 10,
  verifyTls: true,
  ...overrides,
});

test.before(listen);
test.after(() => new Promise((resolve) => server.close(resolve)));

test("send returns a shaped JSON response", async () => {
  const result = await handlers.send({ wire: wire() });
  assert.equal(result.ok, true);
  assert.equal(result.response.status, 200);
  assert.equal(result.response.bodyKind, "json");
  assert.match(result.response.bodyText, /"ok":true/);
  assert.equal(
    result.response.headers.find((header) => header.key.toLowerCase() === "x-trace").value,
    "trace-1"
  );
  assert.equal(result.response.truncated, false);
  assert.ok(result.response.durationMs >= 0);
});

test("send forwards method, body and auth header", async () => {
  const result = await handlers.send({
    wire: wire({
      method: "POST",
      url: `${baseUrl}/echo`,
      bodyText: '{"hello":"world"}',
      headers: [
        { key: "Content-Type", value: "application/json" },
        { key: "Authorization", value: "Bearer token-1" },
      ],
    }),
  });
  assert.equal(result.ok, true);
  const parsed = JSON.parse(result.response.bodyText);
  assert.equal(parsed.method, "POST");
  assert.equal(parsed.body, '{"hello":"world"}');
  assert.equal(parsed.auth, "Bearer token-1");
});

test("send follows redirects and records them", async () => {
  const result = await handlers.send({ wire: wire({ url: `${baseUrl}/redirect` }) });
  assert.equal(result.ok, true);
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.response.redirects, [{ status: 302, location: "/json" }]);
});

test("send surfaces the 3xx response when redirects are disabled", async () => {
  const result = await handlers.send({
    wire: wire({ url: `${baseUrl}/redirect`, followRedirects: false }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.response.status, 302);
  assert.deepEqual(result.response.bodyKind, "empty");
});

test("send stops after maxRedirects", async () => {
  const result = await handlers.send({ wire: wire({ url: `${baseUrl}/loop`, maxRedirects: 2 }) });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "too-many-redirects");
});

test("send decodes gzip bodies", async () => {
  const result = await handlers.send({ wire: wire({ url: `${baseUrl}/gzip` }) });
  assert.equal(result.ok, true);
  assert.equal(result.response.bodyKind, "json");
  assert.deepEqual(JSON.parse(result.response.bodyText), { compressed: true });
});

test("send returns binary bodies as base64", async () => {
  const result = await handlers.send({ wire: wire({ url: `${baseUrl}/binary` }) });
  assert.equal(result.ok, true);
  assert.equal(result.response.bodyKind, "binary");
  assert.equal(Buffer.from(result.response.bodyBase64, "base64").toString("hex"), "00010203ff");
});

test("send reports http errors as data, not exceptions", async () => {
  const result = await handlers.send({ wire: wire({ url: `${baseUrl}/missing` }) });
  assert.equal(result.ok, true);
  assert.equal(result.response.status, 404);
  assert.equal(result.response.bodyText, "missing");
});

test("send times out and maps the error code", async () => {
  const result = await handlers.send({ wire: wire({ url: `${baseUrl}/slow`, timeoutMs: 200 }) });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "timeout");
});

test("cancel aborts an in-flight request", async () => {
  const target = wire({ url: `${baseUrl}/slow`, timeoutMs: 5000 });
  const pending = handlers.send({ wire: target });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(handlers.cancel({ requestId: target.id }), { ok: true, cancelled: true });
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "cancelled");
});

test("invalid urls and missing wires are rejected", async () => {
  assert.equal((await handlers.send({})).error.code, "invalid-request");
  const result = await handlers.send({ wire: wire({ url: "not a url" }) });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "invalid-url");
});

test("header sanitization drops CRLF and bogus names", () => {
  const list = __test.sanitizeHeaderList([
    { key: "X-Ok", value: "fine" },
    { key: "X-Bad", value: "a\r\nInjected: 1" },
    { key: "Bad Name", value: "value" },
    { key: "", value: "empty" },
    null,
  ]);
  assert.deepEqual(list, [{ key: "X-Ok", value: "fine" }]);
  assert.deepEqual(__test.headersToNode(list), { "X-Ok": "fine" });
});

test("helpers clamp and classify", () => {
  assert.equal(__test.clampTimeout(undefined), 30000);
  assert.equal(__test.clampTimeout(10), 1000);
  assert.equal(__test.clampRedirects(-1), 10);
  assert.equal(__test.clampRedirects(99), 20);
  assert.equal(__test.classifyBody("application/json", Buffer.from("{}")), "json");
  assert.equal(__test.classifyBody("", Buffer.from([0, 1])), "binary");
  assert.equal(MAX_BODY_BYTES, 8 * 1024 * 1024);
});

test("normalizeError maps node error codes", () => {
  assert.equal(__test.normalizeError({ code: "ENOTFOUND", message: "x" }).code, "dns");
  assert.equal(__test.normalizeError({ code: "ECONNREFUSED", message: "x" }).code, "connection");
  assert.equal(__test.normalizeError({ code: "DEPTH_ZERO_SELF_SIGNED_CERT", message: "x" }).code, "tls");
  assert.equal(__test.normalizeError(new Error("Request cancelled")).code, "cancelled");
});
