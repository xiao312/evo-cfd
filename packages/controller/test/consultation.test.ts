import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import {
  CONSULTATION_DECISION_DIR,
  CONSULTATION_REQUEST_DIR,
  ConsultationError,
  activeRequestDir,
  digestPath,
  listResponses,
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
} from "../src/consultation.ts";

function makeState(solverDigest: string, caseDigest: string): ConsultationState {
  return {
    solverExecutable: "/opt/of8/bin/reactingFoam",
    solverDigest,
    caseDir: "/cases/1D_advection",
    caseDigest,
    profileId: "of8-realfluid",
    libraryFiles: [
      { path: "/opt/of8/lib/libspecie.so", digest: "libspecie-digest" },
    ],
    relatedRunIds: ["job-1D-advection-001"],
  };
}

function makeRequest(): ConsultationRequest {
  return {
    requestId: "consultation-001",
    question: "Is the small temperature difference the expected physical effect?",
    whyNow: "The configuration gap is closed and the solver runs.",
    contract: {
      fixedConstraints: ["the Peng-Robinson property path must be exercised"],
      allowedChanges: ["case dictionaries", "scheme entries"],
      forbiddenChanges: ["solver source", "the evaluator"],
      conventions: ["absolute, not gauge, pressure"],
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
        id: "H1",
        label: "hypothesis",
        text: "The case's fvSchemes lacks the per-species entries.",
        source: "worker reading EEqn.H",
      },
    ],
    attempts: ["ran the target solver on the case as shipped; failed at startup"],
    workerInterpretation: "The evidence points at a configuration gap.",
    availableActions: ["edit the case dictionaries in a disposable copy"],
    limits: ["the solver source is read-only for this consultation"],
    responseRequested: ["ranked explanations", "the next bounded experiment"],
    createdAt: "2026-09-17T12:00:00.000Z",
  };
}

async function makeRun(): Promise<{
  root: string;
  caseDir: string;
  sourceDir: string;
  jobDir: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "consult-"));
  const caseDir = join(root, "case");
  const sourceDir = join(root, "source");
  const jobDir = join(root, "runs", "job-1");
  await mkdir(join(caseDir, "system"), { recursive: true });
  await writeFile(join(caseDir, "system", "fvSchemes"), "div(phi,U) Gauss linear;\n");
  await mkdir(join(sourceDir, "solvers"), { recursive: true });
  await writeFile(
    join(sourceDir, "solvers", "EEqn.H"),
    "sumHeatDiffusion2 += fvc::div(hei[k]*rho*YVi[k]);\n",
  );
  await mkdir(jobDir, { recursive: true });
  await writeFile(join(jobDir, "log.react"), "Time = 0.002\nEnd\n");
  return { root, caseDir, sourceDir, jobDir };
}

function makeResponse(digest: string, overrides: Partial<AdvisorResponse> = {}): AdvisorResponse {
  return {
    requestId: "consultation-001",
    answerText: "The case needs per-species scheme entries. Add them as follows...",
    mode: "self_review",
    provider: "pi (self-advisor)",
    displayedModel: "Atria-Dawn-Preview",
    toolsUsed: [],
    conversationRef: "local review of runs/consultation-001",
    humanContribution: "transported an unchanged response",
    requestDigest: digest,
    receivedAt: "2026-09-17T12:30:00.000Z",
    ...overrides,
  };
}

async function prepare(root: string, request = makeRequest(), supersedes = false) {
  const { caseDir, sourceDir, jobDir } = await locate(root);
  return prepareConsultation({
    runRoot: root,
    request,
    evidenceSources: [{ dir: jobDir, why: "the failing job's log", dest: "job-1" }],
    sourceExcerpts: [
      {
        file: join(sourceDir, "solvers", "EEqn.H"),
        why: "the term that fails to evaluate",
        dest: "realFluidReactingFoam/EEqn.H",
      },
    ],
    caseInputs: [{ dir: caseDir, why: "the case as shipped" }],
    supersedes,
  });
}

/** Recreate the helper directories prepare() expects, in an existing root. */
async function locate(root: string) {
  const caseDir = join(root, "case");
  const sourceDir = join(root, "source");
  const jobDir = join(root, "runs", "job-1");
  await mkdir(join(caseDir, "system"), { recursive: true });
  await writeFile(join(caseDir, "system", "fvSchemes"), "div(phi,U) Gauss linear;\n");
  await mkdir(join(sourceDir, "solvers"), { recursive: true });
  await writeFile(
    join(sourceDir, "solvers", "EEqn.H"),
    "sumHeatDiffusion2 += fvc::div(hei[k]*rho*YVi[k]);\n",
  );
  await mkdir(jobDir, { recursive: true });
  await writeFile(join(jobDir, "log.react"), "Time = 0.002\nEnd\n");
  return { root, caseDir, sourceDir, jobDir };
}

test("prepare writes a request whose digest covers the structured request", async () => {
  const root = await mkdtemp(join(tmpdir(), "consult-"));
  const prepared = await prepare(root);
  const manifest = JSON.parse(
    await readFile(join(prepared.dir, "manifest.json"), "utf8"),
  );
  assert.equal(manifest.request_id, "consultation-001");
  assert.equal(manifest.digest, prepared.digest);
  assert.equal(manifest.digest_scope, "all files except manifest.json");
  // request.json is inside the digested payload.
  const requestFile = JSON.parse(
    await readFile(join(prepared.dir, "request.json"), "utf8"),
  );
  assert.equal(requestFile.requestId, "consultation-001");
  const recomputed = await readRequestDigest(root);
  assert.equal(recomputed, prepared.digest);
  await rm(root, { recursive: true, force: true });
});

test("the digest changes when the structured request changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "consult-"));
  const a = await prepare(root);
  await rm(join(root, CONSULTATION_REQUEST_DIR), { recursive: true, force: true });
  const altered = makeRequest();
  altered.question = "a different question";
  const b = await prepare(root, altered);
  assert.notEqual(a.digest, b.digest);
  await rm(root, { recursive: true, force: true });
});

test("an existing request is not silently replaced", async () => {
  const root = await mkdtemp(join(tmpdir(), "consult-"));
  const first = await prepare(root);
  await assert.rejects(
    () => prepare(root),
    /a request already exists/,
  );
  // The original briefing survives intact.
  const question = await readFile(join(first.dir, "QUESTION.md"), "utf8");
  assert.ok(question.includes("Is the small temperature difference"));
  await rm(root, { recursive: true, force: true });
});

test("a superseding request becomes a numbered revision linked to the prior digest", async () => {
  const root = await mkdtemp(join(tmpdir(), "consult-"));
  const first = await prepare(root);
  const altered = makeRequest();
  altered.question = "a narrowed follow-up question";
  const second = await prepare(root, altered, true);
  assert.equal(second.revision, 2);
  assert.ok(second.dir.endsWith("request-r2"));
  const manifest = JSON.parse(await readFile(join(second.dir, "manifest.json"), "utf8"));
  assert.equal(manifest.revision, 2);
  assert.equal(manifest.supersedes_digest, first.digest);
  const active = await activeRequestDir(root);
  assert.equal(active?.revision, 2);
  assert.equal(active?.digest, second.digest);
  await rm(root, { recursive: true, force: true });
});

test("a response binds to the request payload, recomputed from bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "consult-"));
  const prepared = await prepare(root);
  const { responseId } = await recordResponse({
    runRoot: root,
    response: makeResponse(prepared.digest),
  });
  assert.equal(responseId, "r1");
  const meta = JSON.parse(
    await readFile(join(root, "response", "r1", "metadata.json"), "utf8"),
  );
  assert.equal(meta.request_id, "consultation-001");
  assert.equal(meta.request_digest, prepared.digest);
  await rm(root, { recursive: true, force: true });
});

test("a response whose digest does not match the payload is refused", async () => {
  const root = await mkdtemp(join(tmpdir(), "consult-"));
  await prepare(root);
  await assert.rejects(
    () => recordResponse({ runRoot: root, response: makeResponse("not-the-right-digest") }),
    /re-hashed and the digest differs/,
  );
  assert.deepEqual(await listResponses(root), []);
  await rm(root, { recursive: true, force: true });
});

test("tampering with the request payload after preparation invalidates the digest", async () => {
  const root = await mkdtemp(join(tmpdir(), "consult-"));
  const prepared = await prepare(root);
  await writeFile(
    join(prepared.dir, "source-excerpts", "realFluidReactingFoam", "EEqn.H"),
    "tampered contents\n",
  );
  await assert.rejects(
    () => recordResponse({ runRoot: root, response: makeResponse(prepared.digest) }),
    /re-hashed and the digest differs/,
  );
  await rm(root, { recursive: true, force: true });
});

test("a response for a different request id is refused", async () => {
  const root = await mkdtemp(join(tmpdir(), "consult-"));
  const prepared = await prepare(root);
  const wrong = makeResponse(prepared.digest, { requestId: "some-other-request" });
  await assert.rejects(
    () => recordResponse({ runRoot: root, response: wrong }),
    /does not match the active request/,
  );
  await rm(root, { recursive: true, force: true });
});

test("an external response must record a conversation reference", async () => {
  const root = await mkdtemp(join(tmpdir(), "consult-"));
  const prepared = await prepare(root);
  const noRef = makeResponse(prepared.digest, {
    mode: "external_web_manual",
    conversationRef: "",
  });
  await assert.rejects(
    () => recordResponse({ runRoot: root, response: noRef }),
    /must record a conversation reference/,
  );
  const withRef = makeResponse(prepared.digest, {
    mode: "external_web_manual",
    conversationRef: "https://chat.openai.com/c/abc123",
  });
  const { responseId } = await recordResponse({ runRoot: root, response: withRef });
  assert.equal(responseId, "r1");
  await rm(root, { recursive: true, force: true });
});

test("a second response is numbered, never an overwrite", async () => {
  const root = await mkdtemp(join(tmpdir(), "consult-"));
  const prepared = await prepare(root);
  await recordResponse({
    runRoot: root,
    response: makeResponse(prepared.digest, { answerText: "first answer" }),
  });
  const second = await recordResponse({
    runRoot: root,
    response: makeResponse(prepared.digest, { answerText: "second answer" }),
  });
  assert.equal(second.responseId, "r2");
  assert.deepEqual(await listResponses(root), ["r1", "r2"]);
  const first = await readFile(join(root, "response", "r1", "original-answer.md"), "utf8");
  assert.ok(first.startsWith("first answer"));
  const later = await readFile(join(root, "response", "r2", "original-answer.md"), "utf8");
  assert.ok(later.startsWith("second answer"));
  await rm(root, { recursive: true, force: true });
});

test("unmeasured state is recorded as unmeasured, not as fresh", async () => {
  const root = await mkdtemp(join(tmpdir(), "consult-"));
  const prepared = await prepare(root);
  const { responseId } = await recordResponse({
    runRoot: root,
    response: makeResponse(prepared.digest),
  });
  const decision = await recordDecision({
    runRoot: root,
    decision: {
      requestId: "consultation-001",
      responseId,
      disposition: "admit",
      outcome: "propose_experiment",
      rationale: "the evidence supports a configuration gap",
      experimentPlan: null,
      deviations: [],
    },
    currentState: null,
  });
  assert.equal(decision.freshness, "unmeasured");
  await rm(root, { recursive: true, force: true });
});

test("a changed solver state is stale; an unchanged one is fresh", async () => {
  const root = await mkdtemp(join(tmpdir(), "consult-"));
  const request = makeRequest();
  const prepared = await prepare(root, request);
  const { responseId } = await recordResponse({
    runRoot: root,
    response: makeResponse(prepared.digest),
  });
  const changed = makeState("different".padEnd(16, "0"), request.state.caseDigest);
  const stale = await recordDecision({
    runRoot: root,
    decision: {
      requestId: "consultation-001",
      responseId,
      disposition: "admit",
      outcome: "propose_experiment",
      rationale: "x",
      experimentPlan: null,
      deviations: [],
    },
    currentState: async () => changed,
  });
  assert.equal(stale.freshness, "stale");

  const fresh = await recordDecision({
    runRoot: root,
    decision: {
      requestId: "consultation-001",
      responseId,
      disposition: "admit",
      outcome: "recommend_bounded_change",
      rationale: "x",
      experimentPlan: null,
      deviations: [],
    },
    currentState: async () => request.state,
  });
  assert.equal(fresh.freshness, "fresh");
  await rm(root, { recursive: true, force: true });
});

test("an unchanged executable with different libraries is stale", async () => {
  const root = await mkdtemp(join(tmpdir(), "consult-"));
  const request = makeRequest();
  const prepared = await prepare(root, request);
  const { responseId } = await recordResponse({
    runRoot: root,
    response: makeResponse(prepared.digest),
  });
  const swapped: ConsultationState = {
    ...request.state,
    libraryFiles: [
      { path: "/opt/of8/lib/libspecie.so", digest: "a-different-libspecie" },
    ],
  };
  const decision = await recordDecision({
    runRoot: root,
    decision: {
      requestId: "consultation-001",
      responseId,
      disposition: "admit",
      outcome: "propose_experiment",
      rationale: "x",
      experimentPlan: null,
      deviations: [],
    },
    currentState: async () => swapped,
  });
  assert.equal(decision.freshness, "stale");
  await rm(root, { recursive: true, force: true });
});

test("a decision without any recorded response is refused", async () => {
  const root = await mkdtemp(join(tmpdir(), "consult-"));
  await prepare(root);
  await assert.rejects(
    () =>
      recordDecision({
        runRoot: root,
        decision: {
          requestId: "consultation-001",
          responseId: "r1",
          disposition: "admit",
          outcome: "propose_experiment",
          rationale: "x",
          experimentPlan: null,
          deviations: [],
        },
        currentState: null,
      }),
    /which is not recorded/,
  );
  await rm(root, { recursive: true, force: true });
});

test("a decision naming a nonexistent response is refused", async () => {
  const root = await mkdtemp(join(tmpdir(), "consult-"));
  const prepared = await prepare(root);
  await recordResponse({ runRoot: root, response: makeResponse(prepared.digest) });
  await assert.rejects(
    () =>
      recordDecision({
        runRoot: root,
        decision: {
          requestId: "consultation-001",
          responseId: "r9",
          disposition: "admit",
          outcome: "propose_experiment",
          rationale: "x",
          experimentPlan: null,
          deviations: [],
        },
        currentState: null,
      }),
    /which is not recorded/,
  );
  await rm(root, { recursive: true, force: true });
});

test("a rejection must state its rationale", async () => {
  const root = await mkdtemp(join(tmpdir(), "consult-"));
  const prepared = await prepare(root);
  const { responseId } = await recordResponse({
    runRoot: root,
    response: makeResponse(prepared.digest),
  });
  await assert.rejects(
    () =>
      recordDecision({
        runRoot: root,
        decision: {
          requestId: "consultation-001",
          responseId,
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

test("an admitted plan is written separately from the original answer", async () => {
  const root = await mkdtemp(join(tmpdir(), "consult-"));
  const prepared = await prepare(root);
  const { responseId } = await recordResponse({
    runRoot: root,
    response: makeResponse(prepared.digest),
  });
  await recordDecision({
    runRoot: root,
    decision: {
      requestId: "consultation-001",
      responseId,
      disposition: "admit",
      outcome: "propose_experiment",
      rationale: "the experiment discriminates between the two hypotheses",
      experimentPlan: {
        summary: "add the missing scheme entries in a disposable case copy",
        steps: ["copy the case", "add the entries", "run briefly"],
        expectedObservations: [
          { hypothesisId: "H1", ifTrue: "the solver integrates", ifFalse: "it fails elsewhere" },
        ],
        prerequisites: ["the case copy is disposable"],
        risks: ["the entries may not be the only gap"],
        stoppingConditions: ["the solver reaches the truncated end time"],
        derivedFrom: "r1",
      },
      deviations: ["the requested diagnostic was unavailable"],
    },
    currentState: null,
  });
  const plan = JSON.parse(
    await readFile(join(root, CONSULTATION_DECISION_DIR, "experiment-plan.json"), "utf8"),
  );
  assert.equal(plan.derivedFrom, "r1");
  const answer = await readFile(join(root, "response", "r1", "original-answer.md"), "utf8");
  assert.ok(answer.startsWith("The case needs per-species scheme entries"));
  await rm(root, { recursive: true, force: true });
});

test("missing evidence is missing, not invented", async () => {
  const root = await mkdtemp(join(tmpdir(), "consult-"));
  await mkdir(root, { recursive: true });
  await assert.rejects(
    () =>
      prepareConsultation({
        runRoot: root,
        request: makeRequest(),
        evidenceSources: [{ dir: join(root, "no-such-job"), why: "why", dest: "job-1" }],
        sourceExcerpts: [],
        caseInputs: [],
      }),
    /evidence source does not exist/,
  );
  await rm(root, { recursive: true, force: true });
});

test("attachments that normalize to the same destination are refused", async () => {
  const root = await mkdtemp(join(tmpdir(), "consult-"));
  const { caseDir, sourceDir } = await locate(root);
  await assert.rejects(
    () =>
      prepareConsultation({
        runRoot: root,
        request: makeRequest(),
        evidenceSources: [],
        sourceExcerpts: [
          {
            file: join(sourceDir, "solvers", "EEqn.H"),
            why: "first",
            dest: "target/EEqn.H",
          },
          {
            file: join(sourceDir, "solvers", "EEqn.H"),
            why: "second",
            dest: "target/sub/../EEqn.H",
          },
        ],
        caseInputs: [{ dir: caseDir, why: "the case" }],
      }),
    /resolve to the same destination/,
  );
  await rm(root, { recursive: true, force: true });
});

test("a destination that escapes the request package is refused", async () => {
  const root = await mkdtemp(join(tmpdir(), "consult-"));
  const { caseDir, sourceDir } = await locate(root);
  await assert.rejects(
    () =>
      prepareConsultation({
        runRoot: root,
        request: makeRequest(),
        evidenceSources: [],
        sourceExcerpts: [
          {
            file: join(sourceDir, "solvers", "EEqn.H"),
            why: "why",
            dest: "../../outside/EEqn.H",
          },
        ],
        caseInputs: [{ dir: caseDir, why: "the case" }],
      }),
    /escapes the request package/,
  );
  await rm(root, { recursive: true, force: true });
});

test("a symlink in a selected directory is refused", async () => {
  const root = await mkdtemp(join(tmpdir(), "consult-"));
  const { caseDir } = await locate(root);
  const target = join(root, "secrets.env");
  await writeFile(target, "GATEWAY_TOKEN=never-export-this\n");
  const linked = join(caseDir, "linked.env");
  try {
    await symlink(target, linked);
  } catch {
    // exFAT cannot create symlinks; the check is exercised where the platform allows it.
    await rm(root, { recursive: true, force: true });
    return;
  }
  await assert.rejects(
    () =>
      prepareConsultation({
        runRoot: root,
        request: makeRequest(),
        evidenceSources: [{ dir: caseDir, why: "the case", dest: "case" }],
        sourceExcerpts: [],
        caseInputs: [],
      }),
    /refusing to export a symlink/,
  );
  await rm(root, { recursive: true, force: true });
});

test("a credential inside a selected directory is excluded and listed", async () => {
  const root = await mkdtemp(join(tmpdir(), "consult-"));
  const { sourceDir } = await locate(root);
  const jobDir = join(root, "runs", "job-1");
  await mkdir(jobDir, { recursive: true });
  await writeFile(join(jobDir, "log.react"), "Time = 0.002\nEnd\n");
  await writeFile(join(jobDir, ".env"), "GATEWAY_TOKEN=never-export-this\n");
  await writeFile(join(jobDir, "credentials.json"), '{"token":"never-export-this"}\n');
  const prepared = await prepareConsultation({
    runRoot: root,
    request: makeRequest(),
    evidenceSources: [{ dir: jobDir, why: "the failing job's log", dest: "job-1" }],
    sourceExcerpts: [
      {
        file: join(sourceDir, "solvers", "EEqn.H"),
        why: "why",
        dest: "realFluidReactingFoam/EEqn.H",
      },
    ],
    caseInputs: [],
  });
  // The denied files were not exported...
  const exported = await readFile(join(prepared.dir, "manifest.json"), "utf8");
  const manifest = JSON.parse(exported);
  assert.ok(!manifest.contents.some((p: string) => p.endsWith(".env")));
  assert.ok(!manifest.contents.some((p: string) => p.endsWith("credentials.json")));
  // ...and their exclusion is visible in the manifest, not silent.
  const deniedNames = manifest.denied.map((d: { source: string }) => d.source);
  assert.ok(deniedNames.some((n: string) => n.endsWith(".env")));
  assert.ok(deniedNames.some((n: string) => n.endsWith("credentials.json")));
  await rm(root, { recursive: true, force: true });
});

test("a reviewed allow-name exception overrides the deny policy", async () => {
  const root = await mkdtemp(join(tmpdir(), "consult-"));
  const { sourceDir } = await locate(root);
  const jobDir = join(root, "runs", "job-1");
  await mkdir(jobDir, { recursive: true });
  await writeFile(join(jobDir, "log.react"), "Time = 0.002\nEnd\n");
  await writeFile(join(jobDir, "secret-share.md"), "a reviewed, deliberately shared note\n");
  const prepared = await prepareConsultation({
    runRoot: root,
    request: makeRequest(),
    evidenceSources: [{ dir: jobDir, why: "the log", dest: "job-1" }],
    sourceExcerpts: [
      {
        file: join(sourceDir, "solvers", "EEqn.H"),
        why: "why",
        dest: "realFluidReactingFoam/EEqn.H",
      },
    ],
    caseInputs: [],
    policy: { allowNames: ["secret-share.md"] },
  });
  const manifest = JSON.parse(await readFile(join(prepared.dir, "manifest.json"), "utf8"));
  assert.ok(manifest.contents.some((p: string) => p.endsWith("secret-share.md")));
  await rm(root, { recursive: true, force: true });
});

test("readRequest round-trips the request", async () => {
  const root = await mkdtemp(join(tmpdir(), "consult-"));
  await prepare(root);
  const back = await readRequest(root);
  assert.equal(back?.requestId, "consultation-001");
  assert.equal(back?.contract.forbiddenChanges.length, 2);
  assert.equal(back?.state.libraryFiles.length, 1);
  await rm(root, { recursive: true, force: true });
});

test("readRequestDigest is null when nothing was asked", async () => {
  const root = await mkdtemp(join(tmpdir(), "consult-"));
  assert.equal(await readRequestDigest(root), null);
  await rm(root, { recursive: true, force: true });
});

test("digestPath is stable for identical content", async () => {
  const root = await mkdtemp(join(tmpdir(), "consult-"));
  await writeFile(join(root, "a.txt"), "content\n");
  const a = await digestPath(root);
  const b = await digestPath(root);
  assert.equal(a, b);
  await writeFile(join(root, "a.txt"), "different content\n");
  assert.notEqual(a, await digestPath(root));
  await rm(root, { recursive: true, force: true });
});

test("no advisor response means the consultation stays pending", async () => {
  const root = await mkdtemp(join(tmpdir(), "consult-"));
  await prepare(root);
  const back = await readRequest(root);
  assert.equal(back?.requestId, "consultation-001");
  assert.deepEqual(await listResponses(root), []);
  await rm(root, { recursive: true, force: true });
});

void createHash;
