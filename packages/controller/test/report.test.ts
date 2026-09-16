/**
 * Machine-readable run reports.
 *
 * A report is the twin of a script's console output that the next step of the
 * loop can read. It summarizes and does not judge, and it is written once: a
 * report that could be revised would be able to disagree with the artifact it
 * points at.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { readReport, writeReport, type RunReport } from "../src/report.ts";

const NOW = new Date("2026-09-15T20:00:00.000Z");

async function runRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "evocfd-report-"));
  await mkdir(join(root, "private"), { recursive: true });
  return root;
}

const TRIAL_REPORT: Omit<RunReport, "created_at"> = {
  report_schema_version: 1,
  run_id: "m1-trial-001",
  run_kind: "trial",
  status: "pass",
  subject: "control-plane-001",
  trial_identity: "a".repeat(64),
  artifacts: ["private/result.json"],
};

test("report: a trial report is written and read back exactly", async () => {
  const root = await runRoot();
  try {
    const written = await writeReport({ runRoot: root, report: TRIAL_REPORT, now: () => NOW });
    assert.equal(written.created_at, NOW.toISOString());
    assert.deepEqual(await readReport(root), { ...TRIAL_REPORT, created_at: NOW.toISOString() });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("report: a report is written once and never revised", async () => {
  const root = await runRoot();
  try {
    await writeReport({ runRoot: root, report: TRIAL_REPORT, now: () => NOW });
    // A second write for the same run is refused, even with different content:
    // the report points at artifacts that cannot change, so neither may it.
    await assert.rejects(
      () => writeReport({ runRoot: root, report: { ...TRIAL_REPORT, status: "fail" }, now: () => NOW }),
      /a report already exists/,
    );
    const read = await readReport(root);
    assert.equal(read.status, "pass");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("report: a no_change proposal is a first-class status, not an absence", async () => {
  const root = await runRoot();
  try {
    const written = await writeReport({
      runRoot: root,
      report: {
        report_schema_version: 1,
        run_id: "proposal-001",
        run_kind: "proposal",
        status: "no_change",
        reason: undefined,
        subject: "evocfd:m1-baseline",
        artifacts: ["private/output/proposal.json"],
      },
      now: () => NOW,
    });
    assert.equal(written.status, "no_change");
    // A ledger reading this knows the run finished and decided, rather than
    // having to distinguish "nothing" from "not yet".
    assert.equal(written.reason, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("report: a rejected candidate carries its reason", async () => {
  const root = await runRoot();
  try {
    const written = await writeReport({
      runRoot: root,
      report: {
        report_schema_version: 1,
        run_id: "proposal-005",
        run_kind: "proposal",
        status: "rejected",
        reason: "the evidence reference does not resolve",
        subject: "evocfd:m1-baseline",
        artifacts: ["private/output/proposal.json"],
      },
      now: () => NOW,
    });
    assert.match(written.reason ?? "", /does not resolve/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("report: a built candidate points at its candidate by id, not by an escaping path", async () => {
  const root = await runRoot();
  try {
    const written = await writeReport({
      runRoot: root,
      report: {
        report_schema_version: 1,
        run_id: "proposal-004",
        run_kind: "candidate",
        status: "built",
        subject: "evocfd:m1-baseline",
        candidate_genome_id: "evocfd:m1-baseline--verify-before-claim--0975c97e",
        candidate_harness_identity: "b".repeat(64),
        parent_harness_identity: "c".repeat(64),
        proposer_harness_identity: "d".repeat(64),
        // The bundle is outside the run root, in the genomes tree; an id names
        // it without a relative path that would have to leave this directory.
        artifacts: ["private/output/proposal.json", "genome:evocfd:m1-baseline--verify-before-claim--0975c97e"],
      },
      now: () => NOW,
    });
    assert.ok(!written.artifacts.some((path) => path.startsWith("..")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("report: a report is atomic, never half-written", async () => {
  const root = await runRoot();
  try {
    // Leave a stale staging file behind, as a crashed predecessor would: the
    // rename must still land the complete report, and a reader must never see
    // a partial object.
    await writeFile(join(root, "private", ".report.json.tmp"), '{"report_schema_version":');
    await writeReport({ runRoot: root, report: TRIAL_REPORT, now: () => NOW });
    const raw = await readFile(join(root, "private", "report.json"), "utf8");
    JSON.parse(raw);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
