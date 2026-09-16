/**
 * A machine-readable summary of one run.
 *
 * The console output of a script is prose for the person at the terminal; this
 * is what the next step of the loop consumes. A comparison of trials, a
 * campaign ledger, a dashboard — all of them want the same few facts in the
 * same shape, and none of them should have to parse prose to get them.
 *
 * The report summarizes; it does not judge. The verdict still comes from the
 * evaluator and the identity still comes from the bundle. Nothing here is
 * authoritative about anything, which is why it is also write-once: a report
 * that could be rewritten would drift from the artifact it describes.
 */

import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Every kind of run that produces a report. */
export type RunKind = "trial" | "proposal" | "candidate";

/**
 * The status of a run, in the vocabulary each kind actually uses. A trial is
 * judged, so it passes or fails. A proposal is a decision, so its interesting
 * outcomes include the honest ones that produce nothing: `no_change`,
 * `duplicate` and `rejected`. `error` is reserved for a run that did not reach
 * an outcome at all — it is never a verdict about the harness.
 */
export type RunStatus =
  | "pass"
  | "fail"
  | "no_change"
  | "duplicate"
  | "rejected"
  | "built"
  | "error";

export interface RunReport {
  report_schema_version: 1;
  run_id: string;
  run_kind: RunKind;
  status: RunStatus;
  /** Free-text reason, present for every non-passing status and absent for a pass. */
  reason?: string;
  /** The fixture a trial ran, or the genome a proposal or candidate concerns. */
  subject?: string;
  trial_identity?: string;
  parent_harness_identity?: string;
  candidate_genome_id?: string;
  candidate_harness_identity?: string;
  proposer_harness_identity?: string;
  /** Relative paths to the artifacts this report summarizes, from the run root. */
  artifacts: string[];
  created_at: string;
}

export const REPORT_FILE = "private/report.json";

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

/**
 * Write the report for a run, staged then renamed so a report is either
 * complete or absent. Refusing to overwrite is not a limitation: a report that
 * could be revised would be able to disagree with the artifact it points at.
 */
export async function writeReport(input: {
  runRoot: string;
  report: Omit<RunReport, "created_at">;
  now?: () => Date;
}): Promise<RunReport> {
  const target = join(input.runRoot, REPORT_FILE);
  if (await pathExists(target)) {
    throw new Error(`a report already exists at ${target}; a run is reported once`);
  }
  const report: RunReport = {
    ...input.report,
    created_at: (input.now ?? (() => new Date()))().toISOString(),
  };
  await mkdir(join(input.runRoot, "private"), { recursive: true });
  const staging = join(input.runRoot, "private", ".report.json.tmp");
  await writeFile(staging, JSON.stringify(report, null, 2) + "\n");
  await rename(staging, target);
  return report;
}

/** Read a run's report. A run without one has not finished. */
export async function readReport(runRoot: string): Promise<RunReport> {
  const raw = await readFile(join(runRoot, REPORT_FILE), "utf8");
  return JSON.parse(raw) as RunReport;
}
