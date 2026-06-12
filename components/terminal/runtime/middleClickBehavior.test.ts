import assert from "node:assert/strict";
import test from "node:test";

import {
  isMiddleClickContextMenuEvent,
  markMiddleClickContextMenuEvent,
  resolveMiddleClickBehavior,
} from "./middleClickBehavior";

test("resolveMiddleClickBehavior uses the explicit middle-click behavior", () => {
  assert.equal(resolveMiddleClickBehavior({ middleClickBehavior: "context-menu" }), "context-menu");
  assert.equal(resolveMiddleClickBehavior({ middleClickBehavior: "select-word" }), "select-word");
  assert.equal(resolveMiddleClickBehavior({ middleClickBehavior: "disabled" }), "disabled");
});

test("resolveMiddleClickBehavior falls back to the legacy middle-click paste flag", () => {
  assert.equal(resolveMiddleClickBehavior({ middleClickPaste: true }), "paste");
  assert.equal(resolveMiddleClickBehavior({ middleClickPaste: false }), "disabled");
  assert.equal(resolveMiddleClickBehavior(undefined), "paste");
});

test("middle-click context menu events are identifiable", () => {
  const event = {} as MouseEvent;

  assert.equal(isMiddleClickContextMenuEvent(event), false);
  assert.equal(isMiddleClickContextMenuEvent(markMiddleClickContextMenuEvent(event)), true);
});
