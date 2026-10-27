import test from "node:test";
import assert from "node:assert/strict";

import { clampSplitRatio, ratioFromPointer } from "./resizable-split.tsx";

test("clampSplitRatio keeps panes inside their allowed range", () => {
  assert.equal(clampSplitRatio(0.5, 0.15, 0.85), 0.5);
  assert.equal(clampSplitRatio(0.01, 0.15, 0.85), 0.15);
  assert.equal(clampSplitRatio(0.99, 0.15, 0.85), 0.85);
});

test("clampSplitRatio falls back to the maximum for non-finite input", () => {
  assert.equal(clampSplitRatio(Number.NaN, 0.15, 0.85), 0.85);
});

test("ratioFromPointer maps the pointer offset onto the container", () => {
  assert.equal(ratioFromPointer(300, 100, 400, 0.15, 0.85), 0.5);
  assert.equal(ratioFromPointer(100, 100, 400, 0.15, 0.85), 0.15);
  assert.equal(ratioFromPointer(900, 100, 400, 0.15, 0.85), 0.85);
});

test("ratioFromPointer guards against a zero-height container", () => {
  assert.equal(ratioFromPointer(120, 100, 0, 0.15, 0.85), 0.85);
});
