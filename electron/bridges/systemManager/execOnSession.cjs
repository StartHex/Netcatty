/* eslint-disable no-undef */

function createExecOnSessionApi(ctx) {
  with (ctx) {
    function getSession(sessionId) {
      return sessions?.get?.(sessionId) ?? null;
    }

    async function execOnSshSession(session, command, timeoutMs, event) {
      if (session?.type === "et") {
        if (typeof execOnEtSession !== "function") {
          return { success: false, error: "ET command executor unavailable" };
        }
        return execOnEtSession(session, command, timeoutMs, {
          requireTrustedHost: true,
          knownHosts: session.etStatsAuth?.knownHosts,
        });
      }

      if (
        !session?.conn &&
        !session?.moshStatsConn &&
        session?.type === "mosh" &&
        typeof ensureMoshStatsConnection === "function"
      ) {
        await ensureMoshStatsConnection(session, session.id, event?.sender);
      }

      const conn = session?.conn || session?.moshStatsConn;
      if (!conn) {
        if (session?.type === "mosh" && !session.moshStatsAuth && !session.moshStatsConnFailed) {
          return { success: false, pending: true, error: "Mosh handshake in progress" };
        }
        return { success: false, error: "Session not found or not connected" };
      }

      return new Promise((resolve) => {
        let settled = false;
        let activeStream = null;
        const settle = (result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(result);
        };
        const timer = setTimeout(() => {
          settle({ success: false, error: "Command timeout" });
          try { if (activeStream) activeStream.close(); } catch { /* ignore */ }
        }, timeoutMs);

        try {
          conn.exec(command, (err, stream) => {
            if (err) {
              settle({ success: false, error: err.message || String(err) });
              return;
            }
            activeStream = stream;
            let stdout = "";
            let stderr = "";
            stream.on("data", (chunk) => { stdout += chunk.toString(); });
            if (stream.stderr) {
              stream.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
            }
            stream.on("close", (code) => {
              settle({ success: true, stdout, stderr, code: code ?? 0 });
            });
          });
        } catch (err) {
          settle({ success: false, error: err?.message || String(err) });
        }
      });
    }

    async function execOnLocalMachine(command, timeoutMs) {
      const { execFile } = require("node:child_process");
      const platform = process.platform;

      if (platform === "win32") {
        return new Promise((resolve) => {
          execFile(
            "powershell.exe",
            ["-NoProfile", "-NonInteractive", "-Command", command],
            { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
            (err, stdout, stderr) => {
              if (err && !stdout) {
                resolve({ success: false, error: err.message || String(err), stdout: "", stderr: String(stderr || "") });
                return;
              }
              resolve({ success: true, stdout: String(stdout || ""), stderr: String(stderr || ""), code: err?.code ?? 0 });
            },
          );
        });
      }

      return new Promise((resolve) => {
        execFile(
          "sh",
          ["-c", command],
          { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
          (err, stdout, stderr) => {
            if (err && !stdout) {
              resolve({ success: false, error: err.message || String(err), stdout: "", stderr: String(stderr || "") });
              return;
            }
            resolve({ success: true, stdout: String(stdout || ""), stderr: String(stderr || ""), code: err?.code ?? 0 });
          },
        );
      });
    }

    async function execOnSession(event, sessionId, command, timeoutMs = 8000) {
      const session = getSession(sessionId);
      if (!session) {
        return { success: false, error: "Session not found" };
      }

      if (session.protocol === "local" || session.type === "local") {
        return execOnLocalMachine(command, timeoutMs);
      }

      if (session.conn || session.type === "mosh" || session.type === "et") {
        return execOnSshSession(session, command, timeoutMs, event);
      }

      return { success: false, error: "Session not supported for system management" };
    }

    function isLocalSession(sessionId) {
      const session = getSession(sessionId);
      return !!(session?.protocol === "local" || session?.type === "local");
    }

    return { execOnSession, execOnLocalMachine, isLocalSession, getSession };
  }
}

module.exports = { createExecOnSessionApi };
