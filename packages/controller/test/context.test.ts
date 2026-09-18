/**
 * Decision-context tests.
 *
 * These test the information interface, not the file plumbing. The properties
 * that matter are the ones the reviewer named:
 *
 *   - the briefing states the objective and what is fixed, so a proposal cannot
 *     drift into changing the problem;
 *   - interventions carry intent, actual change, what was measured and what
 *     remains open, so a run archive is not mistaken for a working context;
 *   - unmeasured information stays unmeasured, and is visible as a gap;
 *   - reasoning about a change and activating it are separate permissions;
 *   - and what the assembler cannot find is reported rather than inferred.
 */
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
const expect = assert;

import {
  assembleDecisionContext,
  readDecisionContext,
  policyFor,
  capabilitiesFor,
  type ContextRole,
  type ContextPurpose,
  type DecisionContext,
  type InvestigationRecord,
} from "../src/context.ts";
import type { Dossier } from "../src/dossier.ts";
import type { ConsultationState } from "../src/consultation.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "evocfd-context-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function makeInvestigation(overrides: Partial<InvestigationRecord> = {}): InvestigationRecord {
  return {
    schema_version: 1,
    investigation_id: "inv-001",
    attempt_id: "attempt-001",
    prepared_attempt_digest: "a".repeat(64),
    question: {
      text: "Does the property recovery dominate the cost of a time step?",
      rationale: "properties are recomputed once per step and never profiled",
      prior_evidence: ["no profiling exists"],
      answerable_if: "a per-stage cost breakdown is measured",
      falsified_if: "another stage is shown to dominate by a wide margin",
    },
    plan: {
      intervention: "instrument the property recovery to report its cost",
      expected_observations: ["a cost figure with a measurement method"],
      evaluation_method: "compare against the total step cost",
      bounds: { budget_seconds: 120, requested_end_time: 1e-5, note: "a short instrumented run" },
    },
    actual_changes: ["EEqn.H: added a timing probe around the property recovery"],
    outcome: {
      established: [
        { claim: "the recovery accounts for a measurable share of the step", evidence: "instrumented run log" },
      ],
      remains_open: ["the share under a reacting workload is unknown"],
      hypotheses: [{ statement: "caching would help", status: "untested" }],
      completion: "completed",
      completion_detail: "reached the requested end time",
    },
    experience: [
      { lesson: "measure before proposing a cache", drawn_from: "this attempt", affects_next_question: "frame cost questions with a measurement first" },
    ],
    evidence_refs: [{ kind: "log", path: "runs/attempt-001/log.solver" }],
    created_at: "2026-09-17T00:00:00Z",
    ...overrides,
  };
}

function makeState(): ConsultationState {
  return {
    solverExecutable: "/opt/of8/rf-profile/bin/realFluidReactingFoam",
    solverDigest: "d".repeat(64),
    caseDir: "/data2/kexiao/EvoCFD/mascotte-g2/cases/agile-80mm",
    caseDigest: "c".repeat(64),
    profileId: "of8-realfluid-reacting",
    libraryFiles: [{ path: "/opt/of8/rf-profile/lib/libspecie.so", digest: "l".repeat(64) }],
    relatedRunIds: ["mascotte-agile-002"],
  };
}

function makeDossier(): Dossier {
  return {
    schema_version: 1,
    dossier_id: "tiny",
    solver_profile_id: "of8-realfluid-reacting",
    source_package: "pkg @ abc",
    source_digest: "s".repeat(64),
    generated_at: "2026-09-17T00:00:00Z",
    primary_variables: [{ name: "rho", advanced: false, recovered_from: "the equation of state" }],
    stages: [
      {
        id: "property-recovery",
        name: "Property recovery once per time step",
        role: "recomputes all properties after the outer loop",
        anchor: { file: "realFluidReactingFoam.C", witness: "rho = thermo.rho();" },
        advances: [],
        lags: [],
        implicit_terms: [],
        explicit_terms: [],
        recomputes: ["rho", "mu", "Cp"],
        convergence_check: null,
        clipping_or_fallback: null,
        used_by: [],
        known_evidence: [{ claim: "PR is active", source: "baseline", basis: "measured" }],
        unknown: ["whether the recovery dominates cost"],
      },
    ],
    interfaces: [],
    diagnostics: [
      {
        id: "courant",
        name: "Courant from the log",
        measures: "the max Courant number",
        does_not_measure: ["the domain distribution"],
        how: "read the log",
        known_evidence: [],
      },
    ],
    unknown: ["nothing is profiled"],
  };
}

async function assemble(
  role: ContextRole,
  purpose: ContextPurpose,
  overrides: { investigation?: Partial<InvestigationRecord>; attempts?: number } = {},
): Promise<DecisionContext> {
  const investigation = makeInvestigation(overrides.investigation ?? {});
  const attemptDir = join(dir, "attempt-001");
  await mkdir(attemptDir, { recursive: true });
  await writeFile(
    join(attemptDir, "investigation.json"),
    JSON.stringify(investigation),
    "utf8",
  );
  return assembleDecisionContext({
    runRoot: dir,
    investigation,
    dossier: makeDossier(),
    dossierVerification: { ok: true, failures: [] },
    state: makeState(),
    role,
    purpose,
    attemptDirs: overrides.attempts === 0 ? [] : [attemptDir],
    now: () => new Date("2026-09-17T12:00:00Z"),
  });
}

test("the briefing states the objective and what is fixed", async () => {
  const c = await assemble("scientific_advisor", "algorithm_design");
  expect.ok(c.briefing.includes("Objective"));
  expect.ok(c.briefing.includes("Fixed"));
  expect.ok(c.fixed.length >= 3);
  // The operating point is fixed for an algorithm question, so a proposal that
  // would change the problem is out of scope by construction.
  expect.ok(c.fixed.some((f) => f.includes("operating point")));
});

test("an intervention carries intent, actual change and open questions", async () => {
  const c = await assemble("scientific_advisor", "algorithm_design");
  expect.equal(c.interventions.length, 1);
  const v = c.interventions[0];
  expect.ok(v.intent.includes("property recovery"));
  expect.deepEqual(v.actual_changes, ["EEqn.H: added a timing probe around the property recovery"]);
  expect.ok(v.remains_open.length > 0);
  expect.ok(v.established.length > 0);
  // Competing interpretations are carried with a status, not flattened.
  expect.ok(v.hypotheses.some((h) => h.status === "untested"));
});

test("unmeasured information is reported as a gap, not filled", async () => {
  const c = await assemble("scientific_advisor", "algorithm_design");
  expect.ok(c.current_state.unmeasured.length > 0);
  expect.ok(c.current_state.unmeasured.some((u) => u.includes("dominates cost")));
  expect.ok(c.briefing.includes("Not measured"));
});

test("the dossier's own unknowns reach the briefing", async () => {
  const c = await assemble("scientific_advisor", "case_diagnosis");
  expect.ok(c.current_state.unmeasured.some((u) => u.includes("nothing is profiled")));
});

test("an advisor may request an experiment but not activate it", async () => {
  const c = await assemble("scientific_advisor", "algorithm_design");
  const caps = capabilitiesFor("scientific_advisor", "algorithm_design");
  // Reasoning about a change and activating it are separate permissions.
  expect.ok(caps.every((cap) => cap.permission !== "invoke" || cap.id === "inspect-symbol" || cap.id === "extract-diagnostic" || cap.id === "compare-attempts"));
  // The capabilities that change state are request-only for an advisor.
  const create = caps.find((cap) => cap.id === "create-candidate");
  expect.equal(create?.permission, "request_only");
  // And the briefing says so.
  expect.ok(c.briefing.includes("create-candidate") || c.briefing.includes("Create a disposable"));
});

test("the execution agent may invoke state-changing capabilities", async () => {
  const caps = capabilitiesFor("execution_agent", "experiment_execution");
  const create = caps.find((cap) => cap.id === "create-candidate");
  expect.equal(create?.permission, "invoke");
});

test("the task diff is withheld from a diagnosis but supplied to a proposer", () => {
  expect.equal(policyFor("scientific_advisor", "case_diagnosis").include_task_diff, false);
  expect.equal(policyFor("harness_proposer", "harness_improvement").include_task_diff, true);
  expect.equal(policyFor("scientific_advisor", "algorithm_design").include_task_diff, true);
  // The evaluator's internals are never in any view.
  for (const role of ["execution_agent", "scientific_advisor", "harness_proposer", "human_reviewer"] as ContextRole[]) {
    for (const purpose of ["case_diagnosis", "algorithm_design", "harness_improvement", "experiment_execution"] as ContextPurpose[]) {
      expect.equal(policyFor(role, purpose).include_evaluator_internals, false);
    }
  }
});

test("a missing actual change is reported, not reconstructed", async () => {
  const c = await assemble("scientific_advisor", "algorithm_design", {
    investigation: makeInvestigation({ actual_changes: [] }),
  });
  expect.ok(c.missing.some((m) => m.includes("actual changes")));
  expect.ok(c.briefing.includes("not linked"));
});

test("a missing experience selection is reported", async () => {
  const c = await assemble("scientific_advisor", "algorithm_design", {
    investigation: makeInvestigation({ experience: [] }),
  });
  expect.ok(c.missing.some((m) => m.includes("experience")));
});

test("an attempt with no investigation record is not silently summarised", async () => {
  const c = await assemble("scientific_advisor", "algorithm_design", { attempts: 0 });
  expect.equal(c.interventions.length, 0);
  expect.ok(c.briefing.includes("No prior intervention is recorded"));
});

test("the evaluation contract names the transfer requirement", async () => {
  const c = await assemble("scientific_advisor", "algorithm_design");
  expect.ok(c.evaluation_contract.transfer_domain.includes("not used to choose the change"));
  expect.ok(c.evaluation_contract.quality_constraints.length >= 3);
  expect.ok(c.briefing.includes("What would count as improvement"));
});

test("the context is persisted and re-read identically", async () => {
  const c = await assemble("scientific_advisor", "algorithm_design");
  const reread = await readDecisionContext(dir);
  expect.notEqual(reread, null);
  expect.equal(reread?.context_id, c.context_id);
  expect.equal(reread?.digest, c.digest);
  expect.equal(reread?.briefing, c.briefing);
});

test("the digest binds a citation to a context", async () => {
  const a = await assemble("scientific_advisor", "algorithm_design");
  const b = await assemble("scientific_advisor", "case_diagnosis");
  // Different purposes produce different contexts, so a citation naming a
  // digest cannot be satisfied by the context for another purpose.
  expect.notEqual(a.digest, b.digest);
});

test("the dossier verification state reaches the context", async () => {
  const investigation = makeInvestigation();
  const attemptDir = join(dir, "attempt-001");
  await mkdir(attemptDir, { recursive: true });
  await writeFile(join(attemptDir, "investigation.json"), JSON.stringify(investigation), "utf8");
  const c = await assembleDecisionContext({
    runRoot: dir,
    investigation,
    dossier: makeDossier(),
    dossierVerification: { ok: false, failures: [{ entry: "stage:property-recovery" }] },
    state: makeState(),
    role: "scientific_advisor",
    purpose: "algorithm_design",
    attemptDirs: [attemptDir],
    now: () => new Date("2026-09-17T12:00:00Z"),
  });
  expect.equal(c.dossier.verified, false);
  expect.deepEqual(c.dossier.unverified_entries, ["stage:property-recovery"]);
});

test("algorithm summary distinguishes advanced from recovered variables", async () => {
  const c = await assemble("scientific_advisor", "case_diagnosis");
  expect.ok(c.algorithm_summary.includes("advances"));
  expect.ok(c.algorithm_summary.includes("recomputes"));
});
