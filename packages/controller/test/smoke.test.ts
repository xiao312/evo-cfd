import { test } from "node:test";
import assert from "node:assert/strict";

test("controller package loads", () => {
  // Placeholder so the test pipeline is green from the first commit. Replaced
  // when the first module under src/ lands.
  assert.ok(import.meta.url);
});
