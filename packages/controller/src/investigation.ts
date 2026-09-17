/**
 * The investigation record.
 *
 * An attempt that records only what ran and what it produced is a laboratory
 * notebook with no hypothesis in it. This module links the attempt to the
 * reasoning around it: what was asked, what was expected, what the preparation
 * actually changed, what the execution established, and which part of that is
 * carried forward as experience for the next decision.
 *
 * It deliberately extends the attempt record rather than competing with it. The
 * attempt record owns inputs, changes and configuration; this record owns the
 * *argument* — why this attempt, what it would take to answer the question, and
 * what the evidence does and does not support. A campaign view is generated
 * from the same record, so what a human sees and what the system records cannot
 * drift apart.
 *
 * Nothing here judges whether a change should be made. It records the basis for
 * a decision, and the decision itself names the evidence it used.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

/** The shape of a question asked before the attempt is executed. */
export interface InvestigationQuestion {
  /** The question, stated so that an outcome can answer it. */
  text: string;
  /** Why it is worth answering now, and what makes it open. */
  rationale: string;
  /** What prior evidence left it open, with a pointer to the record. */
  prior_evidence: string[];
  /** What the attempt will have to show for the question to be answered. */
  answerable_if: string;
  /** What would make the answer negative rather than inconclusive. */
  falsified_if: string;
}

/** A planned intervention and the observations that would reveal its effect. */
export interface InvestigationPlan {
  /** What the attempt changes, and why that change is the one to make. */
  intervention: string;
  /** The observations the plan expects, stated before the run. */
  expected_observations: string[];
  /** How the outcome will be judged, independent of the numbers themselves. */
  evaluation_method: string;
  /** The wall-clock and physical bounds, so a partial run is not read as failure. */
  bounds: {
    budget_seconds: number;
    requested_end_time: number;
    note: string;
  };
}

/** The outcome as established, keeping what is supported apart from what is guessed. */
export interface InvestigationOutcome {
  /** What the execution established, each tied to the record it came from. */
  established: { claim: string; evidence: string }[];
  /** What remains open, including what a partial run could not address. */
  remains_open: string[];
  /** Interpretations offered as hypotheses, not as findings. */
  hypotheses: { statement: string; status: "untested" | "supported" | "withdrawn" }[];
  /** Whether the run completed its planned interval, was cut short, or failed. */
  completion: "completed" | "cut_short" | "failed";
  completion_detail: string;
}

/** The experience selected to reach the next decision. */
export interface SelectedExperience {
  /** The specific lesson, phrased so it can govern a next attempt. */
  lesson: string;
  /** Which part of the record it is drawn from. */
  drawn_from: string;
  /** What it changes about how the next question is framed. */
  affects_next_question: string;
}

/** The full investigation record. */
export interface InvestigationRecord {
  schema_version: 1;
  investigation_id: string;
  attempt_id: string;
  /** The prepared-case identity the execution bound to. */
  prepared_attempt_digest: string;
  question: InvestigationQuestion;
  plan: InvestigationPlan;
  /** The actual diff, as the preparer reported it. */
  actual_changes: string[];
  outcome: InvestigationOutcome;
  experience: SelectedExperience[];
  /** Where the evidence lives, relative to the repository root. */
  evidence_refs: { kind: string; path: string }[];
  created_at: string;
}

const RECORD_FILE = "investigation.json";

/**
 * Reads an investigation record, or null.
 *
 * A missing record is not an error: an attempt recorded before this module
 * existed has no investigation layer, and the campaign view says so rather than
 * reconstructing one from hindsight.
 */
export async function readInvestigation(
  attemptDir: string,
): Promise<InvestigationRecord | null> {
  try {
    const raw = await readFile(join(attemptDir, RECORD_FILE), "utf8");
    return JSON.parse(raw) as InvestigationRecord;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Writes the investigation record.
 *
 * The record is written once, after the outcome is known but before the next
 * question is framed, so the experience it selects is what actually governs the
 * next attempt. Rewriting is refused: a changed outcome is a new investigation,
 * not an edit to this one.
 */
export async function writeInvestigation(
  attemptDir: string,
  record: InvestigationRecord,
): Promise<void> {
  const existing = await readInvestigation(attemptDir);
  if (existing !== null) {
    throw new Error(
      `an investigation record already exists for ${record.investigation_id} at ${attemptDir}; the outcome of an attempt is not editable. Start a new investigation for a revised reading.`,
    );
  }
  await mkdir(attemptDir, { recursive: true });
  await writeFile(
    join(attemptDir, RECORD_FILE),
    JSON.stringify(record, null, 2) + "\n",
    "utf8",
  );
}

export interface CampaignRow {
  investigation_id: string;
  attempt_id: string;
  question: string;
  status: "planned" | "executed" | "assessed";
  intervention: string;
  planned_observations: string[];
  actual_changes: string[];
  completion: "completed" | "cut_short" | "failed" | "planned";
  established: string[];
  remains_open: string[];
  experience: string[];
  prepared_attempt_digest: string | null;
}

/**
 * Builds one campaign row from an attempt directory.
 *
 * The row shows, before a run, what will change and how it will be judged;
 * after a run, actual versus planned changes and what the evidence supports. An
 * attempt with no investigation layer is included with its mechanical facts and
 * a null digest, marked so the gap is visible rather than papered over.
 */
export async function campaignRow(
  attemptDir: string,
  attemptRecord: {
    attempt_id: string;
    prepared_attempt?: { digest: string };
    required_case_adaptation: string[];
    other_changes: string[];
  } | null,
): Promise<CampaignRow> {
  const inv = await readInvestigation(attemptDir);
  const changes = attemptRecord
    ? [...attemptRecord.required_case_adaptation, ...attemptRecord.other_changes]
    : [];

  if (!inv) {
    return {
      investigation_id: "none",
      attempt_id: attemptRecord?.attempt_id ?? "(unknown)",
      question: "(no recorded question; the attempt predates the investigation layer)",
      status: "executed",
      intervention: "(no recorded intervention rationale)",
      planned_observations: [],
      actual_changes: changes,
      completion: "planned",
      established: [],
      remains_open: [],
      experience: [],
      prepared_attempt_digest: attemptRecord?.prepared_attempt?.digest ?? null,
    };
  }

  const status: CampaignRow["status"] =
    inv.outcome.completion === "failed"
      ? "assessed"
      : inv.outcome.established.length > 0
        ? "assessed"
        : "executed";

  return {
    investigation_id: inv.investigation_id,
    attempt_id: inv.attempt_id,
    question: inv.question.text,
    status,
    intervention: inv.plan.intervention,
    planned_observations: inv.plan.expected_observations,
    actual_changes: inv.actual_changes,
    completion: inv.outcome.completion,
    established: inv.outcome.established.map((e) => e.claim),
    remains_open: inv.outcome.remains_open,
    experience: inv.experience.map((e) => e.lesson),
    prepared_attempt_digest: inv.prepared_attempt_digest,
  };
}
