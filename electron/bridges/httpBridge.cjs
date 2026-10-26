"use strict";

const http = require("http");
const https = require("https");
const zlib = require("zlib");
const { URL } = require("url");

/**
 * Curl tool bridge — main-process side of the built-in HTTP client.
 *
 * Requests are sent with node's http/https modules rather than fetch so the
 * client owns redirects, TLS verification, timeouts and cancellation, and can
 * stream a response while enforcing the body cap. Nothing is persisted here:
 * the renderer owns request storage (encrypted vault) and passes a resolved
 * wire payload per call.
 */

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_HEADER_COUNT = 200;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** One entry per in-flight request so `cancel` can abort it. */
const activeRequests = new Map();

function clampTimeout(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 30000;
  return Math.min(120000, Math.max(1000, Math.round(numeric)));
}

function clampRedirects(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return 10;
  return Math.min(20, Math.round(numeric));
}

function normalizeError(error, fallbackMessage) {
  const code = typeof error?.code === "string" ? error.code : "";
  const message = error?.message ? String(error.message) : fallbackMessage || "request failed";
  let normalized = "connection";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") normalized = "dns";
  else if (code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT") normalized = "timeout";
  else if (code.startsWith("ERR_TLS") || code.startsWith("CERT_") || code === "DEPTH_ZERO_SELF_SIGNED_CERT" || code === "SELF_SIGNED_CERT_IN_CHAIN" || code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE") {
    normalized = "tls";
  } else if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "EPIPE" || code === "EHOSTUNREACH" || code === "ENETUNREACH") {
    normalized = "connection";
  } else if (code === "ABORT_ERR" || /aborted|cancelled|canceled/i.test(message)) {
    normalized = "cancelled";
  }
  if (code === "ERR_INVALID_URL") normalized = "invalid-url";
  return { code: normalized, message, ...(code ? { detail: code } : {}) };
}

/** Header values must not smuggle CRLF or bogus names into the request. */
function sanitizeHeaderList(input) {
  if (!Array.isArray(input)) return [];
  const result = [];
  for (const entry of input.slice(0, MAX_HEADER_COUNT)) {
    if (!entry || typeof entry !== "object") continue;
    const key = String(entry.key ?? "").trim();
    const rawValue = entry.value === undefined || entry.value === null ? "" : String(entry.value);
    if (!key) continue;
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key)) continue;
    if (/[\r\n\0]/.test(rawValue)) continue;
    result.push({ key, value: rawValue });
  }
  return result;
}

function headersToNode(list) {
  const headers = {};
  for (const { key, value } of list) {
    const existingKey = Object.keys(headers).find((name) => name.toLowerCase() === key.toLowerCase());
    if (existingKey) headers[existingKey] = `${headers[existingKey]}, ${value}`;
    else headers[key] = value;
  }
  return headers;
}

function rawHeadersToList(rawHeaders) {
  const list = [];
  if (!Array.isArray(rawHeaders)) return list;
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    list.push({ key: String(rawHeaders[index]), value: String(rawHeaders[index + 1]) });
  }
  return list;
}

function headerValue(list, name) {
  const target = name.toLowerCase();
  const match = list.find((entry) => entry.key.toLowerCase() === target);
  return match ? match.value : undefined;
}

function decodeBody(buffer, encoding) {
  const normalized = String(encoding || "").toLowerCase().trim();
  try {
    if (normalized === "gzip" || normalized === "x-gzip") return zlib.gunzipSync(buffer);
    if (normalized === "deflate") return zlib.inflateSync(buffer);
    if (normalized === "br") return zlib.brotliDecompressSync(buffer);
    if (normalized === "zstd" && typeof zlib.zstdDecompressSync === "function") {
      return zlib.zstdDecompressSync(buffer);
    }
  } catch {
    return buffer;
  }
  return buffer;
}

function classifyBody(contentType, buffer) {
  const type = String(contentType || "").toLowerCase();
  const looksBinary = buffer.includes(0);
  if (type.includes("json")) return "json";
  if (type.includes("html")) return "html";
  if (type.includes("xml")) return "xml";
  if (type.startsWith("text/") || type.includes("javascript") || type.includes("x-www-form-urlencoded")) {
    return looksBinary ? "binary" : "text";
  }
  if (!type) return looksBinary ? "binary" : "text";
  return "binary";
}

function shapeResponse({ status, statusText, httpVersion, headers, buffer, truncated, durationMs, redirects }) {
  const contentType = headerValue(headers, "content-type");
  const kind = classifyBody(contentType, buffer);
  const response = {
    status,
    statusText: statusText || "",
    headers,
    durationMs,
    sizeBytes: buffer.length,
    truncated,
    redirects,
    bodyKind: kind,
  };
  if (httpVersion) response.httpVersion = httpVersion;
  if (contentType) response.contentType = contentType;
  if (kind === "binary") response.bodyBase64 = buffer.toString("base64");
  else response.bodyText = buffer.toString("utf8");
  if (buffer.length === 0) response.bodyKind = "empty";
  return response;
}

function sendOnce(wire, redirectHistory, deadline) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(wire.url);
    } catch (error) {
      reject(Object.assign(error, { code: "ERR_INVALID_URL" }));
      return;
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      reject(Object.assign(new Error(`Unsupported protocol: ${target.protocol}`), { code: "ERR_INVALID_URL" }));
      return;
    }

    const isHttps = target.protocol === "https:";
    const headers = headersToNode(wire.headers);
    const hasAcceptEncoding = Object.keys(headers).some((name) => name.toLowerCase() === "accept-encoding");
    if (!hasAcceptEncoding) headers["Accept-Encoding"] = "gzip, deflate, br";

    const options = {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port ? Number(target.port) : isHttps ? 443 : 80,
      path: `${target.pathname}${target.search}`,
      method: wire.method,
      headers,
      timeout: clampTimeout(wire.timeoutMs),
    };
    if (isHttps && wire.verifyTls === false) options.rejectUnauthorized = false;

    const started = Date.now();
    const request = (isHttps ? https : http).request(options, (response) => {
      const headerList = rawHeadersToList(response.rawHeaders);
      const status = response.statusCode || 0;

      if (REDIRECT_STATUSES.has(status) && wire.followRedirects !== false) {
        const location = headerValue(headerList, "location");
        if (location) {
          response.resume();
          resolve({ redirect: { status, location, headers: headerList, httpVersion: response.httpVersion } });
          return;
        }
      }

      const chunks = [];
      let total = 0;
      let truncated = false;
      response.on("data", (chunk) => {
        if (total >= MAX_BODY_BYTES) {
          truncated = true;
          return;
        }
        const remaining = MAX_BODY_BYTES - total;
        if (chunk.length > remaining) {
          chunks.push(chunk.subarray(0, remaining));
          total = MAX_BODY_BYTES;
          truncated = true;
        } else {
          chunks.push(chunk);
          total += chunk.length;
        }
      });
      response.on("error", reject);
      response.on("end", () => {
        const raw = Buffer.concat(chunks, total);
        const decoded = truncated ? raw : decodeBody(raw, headerValue(headerList, "content-encoding"));
        try {
          resolve({
            response: shapeResponse({
              status,
              statusText: response.statusMessage,
              httpVersion: response.httpVersion,
              headers: headerList,
              buffer: decoded,
              truncated: truncated || decoded.length >= MAX_BODY_BYTES,
              durationMs: Date.now() - started,
              redirects: redirectHistory,
            }),
          });
        } catch (error) {
          reject(error);
        }
      });
    });

    if (wire.method !== "GET" && wire.method !== "HEAD" && typeof wire.bodyText === "string") {
      request.write(wire.bodyText);
    }

    const timeoutMs = Math.max(1, deadline - Date.now());
    request.setTimeout(Math.min(timeoutMs, clampTimeout(wire.timeoutMs)), () => {
      request.destroy(Object.assign(new Error("Request timed out"), { code: "ETIMEDOUT" }));
    });
    request.on("error", reject);
    activeRequests.set(wire.id, request);
    request.on("close", () => {
      if (activeRequests.get(wire.id) === request) activeRequests.delete(wire.id);
    });
    request.end();
  });
}

async function send({ wire }) {
  if (!wire || typeof wire !== "object" || typeof wire.url !== "string") {
    return { ok: false, error: { code: "invalid-request", message: "Missing request URL" } };
  }
  const requestId = typeof wire.id === "string" && wire.id ? wire.id : `http-${Date.now()}`;
  const payload = { ...wire, id: requestId, headers: sanitizeHeaderList(wire.headers) };
  const started = Date.now();
  const deadline = started + clampTimeout(wire.timeoutMs);
  const redirects = [];
  const maxRedirects = clampRedirects(wire.maxRedirects);
  let current = { ...payload };

  try {
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      const outcome = await sendOnce(current, redirects.slice(), deadline);
      if (!outcome.redirect) {
        return { ok: true, response: outcome.response };
      }
      const { status, location } = outcome.redirect;
      redirects.push({ status: status, location: location });
      if (redirects.length > maxRedirects) {
        return {
          ok: false,
          error: {
            code: "too-many-redirects",
            message: `Exceeded ${maxRedirects} redirects`,
            detail: location,
          },
        };
      }
      let nextUrl;
      try {
        nextUrl = new URL(location, current.url).toString();
      } catch (error) {
        return { ok: false, error: normalizeError(error, "Invalid redirect location") };
      }
      const dropsBody = status === 303 || ((status === 301 || status === 302) && current.method === "POST");
      current = {
        ...current,
        url: nextUrl,
        method: dropsBody ? "GET" : current.method,
        ...(dropsBody ? { bodyText: undefined } : {}),
      };
    }
    return {
      ok: false,
      error: { code: "too-many-redirects", message: `Exceeded ${maxRedirects} redirects` },
    };
  } catch (error) {
    return { ok: false, error: normalizeError(error) };
  } finally {
    activeRequests.delete(requestId);
  }
}

function cancel({ requestId }) {
  const request = activeRequests.get(requestId);
  if (!request) return { ok: true, cancelled: false };
  activeRequests.delete(requestId);
  try {
    request.destroy(Object.assign(new Error("Request cancelled"), { code: "ABORT_ERR" }));
  } catch {
    // ignore
  }
  return { ok: true, cancelled: true };
}

const handlers = { send, cancel };

function registerHttpHandlers(ipcMain) {
  ipcMain.handle("netcatty:http:request", (_event, payload) => handlers.send(payload || {}));
  ipcMain.handle("netcatty:http:cancel", (_event, payload) => handlers.cancel(payload || {}));
}

module.exports = {
  registerHttpHandlers,
  handlers,
  MAX_BODY_BYTES,
  __test: {
    clampTimeout,
    clampRedirects,
    normalizeError,
    sanitizeHeaderList,
    headersToNode,
    rawHeadersToList,
    decodeBody,
    classifyBody,
    activeRequests,
  },
};
