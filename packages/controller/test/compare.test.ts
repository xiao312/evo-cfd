/**
 * The thinnest parent/candidate comparison.
 *
 * `compareTrials` describes two judged trials. It is deliberately unable to say
 * which harness is better, because one trial per arm cannot support that — and
 * a function that appeared to would be a bug wearing a result's clothes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { compareTrials, type TrialArm } from "../src/compare.ts";
import type { EvaluationResult } from "../src/evaluate.ts";

function result(fixtureId: string, criteria: Array<[string, boolean]>, error?: string): EvaluationResult {
  return {
    trial_id: "trial",
    fixture_id: fixtureId,
    pass: error === undefined && criteria.every(([, pass]) => pass),
    criteria: criteria.map(([criterion, pass]) => ({ criterion, pass, detail: "detail" })),
    error,
    exit_code: 0,
    budget_seconds: 10,
    elapsed_seconds: 1,
    evaluator_digest: "e".repeat(64),
    workspace_digest: "w".repeat(64),
    episode_id: "episode",
    episode_exit_code: 0,
    episode_timed_out: false,
    trial_identity: "t".repeat(64),
  };
}

function arm(genomeId: string, fixtureId: string, criteria: Array<[string, boolean]>, error?: string): TrialArm {
  return {
    genome_id: genomeId,
    harness_identity: genomeId === "parent" ? "p".repeat(64) : "c".repeat(64),
    result: result(fixtureId, criteria, error),
  };
}

test("compare: identical verdicts are reported as the same", async () => {
  const comparison = compareTrials({
    parent: arm("parent", "control-plane-001", [["report", true], ["config", true]]),
    candidate: arm("candidate", "control-plane-001", [["report", true], ["config", true]]),
  });
  assert.equal(comparison.kind, "same");
  assert.deepEqual(comparison.deltas, []);
  assert.equal(comparison.candidate_gained, false);
  assert.equal(comparison.candidate_lost, false);
});

test("compare: a criterion the candidate failed is named", async () => {
  const comparison = compareTrials({
    parent: arm("parent", "control-plane-001", [["report", true], ["config", true]]),
    candidate: arm("candidate", "control-plane-001", [["report", true], ["config", false]]),
  });
  assert.equal(comparison.kind, "differ");
  assert.deepEqual(comparison.deltas.map((delta) => delta.criterion), ["config"]);
  assert.equal(comparison.candidate_gained, false);
  assert.equal(comparison.candidate_lost, true);
});

test("compare: a criterion the candidate gained is named, and is not a promotion", async () => {
  const comparison = compareTrials({
    parent: arm("parent", "control-plane-001", [["report", false], ["config", true]]),
    candidate: arm("candidate", "control-plane-001", [["report", true], ["config", true]]),
  });
  assert.equal(comparison.kind, "differ");
  assert.equal(comparison.deltas[0].criterion, "report");
  assert.equal(comparison.candidate_gained, true);
  assert.equal(comparison.candidate_lost, false);
  // Described, not concluded: one trial per arm cannot support promotion.
  assert.equal("promote" in comparison, false);
});

test("compare: mixed movement reports both directions honestly", async () => {
  const comparison = compareTrials({
    parent: arm("parent", "control-plane-001", [["report", false], ["config", true]]),
    candidate: arm("candidate", "control-plane-001", [["report", true], ["config", false]]),
  });
  assert.equal(comparison.kind, "differ");
  assert.equal(comparison.candidate_gained, true);
  assert.equal(comparison.candidate_lost, true);
});

test("compare: arms over different fixtures are incomparable, not subtracted", async () => {
  const comparison = compareTrials({
    parent: arm("parent", "control-plane-001", [["report", true]]),
    candidate: arm("candidate", "cfd-001", [["report", true]]),
  });
  assert.equal(comparison.kind, "incomparable");
  assert.match(comparison.reason ?? "", /ran different fixtures/);
});

test("compare: an arm with no verdict is incomparable", async () => {
  const comparison = compareTrials({
    parent: arm("parent", "control-plane-001", [["report", true]], "the evaluator could not be reached"),
    candidate: arm("candidate", "control-plane-001", [["report", true]]),
  });
  assert.equal(comparison.kind, "incomparable");
  assert.match(comparison.reason ?? "", /the parent arm has no verdict/);
});

test("compare: an unjudged candidate is incomparable, never silently 'same'", async () => {
  // The trap this guards: a missing verdict on the candidate arm would read
  // as equality if the comparison only checked criteria that exist on both
  // sides. Unjudged means no conclusion, not "no change".
  const comparison = compareTrials({
    parent: arm("parent", "control-plane-001", [["report", true]]),
    candidate: arm("candidate", "control-plane-001", [["report", true]], "no verdict was recorded"),
  });
  assert.equal(comparison.kind, "incomparable");
  assert.match(comparison.reason ?? "", /the candidate arm has no verdict/);
});

test("compare: arms reporting different criteria are incomparable, never a gain", async () => {
  // The trap this guards: a criterion present only on the candidate side would
  // read as a gain if it were turned into a delta. Both arms ran the same
  // fixture, so their evaluators must agree; a mismatch means the verdicts do
  // not answer the same question.
  const comparison = compareTrials({
    parent: arm("parent", "control-plane-001", [["report", true]]),
    candidate: arm("candidate", "control-plane-001", [["report", true], ["config", true]]),
  });
  assert.equal(comparison.kind, "incomparable");
  assert.match(comparison.reason ?? "", /report different criteria/);
  assert.equal(comparison.candidate_gained, false);
});
