/**
 * Trial evaluation.
 *
 * An evaluation is the moment the loop becomes answerable: it converts an
 * agent's workspace changes into a verdict that can be compared across trials.
 * Everything here is about not letting that conversion become optimistic.
 *
 * The evaluator is trusted code that runs as the controller, with full access to
 * the trial directory. The agent is not trusted, and has already been confined
 * by the isolation boundary. This asymmetry is the point: the judge sees the
 * agent's work, the agent never sees the judge.
 *
 * The evaluator contract is small and deliberately awkward to satisfy by
 * accident:
 *
 *   node check.mjs <agent-workspace>
 *
 * It prints one JSON object describing the verdict, and its exit code agrees
 * with the verdict's own `pass` field. A controller that cannot obtain that
 * object — the evaluator is missing, exits with an unexpected code, prints
 * something that is not the verdict, or exceeds its budget — records a failure
 * and says which. It never records a pass, because a pass that survives an
 * evaluator failure is not evidence of anything.
 *
 * A result is written once. Re-judging the same workspace after the fact would
 * silently let an updated judge rewrite history, so a second evaluation of the
 * same trial is an error rather than an overwrite. A different evaluator is a
 * different trial, by identity; resetting a trial clears its result with the
 * rest of the agent view.
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, open, readFile, rename, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import type { MaterializedTrial, TrialLayout } from "./snapshot.ts";
import { digestTree } from "./snapshot.ts";

/** What one criterion of the verdict looks like, as the evaluator prints it. */
export interface CriterionVerdict {
  criterion: string;
  pass: boolean;
  detail: string;
}

/** The verdict an evaluator prints, plus what the controller adds. */
export interface EvaluationResult {
  trial_id: string;
  fixture_id: string;
  /** True only when every criterion passed and the verdict was obtained intact. */
  pass: boolean;
  criteria: CriterionVerdict[];
  /** Present when the verdict could not be obtained at all, with the reason. */
  error?: string;
  /** Exit status of the evaluator process. */
  exit_code: number | null;
  /** Wall-clock seconds the evaluator was allowed and used. */
  budget_seconds: number;
  elapsed_seconds: number;
  /** Digest of the evaluation package that produced this verdict. */
  evaluator_digest: string;
  /** Digest of the workspace that was judged. */
  workspace_digest: string;
  /** The identity this result is attributable to. */
  trial_identity: string;
  /** ISO timestamp of when the evaluation completed. */
  evaluated_at: string;
}

export class EvaluationAlreadyRecordedError extends Error {
  readonly code = "EEVALEXISTS";
}

export class EvaluationError extends Error {
  readonly code = "EEVAL";
}

/** Default wall-clock budget for an evaluation, unless the fixture says else. */
const DEFAULT_EVALUATION_BUDGET_SECONDS = 120;

export interface EvaluateOptions {
  /**
   * Wall-clock budget for the evaluator itself. The agent's own
   * `max_wall_seconds` is a different limit on a different process.
   */
  budgetSeconds?: number;
}

/**
 * Evaluate a materialized trial and record the verdict once.
 *
 * Throws `EvaluationAlreadyRecordedError` if this trial already has a result;
 * `EvaluationError` if the evaluation package is absent or unreadable, since
 * that is a setup fault rather than a judgement.
 */
export async function evaluateTrial(
  trial: MaterializedTrial,
  options: EvaluateOptions = {},
): Promise<EvaluationResult> {
  const layout = trial.layout;
  const budget = options.budgetSeconds ?? DEFAULT_EVALUATION_BUDGET_SECONDS;

  const { entrypoint } = await evaluatorEntrypoint(layout);
  // The workspace digest recorded below is whatever the workspace holds now:
  // the agent's work is the thing being judged, so a change from the pristine
  // baseline is expected, not drift. The invariant this does not yet enforce —
  // that the workspace is exactly what the episode left behind — needs an
  // episode boundary to record against, and arrives with the episode runner.

  const started = Date.now();
  const run = await runEvaluator(entrypoint, layout.agentWorkspace, budget);
  const elapsed = (Date.now() - started) / 1000;

  const result: EvaluationResult = {
    trial_id: trial.trialId,
    fixture_id: trial.fixtureId,
    pass: false,
    criteria: [],
    exit_code: run.exitCode,
    budget_seconds: budget,
    elapsed_seconds: Math.round(elapsed * 1000) / 1000,
    evaluator_digest: trial.evaluatorDigest,
    workspace_digest: (await digestTree(layout.agentWorkspace)).digest,
    trial_identity: trial.trialIdentity,
    evaluated_at: new Date().toISOString(),
  };

  applyVerdict(result, run);

  await recordResult(layout, result);
  return result;
}

/** Turn a completed evaluator run into a result, failing closed at every step. */
function applyVerdict(result: EvaluationResult, run: EvaluatorRun): void {
  if (run.error) {
    result.error = run.error;
    result.criteria = [];
    return;
  }
  const parsed = parseVerdict(run.stdout, result.trial_id);
  if (parsed instanceof Error) {
    result.error = parsed.message;
    result.criteria = [];
    return;
  }
  result.criteria = parsed.criteria;
  // The verdict's own `pass` is authoritative; the exit code is a witness that
  // must not contradict it in the optimistic direction. A verdict that claims
  // success from a process that failed cannot be trusted either way, so a pass
  // is withdrawn. A failure from a process that exited non-zero is the normal
  // failing case and is recorded as a judgement, not a fault.
  if (parsed.pass === true && run.exitCode !== 0) {
    result.error = `evaluator reported pass=true but exited ${run.exitCode}`;
    result.pass = false;
    return;
  }
  result.pass = parsed.pass;
  if (parsed.error) result.error = parsed.error;
}

interface EvaluatorRun {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  /** Set when the process could not be run at all, or exceeded its budget. */
  error?: string;
}

/**
 * Run the evaluator as a subprocess with a hard wall-clock budget.
 *
 * The budget is enforced by killing the process group, not by trusting the
 * evaluator to check the time: a stuck evaluator must not extend the trial.
 */
async function runEvaluator(
  entrypoint: string,
  workspace: string,
  budgetSeconds: number,
): Promise<EvaluatorRun> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [entrypoint, workspace], {
      cwd: dirname(entrypoint),
      // A new group so the whole evaluation dies together, including any
      // subprocess the evaluator itself spawned.
      detached: process.platform !== "win32",
      // Without this every evaluation opens and closes a console window on
      // Windows, once for the evaluator and once for each of its children.
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        // Kill the whole process group on POSIX; on Windows a detached child
        // is its own process, so signal it directly.
        if (process.platform === "win32") child.kill("SIGKILL");
        else process.kill(-child.pid!, "SIGKILL");
      } catch {
        // The group may already be gone; the close handler reports the code.
      }
      resolve({
        stdout,
        stderr,
        exitCode: null,
        error: `evaluator exceeded its ${budgetSeconds}s budget and was killed`,
      });
    }, budgetSeconds * 1000);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ stdout, stderr, exitCode: null, error: `could not start the evaluator: ${error.message}` });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ stdout, stderr, exitCode: code });
    });
  });
}

/**
 * Locate the verdict in what the evaluator printed.
 *
 * Evaluators are free to print anything around it, and may pretty-print the
 * verdict itself, so the extractor looks for the first balanced JSON object on
 * stdout rather than the last brace. A verdict must be an object with a boolean
 * `pass` and a `criteria` array.
 */
function parseVerdict(
  stdout: string,
  trialId: string,
): { pass: boolean; criteria: CriterionVerdict[]; error?: string } | Error {
  const text = stdout.trim();
  if (text.length === 0) {
    return new Error(`evaluator for ${trialId} printed nothing, so there is no verdict`);
  }
  const json = extractJsonObject(text);
  if (json === null) {
    return new Error(`evaluator for ${trialId} printed no JSON object: ${truncate(text)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    return new Error(`evaluator for ${trialId} printed unparseable JSON: ${truncate(text)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return new Error(`evaluator for ${trialId} printed a JSON value that is not an object`);
  }
  const verdict = parsed as { pass?: unknown; criteria?: unknown; error?: unknown };
  if (typeof verdict.pass !== "boolean") {
    return new Error(`evaluator for ${trialId} printed a verdict without a boolean pass`);
  }
  if (!Array.isArray(verdict.criteria)) {
    return new Error(`evaluator for ${trialId} printed a verdict without a criteria array`);
  }
  const criteria = verdict.criteria.map((raw, index) => {
    const entry = (raw ?? {}) as Record<string, unknown>;
    return {
      criterion: typeof entry.criterion === "string" ? entry.criterion : `criterion-${index}`,
      pass: entry.pass === true,
      detail: typeof entry.detail === "string" ? entry.detail : "",
    };
  });
  return {
    pass: verdict.pass,
    criteria,
    error: typeof verdict.error === "string" ? verdict.error : undefined,
  };
}

function truncate(text: string, limit = 200): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/**
 * The first balanced, string-aware JSON object in `text`, or null.
 *
 * The naive last-brace search fails on pretty-printed verdicts, whose final
 * opening brace belongs to a criterion rather than to the verdict.
 */
function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Find the evaluation package's entrypoint, failing when it is not runnable. */
async function evaluatorEntrypoint(layout: TrialLayout): Promise<{ entrypoint: string }> {
  const entrypoint = join(layout.evaluator, "check.mjs");
  try {
    const handle = await open(entrypoint);
    await handle.close();
  } catch (error) {
    throw new EvaluationError(
      `evaluation package is not runnable at ${entrypoint}: ${(error as NodeJS.ErrnoException).code ?? error}`,
    );
  }
  return { entrypoint };
}

/** Where a trial's result lives, and whether one is already recorded. */
export function resultPath(layout: TrialLayout): string {
  return join(layout.privateDir, "result.json");
}

export async function recordedResult(layout: TrialLayout): Promise<EvaluationResult | null> {
  try {
    const raw = await readFile(resultPath(layout), "utf8");
    return JSON.parse(raw) as EvaluationResult;
    // An unparseable or partial file is reported as absent rather than trusted:
    // a result the controller cannot read is not a result it can compare.
  } catch {
    return null;
  }
}

/**
 * Write a result exactly once, so the record cannot be revised after the fact.
 * The write is atomic: a crash between write and close cannot leave a verdict
 * that reads as complete.
 */
async function recordResult(layout: TrialLayout, result: EvaluationResult): Promise<void> {
  const target = resultPath(layout);
  // Presence alone blocks a second verdict, even one the controller cannot
  // parse: a result file that exists but is unreadable is a state fault to be
  // investigated, not an invitation to overwrite it.
  if (await pathExists(target)) {
    throw new EvaluationAlreadyRecordedError(
      `${result.trial_id} already has a recorded result; reset the trial to re-judge it`,
    );
  }
  await mkdir(layout.privateDir, { recursive: true });
  const staged = join(await mkdtemp(join(tmpdir(), "evocfd-result-")), "result.json");
  const handle = await open(staged, "wx");
  await handle.writeFile(JSON.stringify(result, null, 2) + "\n");
  await handle.close();
  // Rename onto the target so readers never observe a half-written verdict.
  await rename(staged, target);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
