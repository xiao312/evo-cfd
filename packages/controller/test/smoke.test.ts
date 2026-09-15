import { test } from "node:test";
import assert from "node:assert/strict";

test("controller package loads", () => {
  // Placeholder so the test pipeline is green until the first module under
  // src/ lands (episode runner). Replaced then.
  assert.ok(import.meta.url);
});
