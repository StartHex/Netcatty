const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildCursorAgentOptions,
  buildCursorSendMessage,
  mapCursorModels,
  runCursorTurn,
  toCursorMcpServers,
  translateCursorEvent,
} = require("./cursorDriver.cjs");

function makeEmitter() {
  const calls = [];
  return {
    calls,
    text: (value) => calls.push(["text", value]),
    reasoning: (value) => calls.push(["reasoning", value]),
    reasoningEnd: () => calls.push(["reasoningEnd"]),
    toolCall: (name, args, id) => calls.push(["toolCall", name, args, id]),
    toolResult: (id, result, name) => calls.push(["toolResult", id, result, name]),
    sessionId: (id) => calls.push(["sessionId", id]),
    emitDone: () => calls.push(["done"]),
    emitError: (message) => calls.push(["error", message]),
  };
}

test("buildCursorAgentOptions uses api key, model, cwd, and injected MCP servers", () => {
  const options = buildCursorAgentOptions({
    apiKey: "cur-key",
    model: "composer-2",
    cwd: "/repo",
    injectedMcpServers: [
      {
        name: "netcatty",
        command: "node",
        args: ["server.cjs"],
        env: [{ name: "TOKEN", value: "abc" }],
      },
    ],
  });

  assert.deepEqual(options, {
    apiKey: "cur-key",
    model: { id: "composer-2" },
    local: { cwd: "/repo" },
    mcpServers: {
      netcatty: {
        type: "stdio",
        command: "node",
        args: ["server.cjs"],
        env: { TOKEN: "abc" },
      },
    },
  });
});

test("buildCursorAgentOptions falls back to CURSOR_API_KEY and composer-2", () => {
  const options = buildCursorAgentOptions({
    env: { CURSOR_API_KEY: "env-key" },
    cwd: "/repo",
  });

  assert.equal(options.apiKey, "env-key");
  assert.deepEqual(options.model, { id: "composer-2" });
});

test("toCursorMcpServers drops invalid server configs", () => {
  assert.deepEqual(
    toCursorMcpServers([
      null,
      { name: "", command: "node" },
      { name: "ok", command: "node", args: [] },
    ]),
    { ok: { type: "stdio", command: "node", args: [], env: {} } },
  );
});

test("translateCursorEvent maps assistant, thinking, and tool events", () => {
  const emitter = makeEmitter();
  const state = {};

  translateCursorEvent({ type: "thinking", text: "checking" }, emitter, state);
  translateCursorEvent({
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "hello" },
        { type: "tool_use", id: "tool-1", name: "read_file", input: { path: "README.md" } },
      ],
    },
  }, emitter, state);
  translateCursorEvent({
    type: "tool_call",
    call_id: "tool-1",
    name: "read_file",
    status: "completed",
    result: { content: [{ type: "text", text: "contents" }] },
  }, emitter, state);

  assert.deepEqual(emitter.calls, [
    ["reasoning", "checking"],
    ["reasoningEnd"],
    ["text", "hello"],
    ["toolCall", "read_file", { path: "README.md" }, "tool-1"],
    ["toolResult", "tool-1", "contents", "read_file"],
  ]);
});

test("runCursorTurn creates or resumes an agent, streams events, and emits done", async () => {
  const emitter = makeEmitter();
  const captured = {};
  const sdkModule = {
    Agent: {
      async create(options) {
        captured.createOptions = options;
        return {
          agentId: "agent-new",
          async send(message) {
            captured.message = message;
            return {
              id: "run-1",
              agentId: "agent-new",
              async *stream() {
                yield { type: "assistant", message: { content: [{ type: "text", text: "done" }] } };
              },
            };
          },
          async close() {
            captured.closed = true;
          },
        };
      },
    },
  };

  const result = await runCursorTurn({
    prompt: "hi",
    attachments: [{ mediaType: "image/png", base64Data: "abc", filename: "a.png" }],
    agentOptions: { apiKey: "key", model: { id: "composer-2" }, local: { cwd: "/repo" } },
    emitter,
    sdkModule,
  });

  assert.equal(result.sessionId, "agent-new");
  assert.deepEqual(captured.message, {
    text: "hi",
    images: [{ data: "abc", mimeType: "image/png" }],
  });
  assert.deepEqual(emitter.calls, [
    ["sessionId", "agent-new"],
    ["text", "done"],
    ["done"],
  ]);
  assert.equal(captured.closed, true);
});

test("mapCursorModels maps display names and variants", () => {
  assert.deepEqual(
    mapCursorModels([
      { id: "composer-2", displayName: "Composer 2", description: "Default" },
      { id: "gpt-5", displayName: "GPT-5", variants: [{ displayName: "Fast", params: [{ id: "effort", value: "low" }] }] },
    ]),
    [
      { id: "composer-2", name: "Composer 2", description: "Default" },
      { id: "gpt-5", name: "GPT-5" },
      { id: "gpt-5?effort=low", name: "GPT-5 - Fast" },
    ],
  );
});
