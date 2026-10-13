// Step 4 demo only: proves the Checks workflow turns red on a failing test.
// This file lives on a throwaway PR that is closed without merging.
import { test } from "node:test";
import assert from "node:assert/strict";

test("ci demo: deliberately failing test", () => {
  assert.equal(1 + 1, 3);
});
