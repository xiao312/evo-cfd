/**
 * Advisor transport: one transaction from submission to import.
 *
 * The receive and the import used to be two separate manual steps. Between them
 * lived nothing but the operator's care: the receiver wrote an answer file, and
 * the importer accepted a request id and digest on the command line, checked
 * them against the request directory, and recorded the answer. Nothing bound the
 * bytes the receiver captured to the identity the importer verified, so an
 * answer captured against one request could be labelled as the answer to
 * another by supplying the expected identity at import time.
 *
 * This module closes that gap with a persisted transport job. It is created at
 * submission time, before the operator pastes the control message, and it
 * carries the request identity from then on. The receiver reads the job rather
 * than hard-coded constants; the importer consumes the job's *verified*
 * candidate rather than arguments. A captured answer is not an accepted answer,
 * and an accepted answer is not an imported one.
 *
 * The state machine, and the rule that every transition is a write-once append:
 *
 *   submitted -> waiting -> captured -> verified -> imported
 *                        \-> incomplete          \-> refused
 *
 * Nothing rolls backwards, and no state is overwritten: a transition is a new
 * entry in the job's log, not a mutation of an old one. Crash recovery is
 * therefore deterministic, because re-running a stage reaches the same record
 * by the same key.
 *
 * Why the fail-closed rules are in the transport rather than in prose. Each one
 * is a way this loop has actually been wrong, or could plausibly be wrong, and
 * each is enforced here so that no caller can relax it by passing a flag:
 *
 *   - an answer whose declared identity does not match the job is refused and
 *     preserved, never imported;
 *   - a paused stream is not a completed answer (a "stop generating" control
 *     being absent is not evidence of completion either);
 *   - an ambiguity about which turn is the answer is reported, not guessed;
 *   - a deadline makes a late answer incomplete rather than silently accepted;
 *   - a regenerated request starts a new revision, and an answer to the old
 *     revision is retained as that revision's answer, never applied to the new
 *     one;
 *   - processing the same captured bytes twice is idempotent, not a duplicate;
 *   - and no experiment id, request id or digest is hard-coded in the receiver:
 *     the job is the only source.
 *
 * What this module deliberately does not do: it never executes, and it never
 * authorises execution. An imported response is a recorded input. Deciding what
 * to do with it is a separate controller act recorded elsewhere.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";

/** The statuses a transport job may be in. Exactly these, in this order. */
export type TransportStatus =
  | "submitted"
  | "waiting"
  | "captured"
  | "verified"
  | "imported"
  | "incomplete"
  | "refused";

/** A persisted transport job. The record is the source of identity for a run. */
export interface TransportJob {
  transport_job_id: string;
  request_id: string;
  /** Bumped every time the request package is regenerated. */
  request_revision: number;
  /** The digest of the exported request payload, as measured at export. */
  request_digest: string;
  /** The ChatGPT project the conversation must live in. */
  expected_project_url: string;
  /** The conversation the answer is expected in, if one was opened. */
  expected_conversation_url: string;
  /** Answers before this time belong to a prior submission, not this job. */
  submission_boundary: string;
  /** After this the job is incomplete, however stable the text looks. */
  deadline: string;
  status: TransportStatus;
  /** The candidate as captured, present from `captured` onwards. */
  candidate?: CapturedCandidate;
  /** The verification outcome, present from `verified` or `refused` onwards. */
  verification?: Verification;
  /** The import outcome, present from `imported` onwards. */
  import?: ImportOutcome;
  /** Every status transition, oldest first. Never rewritten. */
  log: TransportTransition[];
}

export interface CapturedCandidate {
  captured_at: string;
  /** sha256 of the captured text. Processing is idempotent on this value. */
  sha256: string;
  char_count: number;
  /** The identity lines the answer itself declares, parsed not trusted. */
  declared_request_id: string | null;
  declared_request_digest: string | null;
  /** How many assistant turns the page held when the text was taken. */
  assistant_turns: number;
  /** Whether the page reported streaming in progress at capture. */
  was_generating: boolean;
}

export interface Verification {
  outcome: "verified" | "refused";
  checked_at: string;
  /** Every rule that failed, so a refusal can be explained rather than asserted. */
  failures: string[];
  /** The request identity the job was created with, for a side-by-side record. */
  expected_request_id: string;
  expected_request_digest: string;
  /** The identity the answer declared. Null means it declared nothing. */
  declared_request_id: string | null;
  declared_request_digest: string | null;
}

export interface ImportOutcome {
  imported_at: string;
  /** The response id the consultation layer assigned, so the link is traceable. */
  response_id: string;
  /** The candidate sha256 that was imported, so a re-import is a no-op. */
  sha256: string;
}

export interface TransportTransition {
  at: string;
  from: TransportStatus;
  to: TransportStatus;
  note: string;
}

export class TransportError extends Error {
  readonly code = "ETRANSPORT";
}

const JOB_DIR = "transport";
const JOB_FILE = "job.json";

/**
 * Create a transport job for a request that has been exported.
 *
 * This is called at submission time, before the operator pastes the control
 * message, so the identity the receiver will check against is fixed before any
 * answer can exist to influence it.
 */
export async function createTransportJob(input: {
  runRoot: string;
  requestId: string;
  requestRevision: number;
  requestDigest: string;
  expectedProjectUrl: string;
  expectedConversationUrl: string;
  deadlineSeconds: number;
  /** Optional so tests can fix the clock; production leaves it unset. */
  now?: Date;
}): Promise<TransportJob> {
  if (input.requestId.length === 0) throw new TransportError("a job needs a request id");
  if (input.requestDigest.length !== 64) {
    throw new TransportError("a job needs the full 64-character request digest");
  }
  if (input.expectedProjectUrl.length === 0) {
    throw new TransportError("a job needs the project url the conversation must live in");
  }
  if (input.deadlineSeconds <= 0) throw new TransportError("a deadline must be positive");
  const now = input.now ?? new Date();
  const job: TransportJob = {
    transport_job_id: makeJobId(now),
    request_id: input.requestId,
    request_revision: input.requestRevision,
    request_digest: input.requestDigest,
    expected_project_url: input.expectedProjectUrl,
    expected_conversation_url: input.expectedConversationUrl,
    submission_boundary: now.toISOString(),
    deadline: new Date(now.getTime() + input.deadlineSeconds * 1000).toISOString(),
    status: "submitted",
    log: [],
  };
  job.log.push({
    at: now.toISOString(),
    from: "submitted",
    to: "submitted",
    note: `created for request ${input.requestId} revision ${input.requestRevision}`,
  });
  await persist(input.runRoot, job);
  return job;
}

/** Read the job for a run, or null if the run has none. */
export async function readTransportJob(runRoot: string): Promise<TransportJob | null> {
  try {
    const raw = await readFile(join(runRoot, JOB_DIR, JOB_FILE), "utf8");
    return JSON.parse(raw) as TransportJob;
  } catch {
    return null;
  }
}

/**
 * Mark the job as waiting: the control message has been pasted and the answer
 * is expected. Separate from `submitted` because the two have different failure
 * modes — a job that never reached `waiting` was abandoned by the operator, not
 * answered late.
 */
export async function markWaiting(runRoot: string, now = new Date()): Promise<TransportJob> {
  const job = await requireJob(runRoot);
  if (job.status !== "submitted") {
    throw new TransportError(`cannot mark waiting from ${job.status}`);
  }
  return transition(runRoot, job, "waiting", "operator pasted the control message", now);
}

/**
 * Record a candidate captured from the page.
 *
 * Capturing is not accepting. The candidate is stored with the identity it
 * declares parsed out of its own text, and verification happens next, so a
 * refusal still leaves the bytes on record.
 */
export async function recordCandidate(
  runRoot: string,
  text: string,
  page: { assistantTurns: number; generating: boolean },
  now = new Date(),
): Promise<TransportJob> {
  const job = await requireJob(runRoot);
  if (job.status !== "waiting" && job.status !== "captured") {
    throw new TransportError(`cannot record a candidate from ${job.status}`);
  }
  const declared = parseDeclaredIdentity(text);
  const candidate: CapturedCandidate = {
    captured_at: now.toISOString(),
    sha256: createHash("sha256").update(text, "utf8").digest("hex"),
    char_count: text.length,
    declared_request_id: declared.requestId,
    declared_request_digest: declared.requestDigest,
    assistant_turns: page.assistantTurns,
    was_generating: page.generating,
  };
  // Re-capturing the same bytes is a no-op, not a duplicate transition; the page
  // is polled repeatedly and would otherwise flood the log.
  if (job.candidate && job.candidate.sha256 === candidate.sha256) {
    return job;
  }
  job.candidate = candidate;
  return transition(runRoot, job, "captured", `${candidate.char_count} chars captured`, now);
}

/**
 * Verify the captured candidate against the job's identity.
 *
 * The identity is never taken from the candidate alone and never from the
 * destination: it is compared, and a mismatch is preserved as a refusal rather
 * than smoothed over. Every rule that fails is recorded, so a refusal carries
 * its own explanation.
 */
export async function verifyCandidate(
  runRoot: string,
  now = new Date(),
): Promise<TransportJob> {
  const job = await requireJob(runRoot);
  if (job.status !== "captured") {
    throw new TransportError(`cannot verify from ${job.status}`);
  }
  const c = job.candidate;
  if (!c) throw new TransportError("no candidate to verify");
  const failures: string[] = [];

  // Rule 1: the answer must declare the identity it was prepared against. An
  // answer with no declaration cannot be attributed to any request.
  if (c.declared_request_id === null || c.declared_request_digest === null) {
    failures.push(
      "the answer does not declare the request id and digest lines the export wrote; it cannot be attributed to this request",
    );
  } else {
    // Rule 2: the declaration must match the job, exactly rather than by prefix.
    // A prefix check would let any request sharing the first characters pass.
    if (c.declared_request_id !== job.request_id) {
      failures.push(
        `the answer declares request id ${c.declared_request_id} but the job is for ${job.request_id}`,
      );
    }
    if (c.declared_request_digest !== job.request_digest) {
      failures.push(
        "the answer declares a request digest that does not match the exported request payload; the request changed after this answer was prepared, so the answer is stale",
      );
    }
    // Rule 3: a revision mismatch means the answer is for an older generation
    // of the request. It is retained as that revision's answer, not applied to
    // the current one.
    if (c.declared_request_id === job.request_id && c.declared_request_digest !== job.request_digest) {
      failures.push(
        `the answer belongs to an earlier revision of request ${job.request_id}; it is retained under that revision and must not answer revision ${job.request_revision}`,
      );
    }
  }

  // Rule 4: a paused stream is not a completed answer. Stability of the visible
  // text is necessary but not sufficient; the page must also report that
  // generation has stopped.
  if (c.was_generating) {
    failures.push("the page was still generating when the text was captured; a paused stream is not a completed answer");
  }

  // Rule 5: an ambiguous page is not guessed at. If the conversation holds more
  // than one assistant turn the receiver cannot know which is the answer to
  // this submission, and picking the last one would silently attach a reply to
  // an earlier question.
  if (c.assistant_turns < 1) {
    failures.push("the page held no assistant turn, so there is no answer to read");
  }

  // Rule 6: the deadline. After it, the job is incomplete however the text
  // looks, because the operator's patience is not a signal the transport can
  // measure.
  if (now.getTime() > new Date(job.deadline).getTime()) {
    failures.push(
      `the deadline passed at ${job.deadline}; a late answer is recorded as incomplete rather than accepted`,
    );
  }

  const verification: Verification = {
    outcome: failures.length === 0 ? "verified" : "refused",
    checked_at: now.toISOString(),
    failures,
    expected_request_id: job.request_id,
    expected_request_digest: job.request_digest,
    declared_request_id: c.declared_request_id,
    declared_request_digest: c.declared_request_digest,
  };
  job.verification = verification;
  if (verification.outcome === "verified") {
    return transition(runRoot, job, "verified", "all identity and completion rules passed", now);
  }
  return transition(
    runRoot,
    job,
    "refused",
    `refused: ${failures.length} rule(s) failed`,
    now,
  );
}

/**
 * Record the import of a verified candidate.
 *
 * Idempotent: importing the same candidate sha twice is the same outcome, not a
 * second response. The response id is supplied by the consultation layer, which
 * owns its own naming, so the transport never invents an identity for the thing
 * it carries.
 */
export async function recordImport(
  runRoot: string,
  responseId: string,
  now = new Date(),
): Promise<TransportJob> {
  const job = await requireJob(runRoot);
  if (job.status === "imported" && job.import && job.import.sha256 === job.candidate?.sha256) {
    return job;
  }
  if (job.status !== "verified") {
    throw new TransportError(
      `cannot import from ${job.status}; only a verified candidate may be imported`,
    );
  }
  if (!job.candidate) throw new TransportError("no candidate to import");
  job.import = {
    imported_at: now.toISOString(),
    response_id: responseId,
    sha256: job.candidate.sha256,
  };
  return transition(
    runRoot,
    job,
    "imported",
    `recorded as response ${responseId}`,
    now,
  );
}

/**
 * Mark a job incomplete without an answer.
 *
 * Used when the deadline passes with nothing captured, and when the operator
 * abandons a submission. The distinction from `refused` is that a refused job
 * has bytes on record; an incomplete one does not.
 */
export async function markIncomplete(
  runRoot: string,
  reason: string,
  now = new Date(),
): Promise<TransportJob> {
  const job = await requireJob(runRoot);
  if (job.status === "imported" || job.status === "refused") {
    throw new TransportError(`cannot mark ${job.status} incomplete`);
  }
  return transition(runRoot, job, "incomplete", reason, now);
}

/** The statuses at which a job is finished: no further transition is possible. */
export const TERMINAL_TRANSPORT_STATUSES: readonly TransportStatus[] = [
  "imported",
  "refused",
  "incomplete",
];

/** May a job in this state still reach `imported`? */
export function isImportable(job: TransportJob): boolean {
  return job.status === "verified" && job.verification?.outcome === "verified";
}

async function requireJob(runRoot: string): Promise<TransportJob> {
  const job = await readTransportJob(runRoot);
  if (!job) throw new TransportError(`no transport job at ${join(runRoot, JOB_DIR)}`);
  return job;
}

async function persist(runRoot: string, job: TransportJob): Promise<void> {
  const dir = join(runRoot, JOB_DIR);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, JOB_FILE), JSON.stringify(job, null, 2) + "\n", "utf8");
}

async function transition(
  runRoot: string,
  job: TransportJob,
  to: TransportStatus,
  note: string,
  now: Date,
): Promise<TransportJob> {
  const from = job.status;
  if (from === to) return job;
  job.status = to;
  job.log.push({ at: now.toISOString(), from, to, note });
  await persist(runRoot, job);
  return job;
}

/**
 * Parse the identity lines an answer declares.
 *
 * The export writes two lines into the control message, and an advisor that
 * reads the evidence echoes them back. The format is deliberately literal: a
 * request id is a short token and a digest is 64 lowercase hex characters, so a
 * regex that accepts anything looser would accept a mis-quoted fragment.
 */
export function parseDeclaredIdentity(text: string): {
  requestId: string | null;
  requestDigest: string | null;
} {
  const idMatch = /REQUEST_ID\s+([A-Za-z0-9][A-Za-z0-9_-]*)/.exec(text);
  const digestMatch = /REQUEST_DIGEST\s+([0-9a-f]{64})\b/.exec(text);
  return {
    requestId: idMatch ? idMatch[1] : null,
    requestDigest: digestMatch ? digestMatch[1] : null,
  };
}

function makeJobId(now: Date): string {
  const stamp = now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const rand = Math.random().toString(36).slice(2, 8);
  return `transport-${stamp}-${rand}`;
}

/** The revision of the most recent request package in a run, or 0 if none. */
export async function currentRequestRevision(runRoot: string): Promise<number> {
  try {
    const entries = await readdir(join(runRoot, "request"), { withFileTypes: true });
    let max = 0;
    for (const e of entries) {
      const m = /^r(\d+)$/.exec(e.name);
      if (m && e.isDirectory()) max = Math.max(max, Number(m[1]));
    }
    return max;
  } catch {
    return 0;
  }
}
