import { test } from "node:test";
import assert from "node:assert/strict";
import * as controller from "../src/index.ts";

test("controller package exposes the episode runner", () => {
  assert.equal(typeof controller.runEpisode, "function");
  assert.equal(typeof controller.EpisodeAlreadyRunError, "function");
});

test("the workspace package is importable under its own name", async () => {
  // The controller imports the rsih-adapter as "@evocfd/rsih-adapter", which
  // scripts/link-workspaces.mjs must have wired into node_modules before the
  // suite runs. Resolving the controller the same way proves that wiring
  // works; a missing link fails here rather than in the middle of a campaign.
  const linked = await import("@evocfd/controller");
  assert.equal(typeof linked.runEpisode, "function");
});
