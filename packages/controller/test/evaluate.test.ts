/**
 * Evaluation tests.
 *
 * The tested property is that the loop never becomes optimistic: wherever a
 * verdict cannot be obtained cleanly, the result says so and records a failure.
 * A pass that survives an evaluator failure would not be evidence of anything.
 *
 * Run with: node --experimental-strip-types --test test/*.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  EvaluationAlreadyRecordedError,
  EvaluationError,
  evaluateTrial,
  recordedResult,
  type EvaluationResult,
} from "../src/evaluate.ts";
import {
  materializeFixture,
  resetTrial,
  digestTree,
  type MaterializedTrial,
} from "../src/snapshot.ts";
import { loadFixture } from "../src/fixtures.ts";

const REPO_ROOT = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const REAL_FIXTURE_DIR = join(REPO_ROOT, "fixtures", "control-plane-001");

const staging = await mkdtemp(join(tmpdir(), "evocfd-evaluate-"));
const runsA = join(staging, "runs-a");
const runsB = join(staging, "runs-b");
await mkdir(runsA, { recursive: true });
await mkdir(runsB, { recursive: true });

const realFixture = await loadFixture(REAL_FIXTURE_DIR);

async function trial(runsDir = runsA, id = "evaluate-001"): Promise<MaterializedTrial> {
  const t = await materializeFixture({ fixture: realFixture, trialId: id, runsDir });
  await recordEpisode(t);
  return t;
}

/**
 * Record the episode a trial is judged against.
 *
 * The episode is the link between a trajectory and a verdict; judging without
 * one is refused. Tests record a synthetic episode rather than running a
 * container, and the one test that needs the absence uses `withoutEpisode`.
 */
async function recordEpisode(
  trial: MaterializedTrial,
  exitCode = 0,
  timedOut = false,
): Promise<void> {
  const dir = join(trial.layout.root, "private", "episodes", trial.trialId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "result.json"), JSON.stringify({ exitCode, timedOut }, null, 2));
}

async function withoutEpisode(trial: MaterializedTrial): Promise<void> {
  await rm(join(trial.layout.root, "private", "episodes"), { recursive: true, force: true });
}

/** Apply the intended fix: align the config key, leave the program, write the report. */
async function correct(trial: MaterializedTrial): Promise<void> {
  await writeFile(
    join(trial.layout.agentWorkspace, "config.json"),
    JSON.stringify({ units_per_kit: 12, site: "line-7" }, null, 2),
  );
  await writeFile(join(trial.layout.agentWorkspace, "REPORT.md"), "config key mismatch corrected\n");
}

/**
 * Install a synthetic evaluator in place of the materialized one.
 *
 * This is a deliberate provenance violation, used only by the test below: a
 * judge swapped in after materialization carries the digest of the judge it
 * replaced, and the evaluator boundary must refuse to execute it.
 */
async function swapEvaluator(trial: MaterializedTrial, body: string): Promise<void> {
  await rm(trial.layout.evaluator, { recursive: true, force: true });
  await mkdir(trial.layout.evaluator, { recursive: true });
  await writeFile(join(trial.layout.evaluator, "check.mjs"), body);
}

/**
 * Build a real fixture whose evaluator is `body`, then materialize it.
 *
 * The synthetic evaluators used to probe fail-closed behaviour are not swapped
 * in after the fact — that is the forgery the boundary refuses. They belong to
 * the fixture from the start, so their digest is recorded legitimately.
 */
async function trialWithEvaluator(body: string, id: string): Promise<MaterializedTrial> {
  const fixtureDir = join(staging, "fixtures", id);
  await rm(fixtureDir, { recursive: true, force: true });
  await mkdir(join(fixtureDir, "workspace"), { recursive: true });
  await mkdir(join(fixtureDir, "evaluator"), { recursive: true });
  await writeFile(join(fixtureDir, "TASK.md"), "Make the program print the right total.\n");
  await writeFile(join(fixtureDir, "workspace", "app.cjs"), "console.log('total=96');\n");
  await writeFile(join(fixtureDir, "evaluator", "check.mjs"), body);
  await writeFile(
    join(fixtureDir, "fixture.json"),
    JSON.stringify(
      {
        fixture_id: id,
        version: 2,
        task: { prompt: "TASK.md" },
        workspace: { source: "workspace" },
        evaluation: { source: "evaluator" },
        trial: { network_profile: "llm-only", max_agent_turns: 5, max_wall_seconds: 60 },
      },
      null,
      2,
    ),
  );
  const fixture = await loadFixture(fixtureDir);
  const t = await materializeFixture({ fixture, trialId: `${id}-trial`, runsDir: runsB });
  await recordEpisode(t);
  return t;
}

function asObject(result: EvaluationResult): Record<string, unknown> {
  return result as unknown as Record<string, unknown>;
}

test("the shipped evaluator fails the uncorrected workspace", async () => {
  const t = await trial();
  const result = await evaluateTrial(t);
  assert.equal(result.pass, false);
  assert.equal(result.criteria.length > 0, true);
  assert.equal(result.error, undefined, "no evaluator error: this is a judgement, not a fault");
  assert.deepEqual(
    result.criteria.filter((c) => c.pass).map((c) => c.criterion),
    ["structure"],
  );
});

test("the shipped evaluator passes the corrected workspace", async () => {
  const t = await trial(runsB);
  await correct(t);
  const result = await evaluateTrial(t);
  assert.equal(result.pass, true, JSON.stringify(result.criteria, null, 2));
  assert.equal(result.criteria.length, 4);
  assert.equal(result.exit_code, 0);
});

test("the result carries the identity of what judged what", async () => {
  const t = await trial(runsB, "evaluate-identity");
  await correct(t);
  const result = await evaluateTrial(t);
  assert.equal(result.trial_id, "evaluate-identity");
  assert.equal(result.fixture_id, "control-plane-001");
  assert.equal(result.evaluator_digest, t.evaluatorDigest);
  assert.equal(result.trial_identity, t.trialIdentity);
  assert.match(result.evaluated_at, /^\d{4}-\d{2}-\d{2}T/);
  // The workspace digest records what was judged — the agent's changed state —
  // not the pristine baseline the trial was materialized from.
  assert.equal(result.workspace_digest, (await digestTree(t.layout.agentWorkspace)).digest);
});

test("a result is recorded once and can be read back", async () => {
  const t = await trial(runsB, "evaluate-recorded");
  const result = await evaluateTrial(t);
  const recorded = await recordedResult(t.layout);
  assert.equal(recorded?.pass, result.pass);
  assert.equal(recorded?.trial_identity, result.trial_identity);
  assert.deepEqual(asObject(recorded!).criteria, asObject(result).criteria);
});

test("a trial is evaluated exactly once", async () => {
  const t = await trial(runsB, "evaluate-once");
  await evaluateTrial(t);
  await assert.rejects(() => evaluateTrial(t), (error: unknown) => {
    return error instanceof EvaluationAlreadyRecordedError;
  });
});

test("an unparseable existing result is not overwritten", async () => {
  const t = await trial(runsB, "evaluate-corrupt");
  await mkdir(t.layout.privateDir, { recursive: true });
  await writeFile(join(t.layout.privateDir, "result.json"), "{not json");
  await assert.rejects(() => evaluateTrial(t), (error: unknown) => {
    return error instanceof EvaluationAlreadyRecordedError;
  });
  assert.equal(await readFile(join(t.layout.privateDir, "result.json"), "utf8"), "{not json");
});

test("a missing evaluation package is a setup fault, not a judgement", async () => {
  const t = await trial(runsB, "evaluate-no-judge");
  await rm(t.layout.evaluator, { recursive: true, force: true });
  await assert.rejects(() => evaluateTrial(t), (error: unknown) => {
    return error instanceof EvaluationError && error.message.includes("not runnable");
  });
});

test("a trial with no recorded episode cannot be judged", async () => {
  const t = await trial(runsB, "evaluate-no-episode");
  await withoutEpisode(t);
  await assert.rejects(() => evaluateTrial(t), (error: unknown) => {
    return error instanceof EvaluationError && error.message.includes("no recorded episode");
  });
  // Nothing was judged, so no verdict exists.
  assert.equal(await recordedResult(t.layout), null);
});

test("the result names the episode it judges", async () => {
  const t = await trial(runsB, "evaluate-episode-ref");
  await withoutEpisode(t);
  await recordEpisode(t, 1, false);
  const result = await evaluateTrial(t);
  assert.equal(result.episode_id, "evaluate-episode-ref");
  assert.equal(result.episode_exit_code, 1);
  assert.equal(result.episode_timed_out, false);
});

test("a judge replaced after materialization is not executed", async () => {
  const t = await trial(runsB, "evaluate-swapped");
  await swapEvaluator(t, "console.log('i am not the recorded judge');\n");
  await assert.rejects(() => evaluateTrial(t), (error: unknown) => {
    return error instanceof EvaluationError && error.message.includes("drifted");
  });
  // The workspace was never handed to the impostor, and no verdict exists.
  assert.equal(await recordedResult(t.layout), null);
});

test("a judge that edits what it judges invalidates its own verdict", async () => {
  const t = await trialWithEvaluator(
    "import { writeFile } from 'node:fs/promises';\n" +
      "import { join } from 'node:path';\n" +
      "await writeFile(join(process.argv[2], 'tamper.txt'), 'no');\n" +
      'process.stdout.write(JSON.stringify({pass: true, criteria: [{criterion: "output", pass: true, detail: ""}]}));\n',
    "evaluate-tamper",
  );
  const result = await evaluateTrial(t);
  assert.equal(result.pass, false);
  assert.match(result.error ?? "", /modified the workspace/);
});

test("a verdict that claims pass while a criterion fails is not a pass", async () => {
  const t = await trialWithEvaluator(
    'process.stdout.write(JSON.stringify({pass: true, criteria: [{criterion: "output", pass: false, detail: "wrong"}]}));\n',
    "evaluate-inconsistent",
  );
  const result = await evaluateTrial(t);
  assert.equal(result.pass, false);
  assert.match(result.error ?? "", /claims pass=true but criterion output failed/);
});

test("a pass asserted with no criteria at all is not a pass", async () => {
  const t = await trialWithEvaluator(
    "process.stdout.write(JSON.stringify({pass: true, criteria: []}));\n",
    "evaluate-no-criteria",
  );
  const result = await evaluateTrial(t);
  assert.equal(result.pass, false);
  assert.match(result.error ?? "", /claims pass=true but reports no criteria/);
});

test("an evaluator that prints no verdict fails closed", async () => {
  const t = await trialWithEvaluator("console.log('working...');\n", "evaluate-empty");
  const result = await evaluateTrial(t);
  assert.equal(result.pass, false);
  assert.match(result.error ?? "", /printed nothing|no JSON object/);
  assert.deepEqual(result.criteria, []);
});

test("an evaluator that prints unparseable output fails closed", async () => {
  const t = await trialWithEvaluator('console.log("{almost");\n', "evaluate-garbage");
  const result = await evaluateTrial(t);
  assert.equal(result.pass, false);
  assert.match(result.error ?? "", /unparseable|no JSON object/);
});

test("an evaluator whose exit code disagrees with its verdict is not trusted", async () => {
  const t = await trialWithEvaluator(
    'process.stdout.write(JSON.stringify({pass: true, criteria: [{criterion: "ok", pass: true, detail: ""}]}));\n' +
      "process.exitCode = 1;\n",
    "evaluate-disagreement",
  );
  const result = await evaluateTrial(t);
  assert.equal(result.pass, false);
  assert.match(result.error ?? "", /exited 1/);
});

test("an evaluator that exceeds its budget is killed and fails closed", async () => {
  const t = await trialWithEvaluator("setTimeout(() => {}, 60000);\n", "evaluate-timeout");
  const result = await evaluateTrial(t, { budgetSeconds: 1 });
  assert.equal(result.pass, false);
  assert.match(result.error ?? "", /exceeded its 1s budget/);
  assert.equal(result.exit_code, null);
  assert.ok(result.elapsed_seconds >= 1, "the elapsed time is recorded");
});

test("an evaluator that crashes records the crash rather than passing", async () => {
  const t = await trialWithEvaluator("throw new Error('judge is broken');\n", "evaluate-crash");
  const result = await evaluateTrial(t);
  assert.equal(result.pass, false);
  assert.match(result.error ?? "", /printed nothing|no JSON object/);
});

test("reset clears the recorded verdict so the trial can be judged again", async () => {
  const t = await trial(runsB, "evaluate-reset");
  const first = await evaluateTrial(t);
  assert.equal(first.pass, false);
  assert.equal((await recordedResult(t.layout))?.pass, false);

  await resetTrial({ fixture: realFixture, layout: t.layout });
  assert.equal(await recordedResult(t.layout), null, "a pristine workspace has no verdict");
  await recordEpisode(t);

  await correct(t);
  const second = await evaluateTrial(t);
  assert.equal(second.pass, true, "the re-judged corrected workspace passes");
  assert.notEqual(second.evaluated_at, first.evaluated_at);
});

test("a budget is a property of the result, not of the evaluator", async () => {
  const t = await trial(runsB, "evaluate-budget");
  const result = await evaluateTrial(t, { budgetSeconds: 7 });
  assert.equal(result.budget_seconds, 7);
});
