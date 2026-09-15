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
 * Trust is still verified rather than assumed. The evaluation package is
 * re-hashed before it runs and must still match the digest that entered trial
 * identity — a judge swapped after materialization is not the judge the trial
 * was defined against. The judge never receives the agent's workspace itself:
 * it receives a staged copy whose digest is verified before and after, so a
 * judge that edits what it is judging invalidates its own verdict. It runs with
 * a scrubbed environment, because credentials are a capability and a judge has
 * no need of any.
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
 * evaluator failure is not evidence of anything. A verdict that claims to pass
 * while one of its own criteria does not is not a pass either: the verdict must
 * be internally consistent, or it says nothing.
 *
 * A result is written once. Re-judging the same workspace after the fact would
 * silently let an updated judge rewrite history, so a second evaluation of the
 * same trial is an error rather than an overwrite. A different evaluator is a
 * different trial, by identity; resetting a trial clears its result with the
 * rest of the agent view.
 */
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

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
  /** The episode whose work this verdict judges, if one was recorded. */
  episode_id: string | null;
  /** The recorded exit status of that episode. */
  episode_exit_code: number | null;
  /** True when the episode was killed for exceeding its wall-clock budget. */
  episode_timed_out: boolean;
  /** The identity this result is attributable to. */
  trial_identity: string;
  /** Name of the credential the agent used, never the credential itself. */
  credential_ref: string | null;
  /** Identity of the harness that produced the work being judged. */
  harness_identity: string | null;
  /** ISO timestamp of when the evaluation completed. */
  evaluated_at: string;
}

export class EvaluationAlreadyRecordedError extends Error {
  readonly code = "EEVALEXISTS";
}

export class EvaluationError extends Error {
  readonly code = "EEVAL";
}

/** Where a trial's episode evidence lives, relative to the trial root. */
const EPISODES_REL = join("private", "episodes");

/**
 * The episode whose outcome this verdict judges.
 *
 * A verdict over a workspace no episode produced is unattributable: it says
 * what the workspace looks like, not what the agent did. The recorded episode
 * is the link between a trajectory and a judgement, so judging without it is a
 * setup fault rather than a judgement.
 */
async function recordedEpisode(
  layout: TrialLayout,
  trialId: string,
): Promise<{ id: string; exit_code: number | null; timed_out: boolean } | null> {
  const episodeResult = join(layout.root, EPISODES_REL, trialId, "result.json");
  try {
    const raw = JSON.parse(await readFile(episodeResult, "utf8")) as {
      exitCode: number | null;
      timedOut: boolean;
    };
    return { id: trialId, exit_code: raw.exitCode, timed_out: raw.timedOut };
  } catch {
    return null;
  }
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

  // A verdict over a workspace no episode produced would say what the workspace
  // looks like without saying what the agent did. Judging requires the
  // trajectory it is attributing the work to.
  const episode = await recordedEpisode(layout, trial.trialId);
  if (episode === null) {
    throw new EvaluationError(
      `no recorded episode for ${trial.trialId}; a trial must be executed before it can be judged`,
    );
  }

  // Provenance: the judge about to run must be the judge the trial was defined
  // against. A package swapped after materialization would be executed under a
  // recorded digest that no longer describes it, which is not a judgement, it
  // is a different experiment with a forged label.
  const evaluatorNow = await digestTree(layout.evaluator);
  if (evaluatorNow.digest !== trial.evaluatorDigest) {
    throw new EvaluationError(
      `evaluation package for ${trial.trialId} has drifted from its recorded digest; ` +
        `a judge may not be replaced after a trial is materialized`,
    );
  }

  // What is being judged: the workspace as the episode left it, snapshotted
  // before the judge can touch anything.
  const judged = await digestTree(layout.agentWorkspace);

  // The judge never receives the agent's workspace. It receives a copy on the
  // private side of the trial, which it cannot write back through, and whose
  // digest is verified on both sides of the run: the copy must be exact, and it
  // must be unchanged when the judge is done. A judge that edits what it judges
  // invalidates its own verdict.
  const stagingDir = await mkdtemp(join(layout.privateDir, ".judge-"));
  const judgedCopy = join(stagingDir, "workspace");
  await cp(layout.agentWorkspace, judgedCopy, { recursive: true });
  const copyBefore = await digestTree(judgedCopy);
  if (copyBefore.digest !== judged.digest) {
    await rm(stagingDir, { recursive: true, force: true });
    throw new EvaluationError(
      `the staged copy of ${trial.trialId}'s workspace is not identical to the workspace; ` +
        `the judge cannot be handed a workspace the controller did not verify`,
    );
  }

  const started = Date.now();
  const run = await runEvaluator(entrypoint, judgedCopy, budget);
  const elapsed = (Date.now() - started) / 1000;
  const copyAfter = await digestTree(judgedCopy);
  await rm(stagingDir, { recursive: true, force: true });

  const result: EvaluationResult = {
    trial_id: trial.trialId,
    fixture_id: trial.fixtureId,
    pass: false,
    criteria: [],
    exit_code: run.exitCode,
    budget_seconds: budget,
    elapsed_seconds: Math.round(elapsed * 1000) / 1000,
    evaluator_digest: trial.evaluatorDigest,
    // The digest recorded is the state before the judge ran, which is the
    // agent's work. What the judge leaves behind is verified, not recorded.
    workspace_digest: judged.digest,
    episode_id: episode?.id ?? null,
    episode_exit_code: episode?.exit_code ?? null,
    episode_timed_out: episode?.timed_out ?? false,
    // Named, never a value: a verdict is attributable to the capability the
    // agent was given without the secret entering the record.
    credential_ref: trial.credentialRef,
    harness_identity: trial.harnessIdentity,
    trial_identity: trial.trialIdentity,
    evaluated_at: new Date().toISOString(),
  };

  if (copyAfter.digest !== copyBefore.digest) {
    result.error =
      `evaluator modified the workspace it was judging; its verdict is not attributable to the recorded state`;
    await recordResult(layout, result);
    return result;
  }

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
  // A verdict that claims to pass must actually have passed every criterion it
  // reports. A pass asserted over a failing or malformed criterion is not a
  // stronger signal, it is an inconsistent one, and an unfalsifiable verdict
  // with no criteria at all is not a pass either.
  if (result.pass === true) {
    const failed = result.criteria.find((c) => c.pass === false);
    if (result.criteria.length === 0) {
      result.error = `verdict claims pass=true but reports no criteria`;
      result.pass = false;
    } else if (failed !== undefined) {
      result.error = `verdict claims pass=true but criterion ${failed.criterion} failed`;
      result.pass = false;
    }
  }
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
      // The judge inherits nothing ambient. Credentials, gateway tokens and
      // proxy configuration are capabilities an evaluator has no use for, and
      // leaking them into a judge would make the network boundary part of the
      // judge's environment rather than part of the trial's.
      env: evaluatorEnvironment(),
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
  // Staged on the same filesystem as the destination: rename cannot cross
  // devices, and /tmp is a different mount than the bind-mounted runs tree.
  const staged = join(await mkdtemp(join(dirname(target), ".result-")), "result.json");
  const handle = await open(staged, "wx");
  await handle.writeFile(JSON.stringify(result, null, 2) + "\n");
  await handle.close();
  // Rename onto the target so readers never observe a half-written verdict.
  await rename(staged, target);
}

/**
 * The environment an evaluator is given: an allowlist, not a denylist.
 *
 * The controller's own environment holds provider keys, gateway tokens and
 * proxy configuration. None of them are a judge's business — the network
 * profile is a property of the trial, and a judge that needed a credential to
 * reach a network would be a judge whose verdict depends on reachability. So
 * the judge starts from the few variables an interpreter needs and nothing else.
 */
function evaluatorEnvironment(): Record<string, string> {
  const allowed = new Set([
    "PATH",
    "LANG",
    "LC_ALL",
    "TZ",
    "HOME",
    "USER",
    "SHELL",
    "TMPDIR",
    "SYSTEMROOT",
  ]);
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && allowed.has(name)) env[name] = value;
  }
  return env;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
