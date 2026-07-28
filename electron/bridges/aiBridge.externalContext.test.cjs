"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { buildExternalAgentSystemContext } = require("./aiBridge.cjs");

test("buildExternalAgentSystemContext (MCP mode) includes vault host vs notes guidance", () => {
  const context = buildExternalAgentSystemContext({
    mode: "mcp",
    chatSessionId: "chat-1",
  });
  assert.match(context, /vault_hosts_create/i);
  assert.match(context, /NOT vault_notes_create/i);
  assert.match(context, /do not silently create a Vault note/i);
});

test("buildExternalAgentSystemContext (MCP mode) prefers the default target session", () => {
  const context = buildExternalAgentSystemContext({
    mode: "mcp",
    chatSessionId: "chat-1",
    defaultTargetSession: {
      sessionId: "sess-default",
      label: "Mac",
      hostname: "10.106.106.5",
      protocol: "ssh",
      connected: true,
    },
  });

  assert.match(context, /default target session/i);
  assert.match(context, /sessionId="sess-default"/);
  assert.match(context, /terminal_execute/);
  assert.match(context, /instead of asking what to do or starting with get_environment/);
  assert.match(context, /current host system resources/);
  assert.match(context, /do not answer with greetings/);
});
