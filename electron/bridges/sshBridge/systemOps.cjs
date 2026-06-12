/**
 * System Operations — SSH backend for the system manager panel.
 *
 * Provides probeSystemCapabilities, listSystemProcesses, Docker/tmux
 * commands over the existing SSH connection.  Follows the same patterns
 * as sessionOps.cjs (exec channel, timeout, stream parsing).
 */

function quoteShellArg(s) {
  if (typeof s !== "string") return "''";
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function createSystemOpsApi(ctx) {
  with (ctx) {
    // ---------- helpers ----------

    /** Run a shell command on the remote host and return stdout as a string. */
    function execRemote({ session, command, timeoutMs = 10000 }) {
      return new Promise((resolve) => {
        if (!session || !session.conn) {
          return resolve({ success: false, error: "Session not connected" });
        }
        let settled = false;
        const settle = (result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(result);
        };
        const timer = setTimeout(() => {
          settle({ success: false, error: "Command timed out" });
          try { if (activeStream) activeStream.close(); } catch {}
        }, timeoutMs);
        let activeStream = null;
        try {
          session.conn.exec(command, (err, stream) => {
            if (err) return settle({ success: false, error: String(err) });
            activeStream = stream;
            let stdout = "";
            let stderr = "";
            stream.on("data", (d) => { stdout += d.toString(); });
            stream.stderr.on("data", (d) => { stderr += d.toString(); });
            stream.on("close", (code) => {
              settle({
                success: code === 0,
                exitCode: code,
                stdout: stdout.trim(),
                stderr: stderr.trim(),
              });
            });
          });
        } catch (e) {
          settle({ success: false, error: String(e) });
        }
      });
    }

    /**
     * Route a system operation through the right transport:
     * - SSH sessions → execRemote
     * - ET sessions → execOnEtSession (if available)
     * - Mosh sessions → moshStatsConn
     */
    async function runSystemCommand(session, command, timeoutMs = 10000) {
      if (session.type === "et") {
        if (typeof execOnEtSession !== "function") {
          return { success: false, error: "ET executor unavailable" };
        }
        return execOnEtSession(session, command, timeoutMs, {
          requireTrustedHost: true,
          knownHosts: session.etStatsAuth?.knownHosts,
        });
      }
      // Mosh: use the stats companion connection if available
      const conn = session.moshStatsConn || session.conn;
      if (!conn) {
        return { success: false, error: "No connection available" };
      }
      // For Mosh, we may need to ensure the connection first
      if (session.type === "mosh" && !session.moshStatsConn) {
        if (typeof ensureMoshStatsConnection === "function") {
          const ensured = await ensureMoshStatsConnection(session, session.sessionId);
          if (!ensured) {
            return { success: false, error: "Mosh stats connection not available" };
          }
        }
      }
      return execRemote({ session: { ...session, conn }, command, timeoutMs });
    }

    // ---------- capabilities probe ----------

    async function probeSystemCapabilities(_event, payload) {
      const { sessionId } = payload || {};
      const session = sessions.get(sessionId);
      if (!session) return { success: false, error: "Session not found" };

      // Compact POSIX‑safe probe:
      //   os type, Docker presence, tmux presence, total process count.
      const probeCmd = [
        `echo "OS:$(uname -s 2>/dev/null || echo Unknown)"`,
        `echo "DOCKER:$(command -v docker 2>/dev/null && echo yes || echo no)"`,
        `echo "TMUX:$(command -v tmux 2>/dev/null && echo yes || echo no)"`,
        // Process count: try GNU ps first, fall back to /proc counting.
        `_c=$(ps -e --no-headers 2>/dev/null | wc -l) || _c=$(ls /proc/ 2>/dev/null | grep -c '^[0-9]') || _c=0`,
        `echo "PROCS:$_c"`,
      ].join("; ");

      const result = await runSystemCommand(session, `exec sh -c ${quoteShellArg(probeCmd)}`, 8000);
      if (!result || !result.success) {
        return { success: false, error: (result && result.error) || "Probe failed" };
      }

      const lines = (result.stdout || "").split("\n");
      const caps = { targetOs: "unknown", hasTmux: false, hasDocker: false, probedAt: Date.now() };

      for (const line of lines) {
        const [key, ...vals] = line.split(":");
        const val = vals.join(":").trim();
        if (key === "OS") caps.targetOs = val.toLowerCase() === "linux" ? "linux" : val.toLowerCase() === "darwin" ? "darwin" : "unknown";
        else if (key === "DOCKER") caps.hasDocker = val === "yes";
        else if (key === "TMUX") caps.hasTmux = val === "yes";
      }

      return { success: true, capabilities: caps };
    }

    // ---------- process listing ----------

    async function listSystemProcesses(_event, payload) {
      const { sessionId } = payload || {};
      const session = sessions.get(sessionId);
      if (!session) return { success: false, error: "Session not found" };

      // Try GNU ps format first; fall back to BusyBox ps (openEuler, Alpine).
      const psCmd = [
        `ps -eo pid,ppid,user,stat,%cpu,%mem,rss,vsz,etime,args --no-headers 2>/dev/null`,
        `|| ps aux 2>/dev/null`,
        `|| echo "PS_FAILED"`,
      ].join(" ");

      const result = await runSystemCommand(session, psCmd, 15000);
      if (!result || !result.success) {
        return { success: false, error: (result && result.error) || "Failed to list processes" };
      }

      const stdout = result.stdout || "";
      if (stdout === "PS_FAILED" || stdout.startsWith("PS_FAILED")) {
        return { success: false, error: "ps command not available on this host" };
      }

      const processes = [];
      const lines = stdout.split("\n");

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        // Skip header line
        if (/^PID/i.test(trimmed) || /^  PID/i.test(trimmed)) continue;

        // Try GNU ps -eo format
        const gnuMatch = trimmed.match(
          /^\s*(\d+)\s+(\d+|)\s+(\S+)\s+(\S+|)\s+([\d.]+)\s+([\d.]+)\s+(\d+|)\s+(\d+|)\s+(\S+|)\s+(.*)$/
        );
        if (gnuMatch) {
          const rssKb = parseInt(gnuMatch[7], 10) || 0;
          const vszKb = parseInt(gnuMatch[8], 10) || 0;
          processes.push({
            pid: parseInt(gnuMatch[1], 10),
            ppid: parseInt(gnuMatch[2], 10) || 0,
            user: gnuMatch[3],
            stat: gnuMatch[4] || "?",
            cpuPercent: parseFloat(gnuMatch[5]) || 0,
            memPercent: parseFloat(gnuMatch[6]) || 0,
            rssKb,
            vszKb,
            elapsed: gnuMatch[9] || "?",
            command: gnuMatch[10] || "",
          });
          continue;
        }

        // Fallback: try `ps aux` format
        const auxMatch = trimmed.match(
          /^\s*(\S+)\s+(\d+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(\d+)\s+(\S+|)\s+(\S+|)\s+(\S+|)\s+(\d+:\d+|\d+-\S+|\d+:\d+:\d+)\s+(.*)$/
        );
        if (auxMatch) {
          const rss = parseInt(auxMatch[6], 10) || 0;
          processes.push({
            pid: parseInt(auxMatch[2], 10),
            ppid: 0,
            user: auxMatch[1],
            stat: auxMatch[7] || "?",
            cpuPercent: parseFloat(auxMatch[3]) || 0,
            memPercent: parseFloat(auxMatch[4]) || 0,
            rssKb: rss,
            vszKb: parseInt(auxMatch[5], 10) || 0,
            elapsed: auxMatch[9] || "?",
            command: auxMatch[10] || "",
          });
          continue;
        }
      }

      return { success: true, processes };
    }

    // ---------- process signal ----------

    async function signalSystemProcess(_event, options) {
      const { sessionId, pid, signal: sig } = options || {};
      const session = sessions.get(sessionId);
      if (!session) return { success: false, error: "Session not found" };
      if (!pid || typeof pid !== "number") return { success: false, error: "Invalid pid" };

      const sigFlag = sig ? `-${quoteShellArg(sig)}` : "-TERM";
      const cmd = `kill ${sigFlag} ${pid} 2>&1; echo "EXIT:$?"`;
      const result = await runSystemCommand(session, cmd, 5000);

      if (!result || !result.success) {
        return { success: false, error: (result && result.error) || "Kill failed", code: -1 };
      }

      const exitMatch = (result.stdout || "").match(/EXIT:(\d+)/);
      const code = exitMatch ? parseInt(exitMatch[1], 10) : -1;
      return { success: code === 0, code, error: code !== 0 ? (result.stdout || "").trim() : undefined };
    }

    // ---------- Docker detection + management ----------

    /** Verify Docker is actually reachable before running Docker commands. */
    function buildDockerCmd(subCmd) {
      // Check Docker is available first, then run the command.
      return `docker ${subCmd} 2>&1 || echo "DOCKER_ERR:$?"`;
    }

    async function ensureDocker(session) {
      const r = await runSystemCommand(session,
        `command -v docker 2>/dev/null && docker info --format '{{.ServerVersion}}' 2>/dev/null || echo "NO_DOCKER"`,
        8000);
      if (!r || !r.success || (r.stdout || "").trim() === "NO_DOCKER") return false;
      return true;
    }

    async function listDockerContainers(_event, payload) {
      const { sessionId } = payload || {};
      const session = sessions.get(sessionId);
      if (!session) return { success: false, error: "Session not found" };

      if (!(await ensureDocker(session))) {
        return { success: false, error: "此主机未检测到docker" };
      }

      const cmd = buildDockerCmd(
        `ps -a --format '{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.State}}\t{{.Ports}}\t{{.CreatedAt}}' --no-trunc 2>/dev/null`
      );
      const result = await runSystemCommand(session, cmd, 15000);
      if (!result || !result.success) {
        return { success: false, error: (result && result.error) || "Docker ps failed" };
      }

      const containers = [];
      for (const line of (result.stdout || "").split("\n")) {
        const parts = line.split("\t");
        if (parts.length < 3 || parts[0].startsWith("DOCKER_ERR")) continue;
        containers.push({
          id: parts[0] || "",
          name: parts[1] || "",
          image: parts[2] || "",
          status: parts[3] || "",
          state: parts[4] || "",
          ports: (parts[5] || "").replace(/, /g, ", "),
          createdAt: parts[6] || "",
        });
      }

      return { success: true, containers };
    }

    async function listDockerImages(_event, payload) {
      const { sessionId } = payload || {};
      const session = sessions.get(sessionId);
      if (!session) return { success: false, error: "Session not found" };

      if (!(await ensureDocker(session))) {
        return { success: false, error: "此主机未检测到docker" };
      }

      const cmd = buildDockerCmd(
        `images --format '{{.ID}}\t{{.Repository}}\t{{.Tag}}\t{{.Size}}\t{{.CreatedAt}}\t{{.Digest}}' --no-trunc 2>/dev/null`
      );
      const result = await runSystemCommand(session, cmd, 15000);
      if (!result || !result.success) {
        return { success: false, error: (result && result.error) || "Docker images failed" };
      }

      const images = [];
      for (const line of (result.stdout || "").split("\n")) {
        const parts = line.split("\t");
        if (parts.length < 3 || parts[0].startsWith("DOCKER_ERR")) continue;
        images.push({
          id: parts[0] || "",
          repository: parts[1] || "",
          tag: parts[2] || "",
          size: parts[3] || "",
          createdAt: parts[4] || "",
          digest: parts[5] || "",
          name: (parts[1] || "") + ":" + (parts[2] || ""),
        });
      }

      return { success: true, images };
    }

    async function getDockerStats(_event, options) {
      const { sessionId, ids } = options || {};
      const session = sessions.get(sessionId);
      if (!session) return { success: false, error: "Session not found" };

      if (!(await ensureDocker(session))) {
        return { success: false, error: "Docker not available" };
      }

      const containerArg = Array.isArray(ids) && ids.length
        ? ids.map((id) => quoteShellArg(id)).join(" ")
        : "";
      const cmd = buildDockerCmd(
        `stats --no-stream --format '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}\t{{.NetIO}}\t{{.BlockIO}}\t{{.PIDs}}' ${containerArg} 2>/dev/null`
      );
      const result = await runSystemCommand(session, cmd, 15000);
      if (!result || !result.success) {
        return { success: false, error: (result && result.error) || "Docker stats failed" };
      }

      const stats = [];
      for (const line of (result.stdout || "").split("\n")) {
        const parts = line.split("\t");
        if (parts.length < 4 || parts[0].startsWith("DOCKER_ERR")) continue;
        stats.push({
          id: "", // docker stats doesn't include ID by default
          name: parts[0] || "",
          cpuPercent: parseFloat(parts[1]) || 0,
          memUsage: parts[2] || "",
          memPercent: parseFloat(parts[3]) || 0,
          netIO: parts[4] || "",
          blockIO: parts[5] || "",
          pids: parseInt(parts[6], 10) || 0,
        });
      }

      return { success: true, stats };
    }

    async function dockerInspect(_event, options) {
      const { sessionId, containerId } = options || {};
      const session = sessions.get(sessionId);
      if (!session) return { success: false, error: "Session not found" };
      if (!containerId) return { success: false, error: "Container ID required" };

      if (!(await ensureDocker(session))) {
        return { success: false, error: "Docker not available" };
      }

      const cmd = buildDockerCmd(`inspect ${quoteShellArg(containerId)} 2>/dev/null`);
      const result = await runSystemCommand(session, cmd, 10000);
      if (!result || !result.success) {
        return { success: false, error: (result && result.error) || "Inspect failed" };
      }

      try {
        return { success: true, inspect: JSON.parse(result.stdout || "{}") };
      } catch {
        return { success: false, error: "Failed to parse inspect output" };
      }
    }

    async function dockerImageInspect(_event, options) {
      const { sessionId, imageId } = options || {};
      const session = sessions.get(sessionId);
      if (!session) return { success: false, error: "Session not found" };
      if (!imageId) return { success: false, error: "Image ID required" };

      if (!(await ensureDocker(session))) {
        return { success: false, error: "Docker not available" };
      }

      const cmd = buildDockerCmd(`image inspect ${quoteShellArg(imageId)} 2>/dev/null`);
      const result = await runSystemCommand(session, cmd, 10000);
      if (!result || !result.success) {
        return { success: false, error: (result && result.error) || "Image inspect failed" };
      }

      try {
        return { success: true, inspect: JSON.parse(result.stdout || "{}") };
      } catch {
        return { success: false, error: "Failed to parse inspect output" };
      }
    }

    async function dockerAction(_event, options) {
      const { sessionId, containerId, action, newName } = options || {};
      const session = sessions.get(sessionId);
      if (!session) return { success: false, error: "Session not found" };
      if (!containerId || !action) return { success: false, error: "Container ID and action required" };

      if (!(await ensureDocker(session))) {
        return { success: false, error: "Docker not available" };
      }

      let cmd;
      if (action === "rename" && newName) {
        cmd = buildDockerCmd(`rename ${quoteShellArg(containerId)} ${quoteShellArg(newName)} 2>&1`);
      } else {
        const validActions = ["start", "stop", "restart", "rm", "pause", "unpause", "kill"];
        if (!validActions.includes(action)) {
          return { success: false, error: `Invalid action: ${action}` };
        }
        cmd = buildDockerCmd(`${action} ${quoteShellArg(containerId)} 2>&1`);
      }

      const result = await runSystemCommand(session, cmd, 15000);
      const stdout = (result && result.stdout || "").trim();
      const isError = stdout.startsWith("DOCKER_ERR") || (result && !result.success);
      return {
        success: !isError,
        error: isError ? stdout.replace(/^DOCKER_ERR:\d+\s*/, "") || "Action failed" : undefined,
      };
    }

    async function dockerImageAction(_event, options) {
      const { sessionId, action, imageId, imageRef, repository, tag, force, all: pruneAll } = options || {};
      const session = sessions.get(sessionId);
      if (!session) return { success: false, error: "Session not found" };

      if (!(await ensureDocker(session))) {
        return { success: false, error: "Docker not available" };
      }

      let cmd;
      switch (action) {
        case "pull":
          if (!imageRef) return { success: false, error: "Image reference required" };
          cmd = buildDockerCmd(`pull ${quoteShellArg(imageRef)} 2>&1`);
          break;
        case "rm":
          if (!imageId) return { success: false, error: "Image ID required" };
          cmd = buildDockerCmd(`rmi${force ? " -f" : ""} ${quoteShellArg(imageId)} 2>&1`);
          break;
        case "prune":
          cmd = buildDockerCmd(`image prune${pruneAll ? " -a" : ""} -f 2>&1`);
          break;
        case "tag":
          if (!imageId || !repository) return { success: false, error: "Image ID and repository required" };
          const tagPart = tag ? `:${quoteShellArg(tag)}` : "";
          cmd = buildDockerCmd(`tag ${quoteShellArg(imageId)} ${quoteShellArg(repository)}${tagPart} 2>&1`);
          break;
        default:
          return { success: false, error: `Invalid action: ${action}` };
      }

      const result = await runSystemCommand(session, cmd, 30000);
      const stdout = (result && result.stdout || "").trim();
      const isError = stdout.startsWith("DOCKER_ERR") || (result && !result.success);
      return {
        success: !isError,
        error: isError ? stdout.replace(/^DOCKER_ERR:\d+\s*/, "") || "Action failed" : undefined,
        output: !isError ? stdout : undefined,
      };
    }

    // ---------- tmux ----------

    async function listTmuxSessions(_event, payload) {
      const { sessionId } = payload || {};
      const session = sessions.get(sessionId);
      if (!session) return { success: false, error: "Session not found" };

      const result = await runSystemCommand(session,
        `command -v tmux 2>/dev/null && tmux list-sessions -F '#{session_name}\\t#{session_windows}\\t#{session_attached}\\t#{session_created}\\t#{session_activity}\\t#{session_group}' 2>/dev/null || echo "NO_TMUX"`,
        8000);

      if (!result || !result.success) {
        return { success: false, error: (result && result.error) || "Failed to list tmux sessions" };
      }

      const stdout = (result.stdout || "").trim();
      if (stdout === "NO_TMUX") {
        return { success: false, error: "tmux not available" };
      }

      const sessions_list = [];
      for (const line of stdout.split("\n")) {
        const parts = line.split("\t");
        if (parts.length >= 3) {
          sessions_list.push({
            name: parts[0] || "",
            windows: parseInt(parts[1], 10) || 0,
            attached: parts[2] === "1",
            created: parseInt(parts[3], 10) || 0,
            activity: parts[4] || "",
            group: parts[5] || "",
          });
        }
      }

      return { success: true, tmuxVersion: "", sessions: sessions_list };
    }

    async function createTmuxSession(_event, options) {
      const { sessionId, name, command: tmuxCmd } = options || {};
      const session = sessions.get(sessionId);
      if (!session) return { success: false, error: "Session not found" };

      const nameArg = name ? quoteShellArg(name) : "";
      const cmdPart = tmuxCmd ? quoteShellArg(tmuxCmd) : "";
      const cmd = `tmux new-session -d${nameArg ? ` -s ${nameArg}` : ""}${cmdPart ? ` ${cmdPart}` : ""} 2>&1`;
      const result = await runSystemCommand(session, cmd, 8000);
      return {
        success: !!(result && result.success),
        error: (result && !result.success) ? (result.error || (result.stdout || "").trim() || "Failed") : undefined,
        name: name || undefined,
      };
    }

    async function listTmuxWindows(_event, options) {
      const { sessionId, sessionName } = options || {};
      const session = sessions.get(sessionId);
      if (!session) return { success: false, error: "Session not found" };

      if (!sessionName) return { success: false, error: "Session name required" };

      const cmd = `tmux list-windows -t ${quoteShellArg(sessionName)} -F '#{window_index}\\t#{window_name}\\t#{window_panes}\\t#{window_active}\\t#{window_layout}' 2>&1`;
      const result = await runSystemCommand(session, cmd, 8000);
      if (!result || !result.success) {
        return { success: false, error: (result && result.stdout || "").trim() || "Failed", debug: { lastOutput: result && result.stdout } };
      }

      const windows = [];
      for (const line of (result.stdout || "").trim().split("\n")) {
        const parts = line.split("\t");
        if (parts.length >= 3) {
          windows.push({
            index: parseInt(parts[0], 10) || 0,
            name: parts[1] || "",
            panes: parseInt(parts[2], 10) || 0,
            active: parts[3] === "1",
            layout: parts[4] || "",
          });
        }
      }

      return { success: true, windows };
    }

    async function listTmuxPanes(_event, options) {
      const { sessionId, sessionName, windowIndex } = options || {};
      const session = sessions.get(sessionId);
      if (!session) return { success: false, error: "Session not found" };
      if (!sessionName || windowIndex === undefined) return { success: false, error: "Session name and window index required" };

      const target = `${quoteShellArg(sessionName)}:${windowIndex}`;
      const cmd = `tmux list-panes -t ${target} -F '#{pane_index}\\t#{pane_title}\\t#{pane_current_command}\\t#{pane_active}\\t#{pane_pid}\\t#{pane_width}\\t#{pane_height}' 2>&1`;
      const result = await runSystemCommand(session, cmd, 8000);
      if (!result || !result.success) {
        return { success: false, error: (result && result.stdout || "").trim() || "Failed" };
      }

      const panes = [];
      for (const line of (result.stdout || "").trim().split("\n")) {
        const parts = line.split("\t");
        if (parts.length >= 3) {
          panes.push({
            index: parseInt(parts[0], 10) || 0,
            title: parts[1] || "",
            command: parts[2] || "",
            active: parts[3] === "1",
            pid: parseInt(parts[4], 10) || 0,
            width: parseInt(parts[5], 10) || 0,
            height: parseInt(parts[6], 10) || 0,
          });
        }
      }

      return { success: true, panes };
    }

    async function listTmuxClients(_event, options) {
      const { sessionId, sessionName } = options || {};
      const session = sessions.get(sessionId);
      if (!session) return { success: false, error: "Session not found" };

      const filter = sessionName ? `-t ${quoteShellArg(sessionName)}` : "";
      const cmd = `tmux list-clients ${filter} -F '#{client_name}\\t#{client_tty}\\t#{client_activity}\\t#{client_session}' 2>&1`;
      const result = await runSystemCommand(session, cmd, 8000);
      if (!result || !result.success) {
        return { success: false, error: (result && result.stdout || "").trim() || "Failed" };
      }

      const clients = [];
      for (const line of (result.stdout || "").trim().split("\n")) {
        const parts = line.split("\t");
        if (parts.length >= 2) {
          clients.push({
            name: parts[0] || "",
            tty: parts[1] || "",
            activity: parts[2] || "",
            session: parts[3] || "",
          });
        }
      }

      return { success: true, clients };
    }

    async function tmuxAction(_event, options) {
      const { sessionId, action, sessionName, windowIndex, paneIndex, newName, keys, enter, direction, windowName } = options || {};
      const session = sessions.get(sessionId);
      if (!session) return { success: false, error: "Session not found" };

      const build = (tmuxArgs) => {
        const cmd = `tmux ${tmuxArgs} 2>&1`;
        return runSystemCommand(session, cmd, 8000);
      };

      switch (action) {
        case "killSession":
          return build(`kill-session -t ${quoteShellArg(sessionName)}`).then(r => ({ success: !!(r && r.success), error: (r && !r.success) ? (r.stdout || "").trim() : undefined }));
        case "renameSession":
          return build(`rename-session -t ${quoteShellArg(sessionName)} ${quoteShellArg(newName)}`).then(r => ({ success: !!(r && r.success), error: (r && !r.success) ? (r.stdout || "").trim() : undefined }));
        case "detachSession":
          return build(`detach-client -s ${quoteShellArg(sessionName)}`).then(r => ({ success: !!(r && r.success), error: (r && !r.success) ? (r.stdout || "").trim() : undefined }));
        case "createWindow":
          return build(`new-window -t ${quoteShellArg(sessionName)}${windowName ? ` -n ${quoteShellArg(windowName)}` : ""}`).then(r => ({ success: !!(r && r.success), error: (r && !r.success) ? (r.stdout || "").trim() : undefined }));
        case "killWindow":
          return build(`kill-window -t ${quoteShellArg(sessionName)}:${windowIndex}`).then(r => ({ success: !!(r && r.success), error: (r && !r.success) ? (r.stdout || "").trim() : undefined }));
        case "renameWindow":
          return build(`rename-window -t ${quoteShellArg(sessionName)}:${windowIndex} ${quoteShellArg(newName)}`).then(r => ({ success: !!(r && r.success), error: (r && !r.success) ? (r.stdout || "").trim() : undefined }));
        case "killPane":
          return build(`kill-pane -t ${quoteShellArg(sessionName)}:${windowIndex}.${paneIndex}`).then(r => ({ success: !!(r && r.success), error: (r && !r.success) ? (r.stdout || "").trim() : undefined }));
        case "splitPane":
          const dir = direction === "horizontal" ? "-h" : "-v";
          return build(`split-window ${dir} -t ${quoteShellArg(sessionName)}:${windowIndex}.${paneIndex || 0}`).then(r => ({ success: !!(r && r.success), error: (r && !r.success) ? (r.stdout || "").trim() : undefined }));
        case "sendKeys":
          const enterSuffix = enter ? " C-m" : "";
          return build(`send-keys -t ${quoteShellArg(sessionName)}:${windowIndex}.${paneIndex} ${quoteShellArg(keys || "")}${enterSuffix}`).then(r => ({ success: !!(r && r.success), error: (r && !r.success) ? (r.stdout || "").trim() : undefined }));
        case "selectWindow":
          return build(`select-window -t ${quoteShellArg(sessionName)}:${windowIndex}`).then(r => ({ success: !!(r && r.success), error: (r && !r.success) ? (r.stdout || "").trim() : undefined }));
        case "killServer":
          return build("kill-server").then(r => ({ success: !!(r && r.success), error: (r && !r.success) ? (r.stdout || "").trim() : undefined }));
        default:
          return { success: false, error: `Unknown tmux action: ${action}` };
      }
    }

    // ---------- export ----------

    return {
      probeSystemCapabilities,
      listSystemProcesses,
      signalSystemProcess,
      listTmuxSessions,
      createTmuxSession,
      listTmuxWindows,
      listTmuxPanes,
      listTmuxClients,
      tmuxAction,
      listDockerContainers,
      listDockerImages,
      getDockerStats,
      dockerInspect,
      dockerImageInspect,
      dockerAction,
      dockerImageAction,
    };
  }
}

module.exports = { createSystemOpsApi };
