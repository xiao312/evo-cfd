/**
 * Scientific consultation.
 *
 * An on-demand layer that escalates a *specific scientific question* to a
 * stronger reasoning model, with a prepared evidence package.
 *
 * The division of responsibility is the whole design, and it is the thing most
 * easy to get wrong:
 *
 *   The advisor proposes explanations and experiments.
 *   The execution agent implements and tests them.
 *   EvoCFD records what happened and controls what may be accepted.
 *
 * A stronger model should expand the system's ability to reason, not become an
 * authority whose suggestions bypass verification. Nothing here executes, and
 * nothing here authorises execution: an imported response is a recorded input,
 * never a command.
 *
 * Why this is separate from the PR 6 proposer's evidence package. That package
 * answers a narrow question — does completed evidence justify adding or
 * modifying a harness skill — and it deliberately omits the workspace, on the
 * grounds that a harness proposer should reason about the harness rather than
 * one task's files. A scientific advisor asked about a real-fluid solver needs
 * the opposite: the actual `EEqn.H`, the thermophysical routines, the case
 * dictionaries and the diagnostics. Broadening the proposer's permissions to
 * serve both would quietly erase that distinction, so this is a separate view
 * that reuses the snapshot, digest and redaction machinery instead.
 *
 * Evidence is frozen. A consultation is bound to a snapshot of the solver, the
 * case and the evidence at request time, because an advisor reasoning across a
 * workspace that changed mid-thought is not reasoning about one problem. Advice
 * that arrives against a changed state is flagged for revalidation rather than
 * applied.
 *
 * Transport is deliberately not the model. The first implementation is manual
 * export and import — a human carries the briefing to a web chat and brings the
 * answer back — because that tests the important hypothesis (does a stronger
 * advisor materially improve the next scientific decision?) before any
 * connector or automation is built. Nothing in this module knows or cares
 * whether a human or an API carried the bytes.
 */

import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { digestTree } from "./snapshot.ts";
import type { TreeDigest } from "./snapshot.ts";

/** Directory layout of one consultation, relative to its run root. */
export const CONSULTATION_REQUEST_DIR = "request";
export const CONSULTATION_RESPONSE_DIR = "response";
export const CONSULTATION_DECISION_DIR = "decision";
export const QUESTION_FILE = "QUESTION.md";
export const REQUEST_MANIFEST = "manifest.json";
export const EVIDENCE_DIR = "evidence";
export const SOURCE_EXCERPTS_DIR = "source-excerpts";
export const CASE_INPUTS_DIR = "case-inputs";
export const ANSWER_FILE = "original-answer.md";
export const RESPONSE_META = "metadata.json";
export const DISPOSITION_FILE = "disposition.json";
export const EXPERIMENT_PLAN_FILE = "experiment-plan.json";

/** What the advisor is allowed to be asked about, and what it may not touch. */
export interface ProblemContract {
  /** What must not change: mandatory physical conditions, geometry, BCs. */
  fixedConstraints: string[];
  /** What the advisor may propose within. */
  allowedChanges: string[];
  /** What is outside the advisor's authority, however good the idea. */
  forbiddenChanges: string[];
  /** Conventions that must be stated, because CFD has too many of them. */
  conventions: string[];
}

/**
 * A labelled observation, hypothesis, or open question.
 *
 * Facts and interpretations are separate types because the central failure mode
 * in scientific consultation is a summary that has already decided what the
 * stronger model is supposed to explain. "The EOS solver is unstable" is a
 * hypothesis dressed as an observation. "The recovery routine failed for this
 * input state, and whether the state is admissible is not established" is what
 * an advisor can actually work with.
 */
export type EvidenceLabel = "observation" | "hypothesis" | "not_established";

export interface LabelledItem {
  /** Stable id, e.g. E3 or H2, referenced by the briefing and the response. */
  id: string;
  label: EvidenceLabel;
  text: string;
  /** Where it came from: a file, a log line, a run id. Never empty. */
  source: string;
}

/** A piece of evidence attached in full, rather than summarised. */
export interface EvidenceAttachment {
  /** Path relative to the request directory. */
  path: string;
  /** Why this artifact is included. The advisor reads this first. */
  why: string;
}

/** The identity of the computational state a consultation is bound to. */
export interface ConsultationState {
  /** Solver executable path and its digest, at request time. */
  solverExecutable: string;
  solverDigest: string;
  /** Case directory and a digest of its inputs. */
  caseDir: string;
  caseDigest: string;
  /** Solver profile id, as in cfd-baseline/baseline.json. */
  profileId: string;
  /** Any job or run whose evidence is cited. */
  relatedRunIds: string[];
}

export type ConsultationStatus =
  | "pending"
  | "answered"
  | "admitted"
  | "clarification_requested"
  | "rejected"
  | "superseded";

export type AdvisorDisposition =
  | "admit"
  | "request_clarification"
  | "reject"
  | "defer_to_human";

export type ConsultationOutcome =
  | "request_more_evidence"
  | "propose_experiment"
  | "recommend_bounded_change"
  | "no_action_needed"
  | "requires_human_decision";

/**
 * A request for consultation. Everything here is assembled by the controller;
 * the worker's own summary is one section among many, never the whole briefing.
 */
export interface ConsultationRequest {
  requestId: string;
  question: string;
  whyNow: string;
  contract: ProblemContract;
  state: ConsultationState;
  items: LabelledItem[];
  attachments: EvidenceAttachment[];
  attempts: string[];
  workerInterpretation: string;
  availableActions: string[];
  limits: string[];
  responseRequested: string[];
  createdAt: string;
}

/** What a human or API carries back. Recorded verbatim, never normalised. */
export interface AdvisorResponse {
  requestId: string;
  /** The answer exactly as received. Normalisation is a separate artifact. */
  answerText: string;
  /** What provider/surface produced it, as displayed. */
  provider: string;
  /** The model/mode string as shown to the person who asked. */
  displayedModel: string;
  /** Whether browsing or another connector was enabled, if known. */
  toolsUsed: string[];
  /**
   * What a human contributed beyond transport. "transported an unchanged
   * response" is a materially different record from "added scientific guidance",
   * and the difference must survive to the report.
   */
  humanContribution: string;
  receivedAt: string;
}

/**
 * The controller's decision about what to do with advice. This is where
 * authority sits, and it is the only place it sits.
 */
export interface ConsultationDecision {
  requestId: string;
  disposition: AdvisorDisposition;
  outcome: ConsultationOutcome;
  /** Why the disposition is what it is; never empty for a rejection. */
  rationale: string;
  /** Solver/case digests re-measured at decision time, to catch staleness. */
  stateAtDecision: ConsultationState | null;
  /** True when the state changed between request and decision. */
  stale: boolean;
  /** A bounded plan derived from admitted advice, when one was made. */
  experimentPlan: ExperimentPlan | null;
  /** Deviations the worker recorded while executing the plan. */
  deviations: string[];
  decidedAt: string;
}

export interface ExperimentPlan {
  /** What the plan does, as a bounded statement. */
  summary: string;
  steps: string[];
  /** What result would count as evidence for and against each hypothesis. */
  expectedObservations: { hypothesisId: string; ifTrue: string; ifFalse: string }[];
  prerequisites: string[];
  risks: string[];
  /** The conditions under which the experiment should stop or escalate. */
  stoppingConditions: string[];
  /** Reference back to the response the plan was derived from. */
  derivedFrom: string;
}

/**
 * Prepare a consultation request on disk.
 *
 * The request is written into a staging directory and renamed, so a partially
 * written briefing is never the briefing an advisor sees. The manifest records
 * the digest of the frozen evidence view; the response is later bound to that
 * digest, so an answer cannot be silently re-attached to a different package.
 */
export async function prepareConsultation(input: {
  runRoot: string;
  request: ConsultationRequest;
  /** Absolute directories whose contents are copied as evidence. */
  evidenceSources: { dir: string; why: string; dest: string }[];
  /** Absolute files copied for the advisor to read directly. */
  sourceExcerpts: { file: string; why: string }[];
  caseInputs: { dir: string; why: string }[];
  now?: () => Date;
}): Promise<{ dir: string; digest: string }> {
  const requestDir = join(input.runRoot, CONSULTATION_REQUEST_DIR);
  const staging = join(input.runRoot, `${CONSULTATION_REQUEST_DIR}.tmp`);
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });

  try {
    await writeQuestion(staging, input.request);
    for (const source of input.evidenceSources) {
      const dest = join(staging, EVIDENCE_DIR, source.dest);
      await mkdir(dirname(dest), { recursive: true });
      await copyTree(source.dir, dest);
    }
    for (const excerpt of input.sourceExcerpts) {
      const dest = join(staging, SOURCE_EXCERPTS_DIR, basename(excerpt.file));
      await mkdir(join(staging, SOURCE_EXCERPTS_DIR), { recursive: true });
      await copyTree(excerpt.file, dest);
    }
    for (const caseInput of input.caseInputs) {
      const dest = join(staging, CASE_INPUTS_DIR, basename(caseInput.dir));
      await mkdir(join(staging, CASE_INPUTS_DIR), { recursive: true });
      await copyTree(caseInput.dir, dest);
    }

    // The digest covers the evidence as the advisor will see it. The manifest
    // records the digest and is not itself part of what is digested.
    const tree = await digestTree(staging);
    await writeRequestManifest(staging, input.request, tree, describeWhy(input));
    await rm(requestDir, { recursive: true, force: true });
    await rename(staging, requestDir);
    return { dir: requestDir, digest: tree.digest };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Record an advisor response against a request.
 *
 * The response is written verbatim. Any restructuring into an experiment plan
 * is a separate artifact written by `recordDecision`, with a reference back, so
 * the advisor's actual words and the controller's interpretation of them can
 * never become indistinguishable.
 */
export async function recordResponse(input: {
  runRoot: string;
  response: AdvisorResponse;
  requestDigest: string;
  now?: () => Date;
}): Promise<void> {
  const expected = await readRequestDigest(input.runRoot);
  if (expected !== input.requestDigest) {
    throw new ConsultationError(
      `response does not bind to the request at ${input.runRoot}: package digest differs`,
    );
  }
  const responseDir = join(input.runRoot, CONSULTATION_RESPONSE_DIR);
  await mkdir(responseDir, { recursive: true });
  await writeFile(
    join(responseDir, ANSWER_FILE),
    input.response.answerText,
    "utf8",
  );
  await writeFile(
    join(responseDir, RESPONSE_META),
    JSON.stringify(
      {
        schema_version: 1,
        request_id: input.response.requestId,
        request_digest: input.requestDigest,
        provider: input.response.provider,
        displayed_model: input.response.displayedModel,
        tools_used: input.response.toolsUsed,
        human_contribution: input.response.humanContribution,
        received_at: (input.now ?? (() => new Date()))().toISOString(),
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
}

/**
 * Read back the digest a request was frozen against.
 *
 * Returns null when no request exists, so a caller can distinguish "nothing was
 * asked" from "this response is for something else".
 */
export async function readRequestDigest(runRoot: string): Promise<string | null> {
  const manifestPath = join(runRoot, CONSULTATION_REQUEST_DIR, REQUEST_MANIFEST);
  try {
    const raw = await readFile(manifestPath, "utf8");
    const manifest = JSON.parse(raw) as { digest?: string };
    return manifest.digest ?? null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Decide what to do with advice, and record the decision.
 *
 * Staleness is measured here rather than assumed: the solver and case digests
 * are re-measured and compared with the request's. Advice that arrives against
 * a materially changed state is flagged, and the flag is what stops silent
 * application — not a hope that nobody noticed.
 */
export async function recordDecision(input: {
  runRoot: string;
  decision: Omit<ConsultationDecision, "stateAtDecision" | "stale">;
  /** Re-measure the current computational state, or null to skip staleness. */
  currentState: (() => Promise<ConsultationState>) | null;
  now?: () => Date;
}): Promise<ConsultationDecision> {
  const request = await readRequest(input.runRoot);
  if (!request) {
    throw new ConsultationError(`no consultation request at ${input.runRoot}`);
  }
  if (input.decision.disposition === "reject" && !input.decision.rationale.trim()) {
    throw new ConsultationError("a rejection must say why");
  }

  let stateAtDecision: ConsultationState | null = null;
  let stale = false;
  if (input.currentState) {
    stateAtDecision = await input.currentState();
    stale =
      stateAtDecision.solverDigest !== request.state.solverDigest ||
      stateAtDecision.caseDigest !== request.state.caseDigest;
  }

  const decision: ConsultationDecision = {
    ...input.decision,
    stateAtDecision,
    stale,
    decidedAt: (input.now ?? (() => new Date()))().toISOString(),
  };
  const decisionDir = join(input.runRoot, CONSULTATION_DECISION_DIR);
  await mkdir(decisionDir, { recursive: true });
  await writeFile(
    join(decisionDir, DISPOSITION_FILE),
    JSON.stringify(decision, null, 2) + "\n",
    "utf8",
  );
  if (decision.experimentPlan) {
    await writeFile(
      join(decisionDir, EXPERIMENT_PLAN_FILE),
      JSON.stringify(decision.experimentPlan, null, 2) + "\n",
      "utf8",
    );
  }
  return decision;
}

/** Read a recorded request, or null. */
export async function readRequest(
  runRoot: string,
): Promise<ConsultationRequest | null> {
  const manifestPath = join(runRoot, CONSULTATION_REQUEST_DIR, REQUEST_MANIFEST);
  try {
    const raw = await readFile(manifestPath, "utf8");
    const manifest = JSON.parse(raw) as { request?: ConsultationRequest };
    return manifest.request ?? null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** Digest a directory, for state identity. */
export async function digestPath(path: string): Promise<string> {
  const tree = await digestTree(path);
  return tree.digest;
}

export class ConsultationError extends Error {
  readonly code = "ECONSULT";
}

async function writeQuestion(dir: string, request: ConsultationRequest): Promise<void> {
  const lines: string[] = [];
  lines.push(`# Consultation ${request.requestId}`, "");
  lines.push("## Decision requested", "", request.question, "");
  lines.push("Why this matters now:", "", request.whyNow, "");
  lines.push("## Fixed problem definition", "");
  for (const c of request.contract.fixedConstraints) lines.push(`- ${c}`);
  lines.push("", "Allowed changes:", "");
  for (const c of request.contract.allowedChanges) lines.push(`- ${c}`);
  lines.push("", "Outside the advisor's authority:", "");
  for (const c of request.contract.forbiddenChanges) lines.push(`- ${c}`);
  lines.push("", "Conventions in force:", "");
  for (const c of request.contract.conventions) lines.push(`- ${c}`);
  lines.push("", "## Observed evidence, hypotheses and open questions", "");
  for (const item of request.items) {
    const label =
      item.label === "observation"
        ? "OBSERVATION"
        : item.label === "hypothesis"
          ? "WORKER HYPOTHESIS"
          : "NOT YET ESTABLISHED";
    lines.push(`**${label} ${item.id}**`, "", item.text, "");
    lines.push(`*Source: ${item.source}*`, "");
  }
  lines.push("## Attempts so far", "");
  for (const a of request.attempts) lines.push(`- ${a}`);
  lines.push("", "## Worker's interpretation", "", request.workerInterpretation, "");
  lines.push("## Available actions and limits", "");
  for (const a of request.availableActions) lines.push(`- ${a}`);
  lines.push("", "Limits:", "");
  for (const l of request.limits) lines.push(`- ${l}`);
  lines.push("", "## Response requested", "");
  for (const r of request.responseRequested) lines.push(`- ${r}`);
  lines.push(
    "",
    "If you need an artifact that is not attached, say so rather than inferring its contents.",
    "",
  );
  await writeFile(join(dir, QUESTION_FILE), lines.join("\n") + "\n", "utf8");
}

async function writeRequestManifest(
  dir: string,
  request: ConsultationRequest,
  tree: TreeDigest,
  whys: Map<string, string>,
): Promise<void> {
  await writeFile(
    join(dir, REQUEST_MANIFEST),
    JSON.stringify(
      {
        schema_version: 1,
        request_id: request.requestId,
        created_at: request.createdAt,
        digest: tree.digest,
        // The request itself, so a later reader sees the question, the contract
        // and the labelled evidence exactly as they were frozen. An advisor's
        // response is bound to this object, and a decision is checked against
        // the state recorded here.
        request,
        state: request.state,
        contract: request.contract,
        items: request.items,
        attempts: request.attempts,
        attachments: tree.files.map((path) => ({
          path,
          why: whys.get(path) ?? "included for the advisor to inspect directly",
        })),
        contents: tree.files,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
}

/**
 * Map each copied artifact to the reason it was included.
 *
 * The `why` is what an advisor reads first about an artifact, so it must be
 * attached to the file that was actually copied rather than to a path the
 * request asserted. If a source contributed nothing, no entry is invented.
 */
function describeWhy(input: {
  evidenceSources: { dir: string; why: string; dest: string }[];
  sourceExcerpts: { file: string; why: string }[];
  caseInputs: { dir: string; why: string }[];
}): Map<string, string> {
  const whys = new Map<string, string>();
  for (const source of input.evidenceSources) {
    whys.set(`${EVIDENCE_DIR}/${source.dest}`, source.why);
  }
  for (const excerpt of input.sourceExcerpts) {
    whys.set(`${SOURCE_EXCERPTS_DIR}/${basename(excerpt.file)}`, excerpt.why);
  }
  for (const caseInput of input.caseInputs) {
    whys.set(`${CASE_INPUTS_DIR}/${basename(caseInput.dir)}`, caseInput.why);
  }
  return whys;
}

async function copyTree(source: string, dest: string): Promise<void> {
  const s = await stat(source);
  if (s.isDirectory()) {
    await cp(source, dest, { recursive: true });
  } else {
    await mkdir(dirname(dest), { recursive: true });
    await cp(source, dest);
  }
}

function basename(p: string): string {
  // A Windows absolute path is one segment to a naive split; match both
  // separators so excerpts land under source-excerpts/ rather than in a
  // directory named after the whole path.
  const sep = /[/\\]/;
  const parts = p.split(sep).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

function dirname(p: string): string {
  const parts = p.split(/[/\\]/).filter(Boolean);
  parts.pop();
  return parts.length ? parts.join("/") : ".";
}

// `readdir` is re-exported for tests that inspect a package's layout.
export { readdir as _consultationReadDir };
