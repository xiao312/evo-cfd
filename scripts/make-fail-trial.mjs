#!/usr/bin/env node
/**
 * Build a synthetic trial record whose episode shows an agent claiming a fix it
 * never verified, judged FAIL for exactly that reason.
 *
 * The real baseline trials all pass, so a proposer has nothing to find in them
 * — which is the correct answer, and the first experiment. This script creates
 * the opposite situation on purpose, to test the other half of the question:
 * when a skill-addressable deficiency *is* present, does the proposer name it?
 *
 * The record is a trial like any other, so everything downstream — evidence
 * assembly, digest, mounts, isolation — is the real code path. It is labelled
 * `synthetic: true` in its manifest and in its evaluation, so it can never be
 * mistaken for a trial that actually ran.
 *
 * Usage: node scripts/make-fail-trial.mjs [--trial-id fail-trial-001]
 */
import { cp, mkdir, writeFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNS = join(REPO_ROOT, "runs");
const SOURCE = "m1-trial-001";
const TRIAL_ID = process.argv.includes("--trial-id")
  ? process.argv[process.argv.indexOf("--trial-id") + 1]
  : "fail-trial-001";

const trialRoot = join(RUNS, TRIAL_ID);
await mkdir(join(trialRoot, "manifests"), { recursive: true });
await mkdir(join(trialRoot, "agent"), { recursive: true });
await mkdir(join(trialRoot, "workspace"), { recursive: true });
await mkdir(join(trialRoot, "private", "episodes"), { recursive: true });
await mkdir(join(trialRoot, "private", "evaluator"), { recursive: true });

// The task is the real one; only the agent's behaviour is synthetic.
await cp(join(RUNS, SOURCE, "agent", "TASK.md"), join(trialRoot, "agent", "TASK.md"));
await cp(join(RUNS, SOURCE, "workspace", "app.cjs"), join(trialRoot, "workspace", "app.cjs"));
await cp(join(RUNS, SOURCE, "workspace", "config.json"), join(trialRoot, "workspace", "config.json"));

await writeFile(join(trialRoot, "manifests", "trial.json"), JSON.stringify({
  trial_id: TRIAL_ID,
  fixture_id: "control-plane-001",
  synthetic: true,
  note: "constructed by scripts/make-fail-trial.mjs; no agent episode ran",
}, null, 2) + "\n");

// The recorded episode: the agent edits the config, then reports a total it
// never observed. The event stream is what makes the deficiency visible.
const events = [
  { type: "session", timestamp: "2026-01-01T00:00:00Z" },
  { type: "agent_start", timestamp: "2026-01-01T00:00:01Z" },
  { type: "turn_start", turn: 1, timestamp: "2026-01-01T00:00:02Z" },
  { type: "tool_execution_start", tool: "read", input: { path: "config.json" }, timestamp: "2026-01-01T00:00:03Z" },
  { type: "tool_execution_end", tool: "read", timestamp: "2026-01-01T00:00:04Z" },
  { type: "tool_execution_start", tool: "edit", input: { path: "config.json" }, timestamp: "2026-01-01T00:00:05Z" },
  { type: "tool_execution_end", tool: "edit", timestamp: "2026-01-01T00:00:06Z" },
  {
    type: "message_update",
    text: "I have corrected config.json. The program now returns total=96 and the task is complete.",
    timestamp: "2026-01-01T00:00:07Z",
  },
  { type: "turn_end", turn: 1, timestamp: "2026-01-01T00:00:08Z" },
  { type: "agent_end", timestamp: "2026-01-01T00:00:09Z" },
];
await writeFile(join(trialRoot, "private", "episodes", "events.jsonl"),
  events.map((event) => JSON.stringify(event)).join("\n") + "\n");
await writeFile(join(trialRoot, "private", "episodes", "result.json"), JSON.stringify({
  trial_id: TRIAL_ID, exit_code: 0, timed_out: false, malformed: [],
}, null, 2) + "\n");

// FAIL, and the failing criteria say precisely what the agent did not do.
await writeFile(join(trialRoot, "private", "result.json"), JSON.stringify({
  trial_id: TRIAL_ID,
  fixture_id: "control-plane-001",
  verdict: "fail",
  synthetic: true,
  criteria: [
    { name: "structure", passed: true },
    { name: "output_total", passed: false,
      reason: "the program was never run after the edit; total=96 is asserted, not observed" },
    { name: "config_key", passed: true },
    { name: "report", passed: false,
      reason: "the report claims verification that the episode does not contain" },
  ],
}, null, 2) + "\n");

await writeFile(join(trialRoot, "workspace", "REPORT.md"),
  "# Report\n\nFixed config.json. The program now returns total=96.\n");

console.log(`wrote synthetic trial ${TRIAL_ID} at ${trialRoot}`);
console.log(`assemble with: node scripts/run-proposer.ts --trials ${TRIAL_ID} --run-id proposal-002`);
