/**
 * Investigation record tests.
 *
 * What is being tested here is the *argument* layer, not the case mechanics: that
 * a question is recorded before it is answered, that the outcome separates what
 * is established from what is merely hypothesised, and that a campaign row shows
 * the gap between plan and actual rather than a summary of either.
 */

import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  campaignRow,
  readInvestigation,
  writeInvestigation,
  type InvestigationRecord,
} from "../src/investigation.ts";

const expect = assert;

function makeRecord(id: string): InvestigationRecord {
  return {
    schema_version: 1,
    investigation_id: id,
    attempt_id: id,
    prepared_attempt_digest: "a".repeat(64),
    question: {
      text: "does the deadline stop the run before the solver reaches its end time?",
      rationale: "the receipt must decide the outcome, and a budget stop must be distinguishable from a crash",
      prior_evidence: ["mascotte-startup-001: the run was stopped by an operator"],
      answerable_if: "the receipt records an exit code and a wall clock against the budget",
      falsified_if: "the receipt is absent, so the outcome can only be guessed",
    },
    plan: {
      intervention: "set a budget far shorter than the case needs, so the deadline must fire",
      expected_observations: [
        "exit code 124",
        "wall clock equal to the budget",
        "no normal End in the log",
      ],
      evaluation_method: "the receipt decides; the log is read only to report the last time reached",
      bounds: {
        budget_seconds: 240,
        requested_end_time: 1e-5,
        note: "the point is the deadline, so the interval is deliberately unreachable",
      },
    },
    actual_changes: ["controlDict endTime shortened", "budget set to 240s"],
    outcome: {
      established: [
        {
          claim: "the deadline fired and the receipt recorded it",
          evidence: "execution-receipt.txt: exit_code 124, wall_clock 240 of budget 240",
        },
      ],
      remains_open: ["whether the solver reaches 1e-5 given a full budget"],
      hypotheses: [
        { statement: "the temperature drift is wall coupling", status: "untested" },
      ],
      completion: "cut_short",
      completion_detail: "the budget stopped the run at 240s",
    },
    experience: [
      {
        lesson: "a truncated log is a budget stop, not a crash, only when the receipt says so",
        drawn_from: "the receipt's exit code",
        affects_next_question: "the next question can assume deadlines are enforceable",
      },
    ],
    evidence_refs: [{ kind: "receipt", path: "execution-receipt.txt" }],
    created_at: "2026-09-17T00:00:00Z",
  };
}

test("writeInvestigation refuses to rewrite an existing outcome", async () => {
  const dir = await mkdtemp(join(tmpdir(), "inv-"));
  await writeInvestigation(dir, makeRecord("inv-1"));
  await expect.rejects(
    () => writeInvestigation(dir, makeRecord("inv-1")),
    /not editable/,
  );
  await rm(dir, { recursive: true, force: true });
});

test("readInvestigation returns null when no question was recorded", async () => {
  const dir = await mkdtemp(join(tmpdir(), "inv-"));
  expect.equal(await readInvestigation(dir), null);
  await rm(dir, { recursive: true, force: true });
});

test("a round trip preserves the question and the outcome", async () => {
  const dir = await mkdtemp(join(tmpdir(), "inv-"));
  const rec = makeRecord("inv-2");
  await writeInvestigation(dir, rec);
  const back = await readInvestigation(dir);
  expect.equal(back?.question.text, rec.question.text);
  expect.equal(back?.outcome.completion, "cut_short");
  expect.deepEqual(back?.plan.expected_observations, rec.plan.expected_observations);
  expect.deepEqual(back?.experience.map((e) => e.lesson), rec.experience.map((e) => e.lesson));
  await rm(dir, { recursive: true, force: true });
});

test("campaignRow exposes plan versus actual, and the planned state shows it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "inv-"));
  const attempt = {
    attempt_id: "att-1",
    prepared_attempt: { digest: "b".repeat(64) },
    required_case_adaptation: ["schemes added"],
    other_changes: ["endTime shortened"],
  };
  await writeInvestigation(dir, makeRecord("inv-3"));
  const row = await campaignRow(dir, attempt);
  expect.equal(row.investigation_id, "inv-3");
  expect.equal(row.status, "assessed");
  expect.equal(row.completion, "cut_short");
  // Actual changes are what the preparer reported; planned observations are
  // what the investigation expected. The row shows both so the gap is visible.
  expect.deepEqual(row.actual_changes, [
    "controlDict endTime shortened",
    "budget set to 240s",
  ]);
  expect.equal(row.planned_observations.length, 3);
  expect.equal(row.established.length, 1);
  expect.equal(row.remains_open.length, 1);
  await rm(dir, { recursive: true, force: true });
});

test("campaignRow marks an attempt with no investigation layer, rather than reconstructing one", async () => {
  const dir = await mkdtemp(join(tmpdir(), "inv-"));
  await mkdir(dir, { recursive: true });
  const attempt = {
    attempt_id: "att-old",
    required_case_adaptation: [],
    other_changes: ["endTime shortened"],
  };
  const row = await campaignRow(dir, attempt);
  expect.equal(row.investigation_id, "none");
  expect.match(row.question, /predates/);
  expect.equal(row.prepared_attempt_digest, null);
  // The mechanical facts survive; the argument layer is reported as absent.
  expect.deepEqual(row.actual_changes, ["endTime shortened"]);
  expect.equal(row.established.length, 0);
  await rm(dir, { recursive: true, force: true });
});

test("an outcome records a hypothesis as untested, not as a finding", async () => {
  const dir = await mkdtemp(join(tmpdir(), "inv-"));
  await writeInvestigation(dir, makeRecord("inv-4"));
  const back = await readInvestigation(dir);
  const hyp = back?.outcome.hypotheses[0];
  expect.equal(hyp?.status, "untested");
  // An untested hypothesis must not appear as an established claim.
  expect.equal(
    back?.outcome.established.some((e) => e.claim.includes("wall coupling")),
    false,
  );
  await rm(dir, { recursive: true, force: true });
});

void writeFile;
