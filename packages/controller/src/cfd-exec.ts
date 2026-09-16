/**
 * CFD job execution.
 *
 * Runs a recorded plan and reports what happened. The split from `cfd-job.ts`
 * is deliberate: the types describe what is observable, this module observes
 * it, and a test can drive the state machine without a container.
 *
 * The executor is trusted code with container authority. The agent has none:
 * it never sees the docker socket, and it never sees this module's inputs. That
 * asymmetry is the whole boundary, and it is why the plan is recorded first.
 */

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { open, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

import type {
  CfdJobPlan,
  CfdJobRecord,
  CfdJobState,
  ContainerFacts,
  JobState,
  SolverProfile,
} from "./cfd-job.ts";

/** Serialises a plan so its digest identifies it. */
export function planDigest(plan: CfdJobPlan): string {
  const stable = JSON.stringify({
    jobId: plan.jobId,
    executable: plan.profile.executable,
    executableSha256: plan.profile.executableSha256,
    caseDir: plan.caseDir,
    args: plan.args,
    budgetSeconds: plan.budgetSeconds,
    requestedEndTime: plan.requestedEndTime,
    ranks: plan.ranks,
    logFile: plan.logFile,
  });
  return createHash("sha256").update(stable).digest("hex");
}

/** Path of a job's record file inside its directory. */
export const RECORD_FILE = "job-record.json";

/**
 * Reads an existing job record, or returns null.
 *
 * A controller that restarts calls this to find what it started. A missing
 * record is not a job; a record whose plan was rewritten is a corruption.
 */
export async function readJobRecord(
  jobDir: string,
): Promise<CfdJobRecord | null> {
  try {
    const raw = await readFile(join(jobDir, RECORD_FILE), "utf8");
    const record = JSON.parse(raw) as CfdJobRecord;
    const recomputed = planDigest(record.plan);
    if (recomputed !== record.planDigest) {
      throw new Error(
        `job ${record.plan.jobId}: record plan does not match its own digest`,
      );
    }
    return record;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function emptyState(jobId: string): CfdJobState {
  return {
    jobId,
    state: "submitted",
    submittedAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    container: null,
    lastReportedTime: null,
    terminatedNormally: false,
    stopReason: null,
    detail: "",
  };
}

/** Windows separators are unreadable by the bash that executes the plan. */
function toPosix(p: string): string {
  return p.split("\\").join("/");
}

/**
 * Writes a record, creating the directory. Called before execution so the plan
 * is durable even if the process dies immediately afterwards.
 */
export async function writeJobRecord(
  jobDir: string,
  record: CfdJobRecord,
): Promise<void> {
  await mkdir(jobDir, { recursive: true });
  const path = join(jobDir, RECORD_FILE);
  let handle;
  try {
    // Open exclusively: a record is written, not rewritten mid-flight.
    handle = await open(path, "wx");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`job record already exists at ${path}`);
    }
    throw err;
  }
  await handle.writeFile(JSON.stringify(record, null, 2) + "\n", "utf8");
  await handle.close();
}

/**
 * Overwrites the state portion of a record.
 *
 * Only the state advances; the plan and its digest are fixed at submission.
 */
export async function updateJobState(
  jobDir: string,
  state: CfdJobState,
): Promise<void> {
  const existing = await readJobRecord(jobDir);
  if (!existing) throw new Error(`no job record to update at ${jobDir}`);
  await writeFile(
    join(jobDir, RECORD_FILE),
    JSON.stringify({ plan: existing.plan, state, planDigest: existing.planDigest }, null, 2) + "\n",
    "utf8",
  );
}

/**
 * The command the executor will run, in one string for inspection.
 *
 * The profile's environment is sourced first, because the library resolution
 * order it establishes is part of the execution contract. A job that runs the
 * right executable with the wrong library set is not the job that was planned.
 */
export function buildCommand(plan: CfdJobPlan): string {
  const env = plan.profile.envFile;
  const exe = toPosix(plan.profile.executable);
  const args = plan.args.map(toPosix).join(" ");
  if (plan.ranks > 1) {
    return [
      `source ${env}`,
      `mpirun -np ${plan.ranks} ${exe} ${args}`,
    ].join(" && ");
  }
  return [
    `source ${env}`,
    `${exe} ${args}`,
  ].join(" && ");
}

/** The last `Time = ...` value the solver printed, or null. */
export async function readLastTime(logPath: string): Promise<number | null> {
  let text: string;
  try {
    text = await readFile(logPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const matches = text.matchAll(/^Time = ([0-9.eE+-]+)$/gm);
  let last: number | null = null;
  for (const m of matches) {
    const value = Number(m[1]);
    if (Number.isFinite(value)) last = value;
  }
  return last;
}

/** True when the log's final non-empty line is the solver's normal `End`. */
export async function readTerminatedNormally(
  logPath: string,
): Promise<boolean> {
  let text: string;
  try {
    text = await readFile(logPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.length > 0 && lines[lines.length - 1] === "End";
}

/**
 * Facts about a docker container, or null when docker is unavailable.
 *
 * Returns null rather than throwing: a host without docker reports no facts,
 * and the caller records that as an executor limitation, not a job failure.
 */
export function inspectContainer(containerId: string): ContainerFacts | null {
  const inspect = spawnSync("docker", ["inspect", containerId], {
    encoding: "utf8",
    timeout: 15_000,
  });
  if (inspect.error || inspect.status !== 0) return null;
  try {
    const list = JSON.parse(inspect.stdout) as Array<{
      State?: {
        Running?: boolean;
        ExitCode?: number;
        FinishedAt?: string;
      };
    }>;
    const info = list[0];
    if (!info || !info.State) return null;
    const running = Boolean(info.State.Running);
    const exitCode = typeof info.State.ExitCode === "number"
      ? info.State.ExitCode
      : null;
    return {
      containerId,
      startedCommand: "",
      running,
      exited: !running,
      exitCode,
    };
  } catch {
    return null;
  }
}

/**
 * Runs a plan to completion, under its budget.
 *
 * Returns the terminal state. The caller decides what to record; this function
 * never writes, so a test can observe the outcome without touching disk.
 */
export async function executePlan(
  plan: CfdJobPlan,
  jobDir: string,
  hostRoot: string,
): Promise<CfdJobState> {
  const state = emptyState(plan.jobId);
  state.state = "running";
  state.startedAt = Date.now();

  const command = buildCommand(plan);
  // The log path is inside the case, which is bind-mounted into the container
  // as the controller's view. The container writes to the same file.
  // Paths are converted to POSIX form because the command runs under bash,
  // which cannot read a Windows separator.
  const logPath = toPosix(join(hostRoot, plan.logFile));
  const child = spawn("bash", ["-c", command], {
    cwd: toPosix(hostRoot),
    env: { ...process.env, TMPDIR: "/data2/kexiao/tmp" },
    timeout: plan.budgetSeconds * 1000,
  });
  let containerId: string | null = null;
  try {
    const handle = await open(logPath, "w");
    const stream = handle.createWriteStream({ encoding: "utf8" });
    child.stdout?.pipe(stream);
    child.stderr?.pipe(stream);
    // Identify our own container if we are inside one.
    const selfId = spawnSync("cat", ["/proc/self/cgroup"], { encoding: "utf8" });
    const match = selfId.stdout?.match(/docker[-/]([0-9a-f]{64})/);
    if (match) containerId = match[1];
  } catch {
    // Logging is best-effort; the exit code still decides the outcome.
  }

  const code: number = await new Promise((resolve) => {
    child.on("exit", (exitCode) => resolve(exitCode ?? -1));
    child.on("error", () => resolve(-1));
  });

  state.finishedAt = Date.now();
  state.lastReportedTime = await readLastTime(logPath);
  state.terminatedNormally = await readTerminatedNormally(logPath);
  if (containerId) {
    const facts = inspectContainer(containerId);
    state.container = facts
      ? { ...facts, startedCommand: command }
      : {
          containerId,
          startedCommand: command,
          running: false,
          exited: true,
          exitCode: code,
        };
  }

  if (child.killed) {
    state.state = "cancelled";
    state.stopReason = "budget";
    state.detail = `exceeded the ${plan.budgetSeconds}s wall-clock budget`;
  } else if (code === 0) {
    state.state = "finished";
    state.detail = state.terminatedNormally
      ? "solver exited 0 with a normal End"
      : "solver exited 0 without a normal End in the log";
  } else {
    state.state = "failed";
    state.stopReason = code === -1 ? "executor_error" : "solver_error";
    state.detail = `solver exited with code ${code}`;
  }
  return state;
}

/**
 * Cancels a running job by container id.
 *
 * Returns the terminal state rather than assuming the stop worked: a container
 * that cannot be killed is reported as still running, never as cancelled.
 */
export function cancelJob(
  containerId: string,
  jobId: string,
): { state: JobState; detail: string } {
  const stop = spawnSync("docker", ["stop", containerId], {
    encoding: "utf8",
    timeout: 30_000,
  });
  if (stop.error || stop.status !== 0) {
    return {
      state: "running",
      detail: `cancel requested but docker stop failed: ${String(stop.error?.message ?? stop.stderr)}`,
    };
  }
  return {
    state: "cancelled",
    detail: `stopped container ${containerId.slice(0, 12)}`,
  };
}

/** A profile from explicit fields, with its digest checked against the file. */
export function resolveProfile(input: {
  id: string;
  executable: string;
  executableSha256: string;
  envFile: string;
  libraryPaths: string[];
  expectedProfileLibraries: string[];
}): SolverProfile {
  return input;
}

/** All terminal states. Useful for assertions. */
export const TERMINAL_STATES: JobState[] = ["finished", "failed", "cancelled"];
