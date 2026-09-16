import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import {
  CONSULTATION_DECISION_DIR,
  CONSULTATION_REQUEST_DIR,
  CONSULTATION_RESPONSE_DIR,
  ConsultationError,
  digestPath,
  prepareConsultation,
  readRequest,
  readRequestDigest,
  recordDecision,
  recordResponse,
} from "../src/consultation.ts";
import type {
  AdvisorResponse,
  ConsultationRequest,
  ConsultationState,
  ProblemContract,
} from "../src/consultation.ts";

function makeState(solverDigest: string, caseDigest: string): ConsultationState {
  return {
    solverExecutable: "/opt/of8/bin/reactingFoam",
    solverDigest,
    caseDir: "/cases/1D_advection",
    caseDigest,
    profileId: "of8-realfluid",
    relatedRunIds: ["job-1D-advection-001"],
  };
}

function makeRequest(): ConsultationRequest {
  return {
    requestId: "consultation-001",
    question:
      "The target solver fails at startup on the supplied case. Identify the smallest defensible set of case changes required to exercise the intended equations.",
    whyNow: "The case is the only obstacle between a pinned solver and a first run.",
    contract: {
      fixedConstraints: [
        "The Peng-Robinson real-fluid property path must be exercised",
        "The species set and inlet conditions are mandatory",
      ],
      allowedChanges: ["case dictionaries", "scheme entries", "initialisation"],
      forbiddenChanges: [
        "solver source",
        "the physical boundary conditions",
        "the evaluator",
      ],
      conventions: [
        "absolute, not gauge, pressure",
        "sensible enthalpy with a consistent reference",
        "mass fractions, species order as declared",
      ],
    },
    state: makeState("solverdigest".padEnd(16, "0"), "casedigest".padEnd(15, "0")),
    items: [
      {
        id: "E1",
        label: "observation",
        text: "The solver exits 1 at the first species-enthalpy term.",
        source: "runs/cfd-cases/1D-advection-001/log.react line 412",
      },
      {
        id: "E2",
        label: "observation",
        text: "The error names div(((hei_O2*rho)*YVi_O2)) as undefined in fvSchemes.",
        source: "the same log",
      },
      {
        id: "H1",
        label: "hypothesis",
        text: "The case's fvSchemes was written for reactingFoam and lacks the per-species entries the target solver looks up.",
        source: "worker reading EEqn.H",
      },
      {
        id: "N1",
        label: "not_established",
        text: "Whether the failure would persist if the missing scheme entries were supplied.",
        source: "no test has been run",
      },
    ],
    attempts: [
      "ran the target solver on the case as shipped; failed at startup",
      "ran the package's reactingFoam on the same case; reached endTime",
    ],
    workerInterpretation:
      "The evidence points at a configuration gap rather than a solver defect, but I cannot confirm that the missing entries are the only obstacle.",
    availableActions: [
      "edit the case dictionaries in a disposable copy",
      "run a short bounded solver job",
    ],
    limits: [
      "the solver source is read-only for this consultation",
      "the budget is one short run",
    ],
    responseRequested: [
      "ranked explanations with supporting and conflicting evidence",
      "the next bounded experiment",
      "what each explanation predicts",
      "any prerequisite I have not listed",
    ],
    createdAt: "2026-09-16T12:00:00.000Z",
  };
}

async function makeRun(): Promise<{ root: string; caseDir: string; sourceDir: string; jobDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "consult-"));
  const caseDir = join(root, "case");
  const sourceDir = join(root, "source");
  const jobDir = join(root, "runs", "job-1");
  await mkdir(join(caseDir, "system"), { recursive: true });
  await writeFile(join(caseDir, "system", "fvSchemes"), "div(phi,U) Gauss linear;\n");
  await mkdir(join(sourceDir, "solvers"), { recursive: true });
  await writeFile(join(sourceDir, "solvers", "EEqn.H"), "sumHeatDiffusion2 += fvc::div(hei[k]*rho*YVi[k]);\n");
  await mkdir(jobDir, { recursive: true });
  await writeFile(join(jobDir, "log.react"), "Time = 0.002\nEnd\n");
  return { root, caseDir, sourceDir, jobDir };
}

test("prepareConsultation writes a request, a manifest and the frozen evidence", async () => {
  const { root, caseDir, sourceDir, jobDir } = await makeRun();
  const request = makeRequest();
  const result = await prepareConsultation({
    runRoot: root,
    request,
    evidenceSources: [{ dir: jobDir, why: "the failing job's log", dest: "job-1" }],
    sourceExcerpts: [{ file: join(sourceDir, "solvers", "EEqn.H"), why: "the term that fails to evaluate", dest: "target/EEqn.H" }],
    caseInputs: [{ dir: caseDir, why: "the case as shipped" }],
  });
  assert.ok(result.digest.length > 0);
  const manifest = JSON.parse(
    await readFile(join(result.dir, "manifest.json"), "utf8"),
  );
  assert.equal(manifest.request_id, "consultation-001");
  assert.equal(manifest.digest, result.digest);
  assert.ok(manifest.contents.some((p: string) => p.includes("EEqn.H")));
  assert.ok(manifest.contents.some((p: string) => p.includes("fvSchemes")));
  const question = await readFile(join(result.dir, "QUESTION.md"), "utf8");
  assert.ok(question.includes("OBSERVATION E1"));
  assert.ok(question.includes("WORKER HYPOTHESIS H1"));
  assert.ok(question.includes("NOT YET ESTABLISHED N1"));
  await rm(root, { recursive: true, force: true });
});

test("only the supplied artifacts appear; nothing is invented", async () => {
  const { root, caseDir, sourceDir, jobDir } = await makeRun();
  const result = await prepareConsultation({
    runRoot: root,
    request: makeRequest(),
    evidenceSources: [],
    sourceExcerpts: [{ file: join(sourceDir, "solvers", "EEqn.H"), why: "why", dest: "solvers/EEqn.H" }],
    caseInputs: [{ dir: caseDir, why: "why" }],
  });
  const manifest = JSON.parse(await readFile(join(result.dir, "manifest.json"), "utf8"));
  // A file the request never authorised is not present.
  assert.ok(!manifest.contents.some((p: string) => p.includes("secret")));
  assert.ok(!manifest.contents.some((p: string) => p.includes("evaluator")));
  await rm(root, { recursive: true, force: true });
});

test("missing scientific evidence is recorded as missing, not invented", async () => {
  const { root } = await makeRun();
  const request = makeRequest();
  // The request cites a job whose directory does not exist. Preparation must
  // fail loudly rather than ship a briefing that implies evidence it lacks.
  await assert.rejects(
    () =>
      prepareConsultation({
        runRoot: root,
        request,
        evidenceSources: [{ dir: join(root, "no-such-job"), why: "the failing job", dest: "job-1" }],
        sourceExcerpts: [],
        caseInputs: [],
      }),
    /ENOENT|no such file/i,
  );
  await rm(root, { recursive: true, force: true });
});

test("recordResponse binds an answer to the request it belongs to", async () => {
  const { root, caseDir, jobDir } = await makeRun();
  const request = makeRequest();
  const prepared = await prepareConsultation({
    runRoot: root,
    request,
    evidenceSources: [],
    sourceExcerpts: [],
    caseInputs: [{ dir: caseDir, why: "the case" }],
  });
  const response: AdvisorResponse = {
    requestId: "consultation-001",
    answerText: "The case needs per-species scheme entries. Add them as follows...",
    provider: "web chat",
    displayedModel: "Advisor Preview",
    toolsUsed: [],
    humanContribution: "transported an unchanged response",
    receivedAt: "2026-09-16T12:30:00.000Z",
  };
  await recordResponse({ runRoot: root, response, requestDigest: prepared.digest });
  const answer = await readFile(
    join(root, CONSULTATION_RESPONSE_DIR, "original-answer.md"),
    "utf8",
  );
  assert.equal(answer, response.answerText);
  await rm(root, { recursive: true, force: true });
});

test("a response for a different request package is rejected", async () => {
  const { root, caseDir, jobDir } = await makeRun();
  const prepared = await prepareConsultation({
    runRoot: root,
    request: makeRequest(),
    evidenceSources: [],
    sourceExcerpts: [],
    caseInputs: [{ dir: caseDir, why: "the case" }],
  });
  const response: AdvisorResponse = {
    requestId: "consultation-001",
    answerText: "answer",
    provider: "web chat",
    displayedModel: "Advisor Preview",
    toolsUsed: [],
    humanContribution: "transported an unchanged response",
    receivedAt: "2026-09-16T12:30:00.000Z",
  };
  await assert.rejects(
    () => recordResponse({ runRoot: root, response, requestDigest: "not-the-right-digest" }),
    ConsultationError,
  );
  await rm(root, { recursive: true, force: true });
});

test("recordResponse refuses to overwrite an existing answer", async () => {
  const { root, caseDir, jobDir } = await makeRun();
  const prepared = await prepareConsultation({
    runRoot: root,
    request: makeRequest(),
    evidenceSources: [],
    sourceExcerpts: [],
    caseInputs: [{ dir: caseDir, why: "the case" }],
  });
  const first: AdvisorResponse = {
    requestId: "consultation-001",
    answerText: "first answer",
    provider: "web chat",
    displayedModel: "Advisor Preview",
    toolsUsed: [],
    humanContribution: "transported an unchanged response",
    receivedAt: "2026-09-16T12:30:00.000Z",
  };
  await recordResponse({ runRoot: root, response: first, requestDigest: prepared.digest });
  // A second answer for the same request must not silently replace the first.
  const raw = await readFile(join(root, CONSULTATION_RESPONSE_DIR, "original-answer.md"), "utf8");
  assert.equal(raw, "first answer");
  await rm(root, { recursive: true, force: true });
});

test("a decision flags staleness when the solver or case changed", async () => {
  const { root, caseDir, jobDir } = await makeRun();
  const request = makeRequest();
  const prepared = await prepareConsultation({
    runRoot: root,
    request,
    evidenceSources: [],
    sourceExcerpts: [],
    caseInputs: [{ dir: caseDir, why: "the case" }],
  });
  const changed: ConsultationState = makeState("different".padEnd(16, "0"), request.state.caseDigest);
  const decision = await recordDecision({
    runRoot: root,
    decision: {
      requestId: "consultation-001",
      disposition: "admit",
      outcome: "propose_experiment",
      rationale: "the evidence supports a configuration gap",
      experimentPlan: null,
      deviations: [],
    },
    currentState: async () => changed,
  });
  assert.equal(decision.stale, true);
  await rm(root, { recursive: true, force: true });
});

test("a decision against an unchanged state is not stale", async () => {
  const { root, caseDir, jobDir } = await makeRun();
  const request = makeRequest();
  await prepareConsultation({
    runRoot: root,
    request,
    evidenceSources: [],
    sourceExcerpts: [],
    caseInputs: [{ dir: caseDir, why: "the case" }],
  });
  const decision = await recordDecision({
    runRoot: root,
    decision: {
      requestId: "consultation-001",
      disposition: "admit",
      outcome: "recommend_bounded_change",
      rationale: "the change is bounded and within the contract",
      experimentPlan: null,
      deviations: [],
    },
    currentState: async () => makeState(request.state.solverDigest, request.state.caseDigest),
  });
  assert.equal(decision.stale, false);
  await rm(root, { recursive: true, force: true });
});

test("a rejection must state its rationale", async () => {
  const { root, caseDir, jobDir } = await makeRun();
  await prepareConsultation({
    runRoot: root,
    request: makeRequest(),
    evidenceSources: [],
    sourceExcerpts: [],
    caseInputs: [{ dir: caseDir, why: "the case" }],
  });
  await assert.rejects(
    () =>
      recordDecision({
        runRoot: root,
        decision: {
          requestId: "consultation-001",
          disposition: "reject",
          outcome: "requires_human_decision",
          rationale: "",
          experimentPlan: null,
          deviations: [],
        },
        currentState: null,
      }),
    /a rejection must say why/,
  );
  await rm(root, { recursive: true, force: true });
});

test("a decision is not recorded when no request exists", async () => {
  const root = await mkdtemp(join(tmpdir(), "consult-"));
  await assert.rejects(
    () =>
      recordDecision({
        runRoot: root,
        decision: {
          requestId: "consultation-001",
          disposition: "admit",
          outcome: "propose_experiment",
          rationale: "x",
          experimentPlan: null,
          deviations: [],
        },
        currentState: null,
      }),
    /no consultation request/,
  );
  await rm(root, { recursive: true, force: true });
});

test("an admitted plan is written separately from the original answer", async () => {
  const { root, caseDir, jobDir } = await makeRun();
  const prepared = await prepareConsultation({
    runRoot: root,
    request: makeRequest(),
    evidenceSources: [],
    sourceExcerpts: [],
    caseInputs: [{ dir: caseDir, why: "the case" }],
  });
  await recordResponse({
    runRoot: root,
    response: {
      requestId: "consultation-001",
      answerText: "a substantive analysis",
      provider: "web chat",
      displayedModel: "Advisor Preview",
      toolsUsed: [],
      humanContribution: "transported an unchanged response",
      receivedAt: "2026-09-16T12:30:00.000Z",
    },
    requestDigest: prepared.digest,
  });
  await recordDecision({
    runRoot: root,
    decision: {
      requestId: "consultation-001",
      disposition: "admit",
      outcome: "propose_experiment",
      rationale: "the experiment discriminates between the two hypotheses",
      experimentPlan: {
        summary: "add the missing scheme entries in a disposable case copy and run briefly",
        steps: ["copy the case", "add the entries", "run to a truncated end time"],
        expectedObservations: [
          { hypothesisId: "H1", ifTrue: "the solver integrates", ifFalse: "it fails elsewhere" },
        ],
        prerequisites: ["the case copy is disposable"],
        risks: ["the entries may not be the only gap"],
        stoppingConditions: ["the solver reaches the truncated end time", "any new fatal error"],
        derivedFrom: "consultation-001 response",
      },
      deviations: ["the requested diagnostic was unavailable, so a shorter probe was used"],
    },
    currentState: null,
  });
  const plan = JSON.parse(
    await readFile(join(root, CONSULTATION_DECISION_DIR, "experiment-plan.json"), "utf8"),
  );
  assert.equal(plan.derivedFrom, "consultation-001 response");
  assert.equal(plan.expectedObservations[0].hypothesisId, "H1");
  // The original answer remains intact and separate.
  const answer = await readFile(join(root, CONSULTATION_RESPONSE_DIR, "original-answer.md"), "utf8");
  assert.equal(answer, "a substantive analysis");
  await rm(root, { recursive: true, force: true });
});

test("readRequestDigest is null when nothing was asked", async () => {
  const root = await mkdtemp(join(tmpdir(), "consult-"));
  assert.equal(await readRequestDigest(root), null);
  await rm(root, { recursive: true, force: true });
});

test("readRequest round-trips the request", async () => {
  const { root, caseDir, jobDir } = await makeRun();
  const request = makeRequest();
  await prepareConsultation({
    runRoot: root,
    request,
    evidenceSources: [],
    sourceExcerpts: [],
    caseInputs: [{ dir: caseDir, why: "the case" }],
  });
  const back = await readRequest(root);
  assert.equal(back?.requestId, "consultation-001");
  assert.equal(back?.contract.forbiddenChanges.length, 3);
  await rm(root, { recursive: true, force: true });
});

test("digestPath is stable for identical content", async () => {
  const root = await mkdtemp(join(tmpdir(), "consult-"));
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "a.txt"), "content\n");
  const a = await digestPath(root);
  const b = await digestPath(root);
  assert.equal(a, b);
  await writeFile(join(root, "a.txt"), "different content\n");
  const c = await digestPath(root);
  assert.notEqual(a, c);
  await rm(root, { recursive: true, force: true });
});

test("no advisor response means the consultation stays pending", async () => {
  const { root, caseDir, jobDir } = await makeRun();
  await prepareConsultation({
    runRoot: root,
    request: makeRequest(),
    evidenceSources: [],
    sourceExcerpts: [],
    caseInputs: [{ dir: caseDir, why: "the case" }],
  });
  // No response recorded. The request exists and the response directory does
  // not: "no answer" is not the same outcome as "no change needed".
  const back = await readRequest(root);
  assert.equal(back?.requestId, "consultation-001");
  await assert.rejects(
    () => readFile(join(root, CONSULTATION_RESPONSE_DIR, "original-answer.md")),
    /ENOENT/,
  );
  await rm(root, { recursive: true, force: true });
});

test("two excerpts with the same destination fail loudly rather than overwrite", async () => {
  const { root, sourceDir, caseDir } = await makeRun();
  // The real defect this guards: realFluidReactingFoam/EEqn.H and
  // reactingFoam/EEqn.H have the same basename. Flattening both to
  // source-excerpts/EEqn.H shipped the second under a manifest entry
  // written for the first, and the briefing became self-contradictory.
  const target = join(sourceDir, "solvers", "EEqn.H");
  const other = join(sourceDir, "solvers", "other-EEqn.H");
  await writeFile(other, "the comparison equation, without the species term\n");
  await assert.rejects(
    () =>
      prepareConsultation({
        runRoot: root,
        request: makeRequest(),
        evidenceSources: [],
        sourceExcerpts: [
          { file: target, why: "the term that fails", dest: "EEqn.H" },
          { file: other, why: "for comparison", dest: "EEqn.H" },
        ],
        caseInputs: [{ dir: caseDir, why: "the case" }],
      }),
    /two source excerpts share the destination EEqn.H/,
  );
  await rm(root, { recursive: true, force: true });
});
