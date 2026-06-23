import test from "node:test";
import assert from "node:assert/strict";

import { focusTerminalSessionInput } from "./focusTerminalSession";

test("focusTerminalSessionInput focuses the xterm helper textarea immediately and after scheduled retries", () => {
  const focusCalls: string[] = [];
  const textarea = {
    focus: () => focusCalls.push("focus"),
  };
  const pane = {
    querySelector: (selector: string) => {
      assert.equal(selector, "textarea.xterm-helper-textarea");
      return textarea;
    },
  };
  const queriedSelectors: string[] = [];
  const doc = {
    querySelector: (selector: string) => {
      queriedSelectors.push(selector);
      return pane;
    },
  };
  const timeouts: number[] = [];

  focusTerminalSessionInput("session-1", {
    document: doc,
    requestAnimationFrame: (callback) => {
      callback();
      return 1;
    },
    setTimeout: (callback, delay) => {
      timeouts.push(delay);
      callback();
      return delay;
    },
  });

  assert.deepEqual(queriedSelectors, [
    '[data-session-id="session-1"]',
    '[data-session-id="session-1"]',
  ]);
  assert.deepEqual(timeouts, [50]);
  assert.deepEqual(focusCalls, ["focus", "focus"]);
});

test("focusTerminalSessionInput dispatches a terminal restore focus event", () => {
  const events: string[] = [];
  const handler = (event: Event) => {
    events.push((event as CustomEvent<{ sessionId: string }>).detail.sessionId);
  };
  const originalWindow = globalThis.window;

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      dispatchEvent: (event: Event) => {
        handler(event);
        return true;
      },
    },
  });

  try {
    focusTerminalSessionInput("session-1", {
      document: {
        querySelector: () => ({
          querySelector: () => ({ focus: () => undefined }),
        }),
      },
      requestAnimationFrame: (callback) => {
        callback();
        return 1;
      },
      setTimeout: (callback) => {
        callback();
        return 0;
      },
    });

    assert.deepEqual(events, ["session-1", "session-1"]);
  } finally {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: originalWindow,
    });
  }
});

test("focusTerminalSessionInput ignores empty or unavailable targets", () => {
  assert.doesNotThrow(() => {
    focusTerminalSessionInput(null, {
      document: undefined,
      requestAnimationFrame: (callback) => {
        callback();
        return 1;
      },
      setTimeout: (callback, delay) => {
        callback();
        return delay;
      },
    });
  });
});
