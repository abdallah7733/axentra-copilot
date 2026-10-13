// Step 4 demo only: proves the Checks workflow turns red on a failing test, then green once fixed.
// This file lives on a throwaway PR that is closed without merging.
import { test } from "node:test";
import assert from "node:assert/strict";

test("ci demo: fixed demo test", () => {
  assert.equal(1 + 1, 2);
});
