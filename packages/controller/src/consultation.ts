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
 * Why this is separate from the skill proposer's evidence package. That package
 * answers a narrow question — does completed evidence justify adding or
 * modifying a harness skill — and it deliberately omits the workspace, on the
 * grounds that a harness proposer should reason about the harness rather than
 * one task's files. A scientific advisor asked about a real-fluid solver needs
 * the opposite: the actual `EEqn.H`, the thermophysical routines, the case
 * dictionaries and the diagnostics. Broadening the proposer's permissions to
 * serve both would quietly erase that distinction, so this is a separate view
 * that reuses the snapshot, digest and redaction machinery instead.
 *
 * Records are immutable, and that is enforced by the filesystem rather than by
 * convention. A request is frozen once and superseded, never replaced; a
 * response is written with exclusive creation, so a second answer for the same
 * request becomes an explicitly numbered second response rather than a silent
 * overwrite of the first; a decision names the response it refers to. This
 * matters because an advisor's answer that has been swapped underneath its
 * decision is not attributable, and an unattributable decision is not a
 * scientific record.
 *
 * The digest binds an answer to the package that was actually exported, not to
 * a digest string someone asserted. On import the payload is re-hashed from the
 * request directory, and the request identity in the response is checked
 * against the request's own identity. These checks bind records together; they
 * do not prove which model read which bytes — that remains operator-attested.
 *
 * Transport is deliberately not the model. The first implementation is manual
 * export and import — a human carries the briefing to a web chat and brings the
 * answer back — which is a legitimate external consultation with human
 * transport, not a substitute for one. Nothing in this module knows or cares
 * whether a human or an API carried the bytes, but the mode is recorded, so a
 * same-model self-review can never be mistaken for an external advisor.
 */

import { cp, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import { digestTree } from "./snapshot.ts";
import type { TreeDigest } from "./snapshot.ts";

/** Directory layout of one consultation, relative to its run root. */
export const CONSULTATION_REQUEST_DIR = "request";
export const CONSULTATION_RESPONSE_DIR = "response";
export const CONSULTATION_DECISION_DIR = "decision";
export const QUESTION_FILE = "QUESTION.md";
export const REQUEST_FILE = "request.json";
export const REQUEST_MANIFEST = "manifest.json";
export const EVIDENCE_DIR = "evidence";
export const SOURCE_EXCERPTS_DIR = "source-excerpts";
export const CASE_INPUTS_DIR = "case-inputs";
export const RESPONSE_INDEX = "index.json";

/** Directory layout of one response. Responses are numbered, never replaced. */
export const responseDir = (runRoot: string, responseId: string) =>
  join(runRoot, CONSULTATION_RESPONSE_DIR, responseId);
export const ANSWER_FILE = "original-answer.md";
export const RESPONSE_META = "metadata.json";
export const DISPOSITION_FILE = "disposition.json";
export const EXPERIMENT_PLAN_FILE = "experiment-plan.json";

/**
 * What a consultation record may not contain.
 *
 * Copying a directory of evidence copies everything in it, including files
 * nobody meant to send. A `.env` or a credential file riding along inside an
 * exported evidence tree is a disclosure failure that produces no error, so the
 * policy is applied explicitly and every file it stops is *recorded* in the
 * manifest rather than silently dropped. A silent exclusion is indistinguishable
 * from an incomplete export; a listed one is auditable.
 */
export interface ExportPolicy {
  /** Basename patterns never exported. Matched case-insensitively. */
  denyNamePatterns: string[];
  /** Files at least this large are not exported. */
  maxBytes: number;
  /** Basenames reviewed and allowed despite matching a deny pattern. */
  allowNames: string[];
}

export const DEFAULT_EXPORT_POLICY: ExportPolicy = {
  denyNamePatterns: [
    ".env",
    "*.env",
    "env",
    ".npmrc",
    ".pypirc",
    ".netrc",
    "id_rsa",
    "id_rsa.pub",
    "id_ed25519",
    "*.pem",
    "*.key",
    "*.p12",
    "*.kdbx",
    "shadow",
    "*token*",
    "*credential*",
    "*secret*",
    "*password*",
    "*.kas*",
  ],
  maxBytes: 64 * 1024 * 1024,
  allowNames: [],
};

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
 *
 * Labels organise a briefing; they do not certify it. The API can check that
 * every item has a non-empty source, not that an observation is true. Evidence
 * review stays an explicit step.
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

/**
 * How an advisor response reached this project.
 *
 * The distinction is not cosmetic. A same-model self-review and a human carrying
 * a briefing to a stronger web model are different evidence about different
 * hypotheses, and the record must be able to tell them apart years later. There
 * is deliberately no route by which an unavailable external advisor falls back to
 * the executor model while still being recorded as a successful external
 * consultation — that would measure nothing while claiming everything.
 */
export type AdvisorMode =
  /** The executor model reviews its own or another local episode. Integration test only. */
  | "self_review"
  /** A human submitted the frozen request to an external web application and returned its response. */
  | "external_web_manual"
  /** An external web advisor retrieved permitted evidence through a recorded connector. */
  | "external_web_connected"
  /** A separately configured provider/model called through its official API. */
  | "external_api"
  /** The requested external route is not operational; no consultation occurred. */
  | "unavailable";

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
  /**
   * Files whose digests identify the runtime library set, not only the
   * executable. An unchanged executable can resolve different libraries, which
   * is the ambiguity this project has already identified in the real-fluid
   * profile; the executable alone does not pin the physics.
   */
  libraryFiles: { path: string; digest: string }[];
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
 * Measured freshness of the state an answer is being decided against.
 *
 * Three states, because "we did not check" is a different fact from "we checked
 * and it changed", and recording both as `stale: false` made an unmeasured
 * consultation look execution-ready.
 */
export type Freshness = "fresh" | "stale" | "unmeasured";

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
  /** How this response reached the project. See AdvisorMode. */
  mode: AdvisorMode;
  /** What provider/surface produced it, as displayed to the person who asked. */
  provider: string;
  /** The model/mode string as shown to the person who asked. */
  displayedModel: string;
  /** Whether browsing or another connector was enabled, if known. */
  toolsUsed: string[];
  /**
   * A conversation reference the operator can resolve: a URL, a share link, or a
   * local transcript id. Empty only for `self_review`.
   */
  conversationRef: string;
  /**
   * What a human contributed beyond transport. "transported an unchanged
   * response" is a materially different record from "added scientific guidance",
   * and the difference must survive to the report.
   */
  humanContribution: string;
  /**
   * The digest of the request payload as the exporter measured it. On import the
   * payload is re-hashed and compared, so this binds the answer to bytes rather
   * than to an assertion.
   */
  requestDigest: string;
  receivedAt: string;
}

/**
 * The controller's decision about what to do with advice. This is where
 * authority sits, and it is the only place it sits.
 */
export interface ConsultationDecision {
  requestId: string;
  /** Which response this decision is about. A decision without a response is refused. */
  responseId: string;
  disposition: AdvisorDisposition;
  outcome: ConsultationOutcome;
  /** Why the disposition is what it is; never empty for a rejection. */
  rationale: string;
  /** Solver/case state re-measured at decision time, to catch staleness. */
  stateAtDecision: ConsultationState | null;
  /** Whether the state still matches the request's. */
  freshness: Freshness;
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
 * written briefing is never the briefing an advisor sees.
 *
 * Immutability: an existing request is never deleted or replaced. A corrected
 * briefing is a *revision*, written to `request-rN/` and linked to the digest of
 * the one it supersedes. Silently replacing a request would detach any answer
 * already recorded against it.
 *
 * The digest covers the whole exported payload *including* the canonical
 * `request.json`, so the structured request — question, contract, state,
 * labelled evidence — is part of what an answer is bound to. Only the manifest
 * envelope sits outside the digest.
 */
export async function prepareConsultation(input: {
  runRoot: string;
  request: ConsultationRequest;
  /** Absolute directories whose contents are copied as evidence. */
  evidenceSources: { dir: string; why: string; dest: string }[];
  /** Absolute files copied for the advisor to read directly. */
  sourceExcerpts: { file: string; why: string; dest: string }[];
  /** Absolute case directories copied as inputs. `dest` defaults to the basename. */
  caseInputs: { dir: string; why: string; dest?: string }[];
  /** Create a superseding revision instead of failing on an existing request. */
  supersedes?: boolean;
  policy?: Partial<ExportPolicy>;
  now?: () => Date;
}): Promise<{ dir: string; digest: string; revision: number }> {
  const policy = { ...DEFAULT_EXPORT_POLICY, ...input.policy };
  const existing = await activeRequestDir(input.runRoot);
  let revision = 1;
  let requestDir = join(input.runRoot, CONSULTATION_REQUEST_DIR);
  let priorDigest: string | null = null;
  if (existing) {
    if (!input.supersedes) {
      throw new ConsultationError(
        `a request already exists at ${existing.dir}; pass supersedes: true to create a revision rather than replacing it`,
      );
    }
    revision = existing.revision + 1;
    requestDir = join(input.runRoot, `${CONSULTATION_REQUEST_DIR}-r${revision}`);
    priorDigest = existing.digest;
  }

  // Resolved to an absolute path: a relative runRoot would make `staging`
  // relative while `resolve(staging, dest)` below is absolute, so the
  // containment comparison would compare a relative prefix against an absolute
  // path and reject every evidence destination as an escape.
  const staging = resolve(join(input.runRoot, `${CONSULTATION_REQUEST_DIR}.tmp`));
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });

  // Destinations are resolved inside the staging root and checked for
  // uniqueness on the *resolved* path, across every attachment class. Two
  // equation files named EEqn.H in different solvers are different files; so
  // are `EEqn.H` and `sub/../EEqn.H`, which a raw-string check would miss.
  const claimed = new Map<string, string>();
  const deny: { source: string; reason: string }[] = [];

  const reserve = (kind: string, absSource: string, relDest: string): string => {
    const resolved = resolve(staging, relDest);
    if (resolved !== staging && !resolved.startsWith(staging + sep)) {
      throw new ConsultationError(
        `${kind} destination ${relDest} escapes the request package`,
      );
    }
    const key = relative(staging, resolved);
    const prior = claimed.get(key);
    if (prior !== undefined) {
      throw new ConsultationError(
        `two attachments resolve to the same destination ${key}: ${prior} and ${absSource}`,
      );
    }
    claimed.set(key, absSource);
    return resolved;
  };

  try {
    await writeQuestion(staging, input.request);
    await writeFile(
      join(staging, REQUEST_FILE),
      stableStringify(input.request) + "\n",
      "utf8",
    );

    for (const source of input.evidenceSources) {
      const dest = reserve("evidence", source.dir, join(EVIDENCE_DIR, source.dest));
      await copyFiltered(source.dir, dest, policy, deny);
    }
    for (const excerpt of input.sourceExcerpts) {
      const dest = reserve(
        "source-excerpt",
        excerpt.file,
        join(SOURCE_EXCERPTS_DIR, excerpt.dest),
      );
      await copyFiltered(excerpt.file, dest, policy, deny);
    }
    for (const caseInput of input.caseInputs) {
      const dest = reserve(
        "case-input",
        caseInput.dir,
        join(CASE_INPUTS_DIR, caseInput.dest ?? basename(caseInput.dir)),
      );
      await copyFiltered(caseInput.dir, dest, policy, deny);
    }

    // The digest covers the exported payload as the advisor will see it,
    // including the structured request. The manifest is the envelope and is
    // excluded, so it can record the digest without being part of it.
    const tree = await digestTree(staging, [REQUEST_MANIFEST]);
    await writeRequestManifest(staging, input.request, tree, deny, {
      revision,
      supersedesDigest: priorDigest,
    });

    await rm(requestDir, { recursive: true, force: true });
    await rename(staging, requestDir);
    return { dir: requestDir, digest: tree.digest, revision };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Record an advisor response against the active request.
 *
 * The response is written verbatim, with exclusive creation, so an existing
 * answer can never be overwritten. A second response for the same request is an
 * explicitly numbered second response (`r2`), and a decision must name which one
 * it refers to.
 *
 * The request payload is re-hashed here and compared with the digest the
 * response carries, and the response's request id is checked against the
 * request's own id. An answer that does not belong to this request is refused —
 * including one whose supplied digest merely happens to equal the stored string
 * while the bytes on disk are something else.
 */
export async function recordResponse(input: {
  runRoot: string;
  response: AdvisorResponse;
  now?: () => Date;
}): Promise<{ responseId: string }> {
  const active = await activeRequestDir(input.runRoot);
  if (!active) {
    throw new ConsultationError(`no consultation request at ${input.runRoot}`);
  }
  const measured = await digestRequestPackage(active.dir);
  if (measured !== input.response.requestDigest) {
    throw new ConsultationError(
      `response does not bind to the request at ${active.dir}: the request payload was re-hashed and the digest differs`,
    );
  }
  if (input.response.requestId !== active.requestId) {
    throw new ConsultationError(
      `response request id ${input.response.requestId} does not match the active request ${active.requestId}`,
    );
  }
  if (input.response.mode !== "self_review" && !input.response.conversationRef.trim()) {
    throw new ConsultationError(
      `an external response must record a conversation reference; use mode "self_review" for a local review`,
    );
  }

  const responseId = await nextResponseId(input.runRoot);
  const dir = responseDir(input.runRoot, responseId);
  await mkdir(join(input.runRoot, CONSULTATION_RESPONSE_DIR), { recursive: true });
  await mkdir(dir, { recursive: true });

  // Exclusive creation: a second answer under the same id is a filesystem
  // error, not a quiet replacement.
  await writeFile(join(dir, ANSWER_FILE), input.response.answerText + "\n", {
    encoding: "utf8",
    flag: "wx",
  });
  await writeFile(
    join(dir, RESPONSE_META),
    JSON.stringify(
      {
        schema_version: 1,
        response_id: responseId,
        request_id: input.response.requestId,
        request_digest: input.response.requestDigest,
        mode: input.response.mode,
        provider: input.response.provider,
        displayed_model: input.response.displayedModel,
        tools_used: input.response.toolsUsed,
        conversation_ref: input.response.conversationRef,
        human_contribution: input.response.humanContribution,
        received_at: (input.now ?? (() => new Date()))().toISOString(),
      },
      null,
      2,
    ) + "\n",
    { encoding: "utf8", flag: "wx" },
  );
  await writeResponseIndex(input.runRoot, responseId, input.response);
  return { responseId };
}

/**
 * Decide what to do with advice, and record the decision.
 *
 * Freshness is measured rather than assumed: the solver and case digests are
 * re-measured and compared with the request's. An unmeasured state is recorded
 * as `unmeasured`, which is a different fact from `fresh`, and it must not be
 * treated as execution-ready advice.
 *
 * A decision to admit requires a recorded response, and names the response it
 * refers to. A decision about no answer at all is not a decision about advice.
 */
export async function recordDecision(input: {
  runRoot: string;
  decision: Omit<ConsultationDecision, "stateAtDecision" | "freshness">;
  /** Re-measure the current computational state, or null when it cannot be measured. */
  currentState: (() => Promise<ConsultationState>) | null;
  now?: () => Date;
}): Promise<ConsultationDecision> {
  const active = await activeRequestDir(input.runRoot);
  if (!active) {
    throw new ConsultationError(`no consultation request at ${input.runRoot}`);
  }
  const request = await readRequest(input.runRoot);
  if (!request) {
    throw new ConsultationError(
      `the active request at ${active.dir} has no readable ${REQUEST_FILE}`,
    );
  }
  if (input.decision.disposition === "reject" && !input.decision.rationale.trim()) {
    throw new ConsultationError("a rejection must say why");
  }
  if (!input.decision.responseId.trim()) {
    throw new ConsultationError("a decision must name the response it refers to");
  }
  const responses = await listResponses(input.runRoot);
  if (!responses.includes(input.decision.responseId)) {
    throw new ConsultationError(
      `decision refers to response ${input.decision.responseId}, which is not recorded at ${input.runRoot}`,
    );
  }

  let stateAtDecision: ConsultationState | null = null;
  let freshness: Freshness = "unmeasured";
  if (input.currentState) {
    stateAtDecision = await input.currentState();
    const solverChanged =
      stateAtDecision.solverDigest !== request.state.solverDigest;
    const caseChanged =
      stateAtDecision.caseDigest !== request.state.caseDigest;
    const libsChanged = !sameLibraries(
      stateAtDecision.libraryFiles ?? [],
      request.state.libraryFiles ?? [],
    );
    freshness = solverChanged || caseChanged || libsChanged ? "stale" : "fresh";
  }

  const decision: ConsultationDecision = {
    ...input.decision,
    stateAtDecision,
    freshness,
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

/**
 * The active (latest) request directory, its revision number, its request id,
 * and the digest its payload was frozen at. Returns null when nothing has been
 * asked yet.
 */
export async function activeRequestDir(
  runRoot: string,
): Promise<{ dir: string; revision: number; requestId: string; digest: string } | null> {
  let maxRevision = 1;
  let dir: string | null = null;
  try {
    for (const entry of await readdir(runRoot)) {
      const m = /^request-r(\d+)$/.exec(entry);
      if (m) {
        const n = Number(m[1]);
        if (dir === null || n > maxRevision) {
          maxRevision = n;
          dir = join(runRoot, entry);
        }
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (dir === null) {
    const first = join(runRoot, CONSULTATION_REQUEST_DIR);
    try {
      await stat(first);
      dir = first;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }
  const manifest = await readRequestManifest(dir);
  if (!manifest) return null;
  return {
    dir,
    revision: maxRevision,
    requestId: manifest.request_id,
    digest: manifest.digest,
  };
}

/** Read a recorded request, or null. */
export async function readRequest(
  runRoot: string,
): Promise<ConsultationRequest | null> {
  const active = await activeRequestDir(runRoot);
  if (!active) return null;
  try {
    return JSON.parse(
      await readFile(join(active.dir, REQUEST_FILE), "utf8"),
    ) as ConsultationRequest;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** Read back the digest a request payload was frozen at, measured from bytes. */
export async function readRequestDigest(runRoot: string): Promise<string | null> {
  const active = await activeRequestDir(runRoot);
  if (!active) return null;
  return digestRequestPackage(active.dir);
}

/** The recorded response ids, in order. */
export async function listResponses(runRoot: string): Promise<string[]> {
  try {
    const entries = await readdir(join(runRoot, CONSULTATION_RESPONSE_DIR), {
      withFileTypes: true,
    });
    return entries
      .filter((e) => e.isDirectory() && /^r\d+$/.test(e.name))
      .map((e) => e.name)
      .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

/**
 * Digest a request package as an advisor would receive it: every file except the
 * manifest envelope. Recomputing this on import is what binds an answer to bytes
 * rather than to a stored string.
 */
export async function digestRequestPackage(requestDir: string): Promise<string> {
  const tree = await digestTree(requestDir, [REQUEST_MANIFEST]);
  return tree.digest;
}

/** Digest a directory, for state identity. */
export async function digestPath(path: string): Promise<string> {
  const tree = await digestTree(path);
  return tree.digest;
}

/**
 * The identity of a prepared attempt's case inputs.
 *
 * This exists because preparation and measurement previously used two
 * different definitions of "the case": the preparer hashed the attempt record,
 * and the importer hashed the whole attempt directory. Those identify
 * different objects, so an unchanged case could be reported stale purely
 * because the two ends of the loop disagreed on what they were comparing.
 *
 * There is exactly one definition now, and both ends use it. It covers the
 * files the prepared attempt declares as its inputs, which is the set whose
 * contents determine what the solver will do. It deliberately excludes the
 * execution outputs and the attempt record itself, because a directory that
 * has been run legitimately contains files the preparer never saw, and an
 * identity that changed after every run could never be measured as fresh.
 *
 * The input set is read from the attempt record's declared inputs when
 * present, so the preparer and the measurer cannot disagree about scope.
 */
export async function attemptInputDigest(
  attemptDir: string,
  declaredInputs?: readonly string[],
): Promise<string> {
  const inputs = declaredInputs ?? (await readDeclaredInputs(attemptDir));
  const hash = createHash("sha256");
  hash.update("evocfd-attempt-inputs/v1\n");
  for (const rel of [...inputs].sort()) {
    let digest: string;
    try {
      const raw = await readFile(join(attemptDir, ...rel.split("/")));
      digest = createHash("sha256").update(raw).digest("hex");
    } catch {
      // A declared input that has gone missing is a change, not an absence.
      // Recording it explicitly keeps the digest from silently coinciding with
      // one computed when the file was present.
      digest = "absent:" + rel;
    }
    hash.update(rel + "\0" + digest + "\n");
  }
  return hash.digest("hex");
}

/** Read the input file list an attempt record declares, if it declares one. */
async function readDeclaredInputs(attemptDir: string): Promise<string[]> {
  try {
    const raw = await readFile(join(attemptDir, "attempt-record.json"), "utf8");
    const record = JSON.parse(raw) as { inputs?: unknown };
    if (Array.isArray(record.inputs)) {
      const rels = record.inputs
        .map((e) => (typeof e === "string" ? e : (e as { path?: string })?.path))
        .filter((p): p is string => typeof p === "string");
      if (rels.length > 0) return rels;
    }
  } catch {
    // No readable record: fall back to the conventional OpenFOAM input files
    // rather than failing the measurement.
  }
  return DEFAULT_INPUT_FILES;
}

/** Conventional OpenFOAM case inputs, used when an attempt declares none. */
const DEFAULT_INPUT_FILES = [
  "system/controlDict",
  "system/fvSchemes",
  "system/fvSolution",
  "system/decomposeParDict",
  "constant/thermophysicalProperties",
  "constant/chemistryProperties",
];

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
  denied: { source: string; reason: string }[],
  meta: { revision: number; supersedesDigest: string | null },
): Promise<void> {
  await writeFile(
    join(dir, REQUEST_MANIFEST),
    JSON.stringify(
      {
        schema_version: 1,
        request_id: request.requestId,
        revision: meta.revision,
        supersedes_digest: meta.supersedesDigest,
        created_at: request.createdAt,
        digest: tree.digest,
        // What the digest covers: everything in this directory except this
        // envelope, including the canonical request.json.
        digest_scope: `all files except ${REQUEST_MANIFEST}`,
        request_file: REQUEST_FILE,
        denied,
        contents: tree.files,
        directories: tree.directories,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
}

async function readRequestManifest(
  requestDir: string,
): Promise<{
  request_id: string;
  digest: string;
  revision?: number;
} | null> {
  try {
    const raw = await readFile(join(requestDir, REQUEST_MANIFEST), "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function nextResponseId(runRoot: string): Promise<string> {
  const ids = await listResponses(runRoot);
  if (ids.length === 0) return "r1";
  return `r${Number(ids[ids.length - 1].slice(1)) + 1}`;
}

async function writeResponseIndex(
  runRoot: string,
  responseId: string,
  response: AdvisorResponse,
): Promise<void> {
  const indexPath = join(runRoot, CONSULTATION_RESPONSE_DIR, RESPONSE_INDEX);
  let entries: unknown[] = [];
  try {
    entries = JSON.parse(await readFile(indexPath, "utf8")) as unknown[];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  entries.push({
    response_id: responseId,
    request_id: response.requestId,
    mode: response.mode,
    provider: response.provider,
    displayed_model: response.displayedModel,
    conversation_ref: response.conversationRef,
    received_at: response.receivedAt,
  });
  await writeFile(indexPath, JSON.stringify(entries, null, 2) + "\n", "utf8");
}

/**
 * Copy a file or tree, applying the disclosure policy.
 *
 * Everything the policy stops is appended to `denied` so the exclusion is
 * visible in the manifest. Symlinks are rejected rather than followed, because a
 * link is the one way an approved directory can point at something that was
 * never approved.
 */
async function copyFiltered(
  source: string,
  dest: string,
  policy: ExportPolicy,
  denied: { source: string; reason: string }[],
): Promise<void> {
  let info;
  try {
    info = await lstat(source);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ConsultationError(`evidence source does not exist: ${source}`);
    }
    throw err;
  }
  if (info.isSymbolicLink()) {
    throw new ConsultationError(`refusing to export a symlink: ${source}`);
  }
  if (!info.isFile() && !info.isDirectory()) {
    throw new ConsultationError(`refusing to export a non-regular file: ${source}`);
  }
  if (info.isFile()) {
    const verdict = inspectName(basename(source), policy);
    if (verdict) {
      denied.push({ source, reason: verdict });
      return;
    }
    if (info.size >= policy.maxBytes) {
      denied.push({
        source,
        reason: `exceeds the export size limit of ${policy.maxBytes} bytes`,
      });
      return;
    }
    await mkdir(dirname(dest), { recursive: true });
    await cp(source, dest);
    return;
  }
  await copyTreeFiltered(source, dest, policy, denied);
}

async function copyTreeFiltered(
  source: string,
  dest: string,
  policy: ExportPolicy,
  denied: { source: string; reason: string }[],
): Promise<void> {
  const entries = await readdir(source, { withFileTypes: true });
  await mkdir(dest, { recursive: true });
  for (const entry of entries) {
    const from = join(source, entry.name);
    const to = join(dest, entry.name);
    if (entry.isSymbolicLink()) {
      throw new ConsultationError(`refusing to export a symlink: ${from}`);
    }
    if (entry.isDirectory()) {
      await copyTreeFiltered(from, to, policy, denied);
      continue;
    }
    if (!entry.isFile()) {
      denied.push({ source: from, reason: "non-regular file skipped" });
      continue;
    }
    const verdict = inspectName(entry.name, policy);
    if (verdict) {
      denied.push({ source: from, reason: verdict });
      continue;
    }
    const size = await (async () => (await stat(from)).size)();
    if (size >= policy.maxBytes) {
      denied.push({
        source: from,
        reason: `exceeds the export size limit of ${policy.maxBytes} bytes`,
      });
      continue;
    }
    await cp(from, to);
  }
}

function inspectName(name: string, policy: ExportPolicy): string | null {
  if (policy.allowNames.includes(name)) return null;
  const lowered = name.toLowerCase();
  for (const pattern of policy.denyNamePatterns) {
    if (matches(lowered, pattern.toLowerCase())) {
      return `denied by export policy pattern ${pattern}`;
    }
  }
  return null;
}

function matches(name: string, pattern: string): boolean {
  if (!pattern.includes("*")) return name === pattern;
  const re = new RegExp(
    `^${pattern.split("*").map(escapeRegExp).join(".*")}$`,
  );
  return re.test(name);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sameLibraries(
  a: { path: string; digest: string }[],
  b: { path: string; digest: string }[],
): boolean {
  if (a.length !== b.length) return false;
  const keyed = new Map(a.map((x) => [x.path, x.digest]));
  for (const x of b) {
    if (keyed.get(x.path) !== x.digest) return false;
  }
  return true;
}

/** Deterministic JSON, so a request has one digest regardless of key order. */
function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

async function stat(path: string): Promise<{ size: number }> {
  return lstat(path);
}

// `readdir` is re-exported for tests that inspect a package's layout.
export { readdir as _consultationReadDir };
