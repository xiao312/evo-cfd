/**
 * The one host execution backend.
 *
 * Both generic CFD jobs and prepared MASCOTTE attempts execute through this
 * module. There is deliberately no second shell template: two runners drift
 * apart in timeout, logging and status semantics, and a difference in any of
 * them is exactly the ambiguity this project exists to remove.
 *
 * The boundary the runner sits on is the frozen three-phase split: the plan is
 * recorded in the campaign container, the solver runs on the host where its
 * libraries are, and the outcome is assessed from the evidence the run left.
 * The runner is what the host executes, so it owns three things the controller
 * cannot observe:
 *
 *   1. the environment is sourced and the executable actually resolves;
 *   2. the wall-clock deadline is enforced against the process that runs, not
 *      against the shell that launched it;
 *   3. a receipt recording what the process did, written even when the process
 *      is killed.
 *
 * The receipt is line-based rather than JSON, on purpose. Generating JSON from
 * a shell heredoc means hand-placing every comma; getting it wrong produces a
 * file a JSON parser rejects, and a catch-all reader then reports "no receipt"
 * — concealing a programming error as an execution outcome. A key=value line
 * format cannot be structurally malformed, and the parser still reports a
 * format error rather than absence when a required key is missing.
 */

import { readFile } from "node:fs/promises";

/** Facts the runner records about the process it ran. */
export interface ExecutionReceipt {
  job_id: string;
  plan_digest: string;
  started_at: string;
  finished_at: string;
  wall_clock_seconds: number;
  budget_seconds: number;
  budget_enforced_by: string;
  exit_code: number;
  command: string;
}

/** Every key a valid receipt must carry. Used to tell partial from absent. */
const RECEIPT_KEYS: readonly (keyof ExecutionReceipt)[] = [
  "job_id",
  "plan_digest",
  "started_at",
  "finished_at",
  "wall_clock_seconds",
  "budget_seconds",
  "budget_enforced_by",
  "exit_code",
  "command",
];

/** Exit code `timeout` uses when the deadline stops the process. */
export const DEADLINE_EXIT_CODE = 124;

/**
 * The argument vector a deadline is applied to.
 *
 * This is deliberately not a shell string. GNU `timeout` execs a command and
 * passes it arguments; it does not interpret shell built-ins or `&&`. Writing
 * `timeout 600 source env && solver` asks timeout to run a program named
 * `source`, which does not exist, and leaves the solver outside the deadline
 * entirely. The env is sourced by the surrounding script and the deadline is
 * applied to this vector instead.
 */
export function buildArgv(
  executable: string,
  args: readonly string[],
  ranks: number,
): string[] {
  const exe = toPosix(executable);
  if (ranks > 1) {
    return ["mpirun", "-np", String(ranks), exe, ...args.map(toPosix)];
  }
  return [exe, ...args.map(toPosix)];
}

/** Convert a Windows path to a POSIX one; a no-op on Linux. */
export function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

export interface RunnerInput {
  jobId: string;
  planDigest: string;
  /** Argument vector for the solver, from `buildArgv`. */
  argv: readonly string[];
  /** Absolute path sourced by the runner; may be empty to skip. */
  envFile: string;
  /** Wall-clock budget in seconds. */
  budgetSeconds: number;
  /** Log file name, written inside the job directory. */
  logFile: string;
}

/**
 * Builds the host runner script.
 *
 * Pure: given the same input it returns the same bytes, so the generated script
 * is testable with deterministic dummy solvers rather than OpenFOAM.
 */
export function buildRunnerScript(input: RunnerInput): string {
  if (!Number.isFinite(input.budgetSeconds) || input.budgetSeconds <= 0) {
    throw new Error(`budgetSeconds must be positive, got ${input.budgetSeconds}`);
  }
  if (input.argv.length === 0) {
    throw new Error("argv must contain at least the executable");
  }

  const argv = input.argv.map((a) => quoteShell(a)).join(" ");
  const receipt: string[] = [
    "job_id=" + input.jobId,
    "plan_digest=" + input.planDigest,
    'started_at="$START_ISO"',
    'finished_at="$END_ISO"',
    "wall_clock_seconds=$((END_S - START_S))",
    "budget_seconds=" + input.budgetSeconds,
    "budget_enforced_by=timeout -s TERM -k 30",
    "exit_code=$CODE",
    "command=" + input.argv.join(" "),
  ];

  const lines: string[] = [
    "#!/bin/bash",
    "# Generated host runner. Do not edit: the job record binds to the plan",
    "# digest this script was generated against, and the receipt records the",
    "# exact command that ran.",
    "#",
    "# The OpenFOAM environment is written for interactive use: config.sh/aliases",
    "# ends with `unalias wmRefresh`, which fails whenever that alias is not",
    "# defined, the normal case for a non-interactive shell. Under errexit the",
    "# source aborts there and leaves PATH and LD_LIBRARY_PATH half-configured,",
    "# so a binary can resolve the wrong libspecie and still run -- with the",
    "# wrong physics. Errexit is therefore enabled only after the environment is",
    "# sourced, and the outcome is verified by resolution rather than by return",
    "# code.",
    "set -o pipefail",
    "set +e",
  ];
  if (input.envFile) {
    lines.push(`source ${quoteShell(input.envFile)}`);
  }
  lines.push(
    "set -e",
    // Verify what will actually run. An absolute path is checked directly and
    // a bare name is resolved through PATH; either way a missing executable is
    // caught before the deadline can mask it as a solver failure.
    `command -v ${quoteShell(input.argv[0])} >/dev/null 2>&1 || {`,
    `  echo "${input.argv[0]} did not resolve after sourcing the environment" >&2`,
    "  exit 1",
    "}",
  );
  // mpirun is only required in the parallel case, so it is checked when present.
  if (input.argv[0] === "mpirun") {
    lines.push(
      'command -v mpirun >/dev/null 2>&1 || { echo "mpirun did not resolve" >&2; exit 1; }',
    );
  }
  lines.push(
    'cd "$(dirname "$0")"',
    "START_S=$(date +%s)",
    "START_ISO=$(date -Is)",
    // Errexit is off around the deadline: a nonzero or deadline-killed solver
    // must still reach the receipt below, or the run leaves no evidence at all
    // and can only be reported as an execution error.
    "set +e",
    // The deadline wraps the executable itself, never a shell expression, and
    // the group is killed so a solver that forks is collected too.
    `timeout -s TERM -k 30 ${input.budgetSeconds} ${argv} > ${quoteShell(input.logFile)} 2>&1`,
    "CODE=$?",
    "set -e",
    "END_S=$(date +%s)",
    "END_ISO=$(date -Is)",
    "cat > execution-receipt.txt <<RECEIPT",
    ...receipt,
    "RECEIPT",
    "exit $CODE",
  );
  return lines.join("\n") + "\n";
}

/** Single-quotes a shell token, so an argument cannot be reinterpreted. */
function quoteShell(token: string): string {
  return "'" + token.replace(/'/g, "'\\''") + "'";
}

export type ReceiptRead =
  | { status: "present"; receipt: ExecutionReceipt }
  | { status: "absent" }
  | { status: "malformed"; error: string; raw: string };

/**
 * Parses a receipt, distinguishing a malformed file from a missing one.
 *
 * A malformed receipt is an integrity error: it means the runner that wrote it
 * is not the runner this code expects. Reporting it as absent would hide that.
 */
export function parseReceipt(raw: string): ReceiptRead {
  const map = new Map<string, string>();
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    const eq = line.indexOf("=");
    if (eq === -1) {
      return { status: "malformed", error: `line without '=': ${line}`, raw };
    }
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1);
    if (!RECEIPT_KEYS.includes(key as keyof ExecutionReceipt)) {
      return { status: "malformed", error: `unknown key '${key}'`, raw };
    }
    map.set(key, value);
  }
  if (map.size === 0) return { status: "absent" };
  const missing = RECEIPT_KEYS.filter((k) => !map.has(k));
  if (missing.length > 0) {
    return {
      status: "malformed",
      error: `missing required keys: ${missing.join(", ")}`,
      raw,
    };
  }
  const wall = Number(map.get("wall_clock_seconds"));
  const budget = Number(map.get("budget_seconds"));
  const exitCode = Number(map.get("exit_code"));
  if (![wall, budget, exitCode].every((n) => Number.isFinite(n))) {
    return {
      status: "malformed",
      error: "numeric fields are not numeric",
      raw,
    };
  }
  return {
    status: "present",
    receipt: {
      job_id: map.get("job_id") as string,
      plan_digest: map.get("plan_digest") as string,
      started_at: map.get("started_at") as string,
      finished_at: map.get("finished_at") as string,
      wall_clock_seconds: wall,
      budget_seconds: budget,
      budget_enforced_by: map.get("budget_enforced_by") as string,
      exit_code: exitCode,
      command: map.get("command") as string,
    },
  };
}

export async function readReceiptFile(receiptPath: string): Promise<ReceiptRead> {
  let raw: string;
  try {
    raw = await readFile(receiptPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { status: "absent" };
    throw err;
  }
  return parseReceipt(raw);
}

/** Solver facts read from the log, kept separate from process facts. */
export interface SolverFacts {
  lastTime: number | null;
  terminatedNormally: boolean;
}

/**
 * Combines process facts and solver observations into one authoritative state.
 *
 * Neither source implies the other, and this ordering is the point: a log that
 * ends in a normal `End` does not override a receipt whose exit code is
 * nonzero, and a missing receipt is not a verified successful execution. A
 * deadline stop is reported as such, because the budget stopped the run rather
 * than the solver reaching its end.
 */
export function assessExecution(input: {
  receipt: ReceiptRead;
  solver: SolverFacts;
  requestedEndTime: number;
}): {
  state: "finished" | "failed";
  stopReason: string | null;
  detail: string;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  deadline: boolean;
} {
  const { receipt, solver, requestedEndTime } = input;

  if (receipt.status === "absent") {
    return {
      state: "failed",
      stopReason: "executor_error",
      detail:
        "no execution receipt; the runner did not finish, predates receipts, or was killed before writing one",
      startedAt: null,
      finishedAt: null,
      exitCode: null,
      deadline: false,
    };
  }
  if (receipt.status === "malformed") {
    return {
      state: "failed",
      stopReason: "receipt_malformed",
      detail: `execution receipt is not in the expected format: ${receipt.error}`,
      startedAt: null,
      finishedAt: null,
      exitCode: null,
      deadline: false,
    };
  }

  const r = receipt.receipt;
  const deadline = r.exit_code === DEADLINE_EXIT_CODE;

  if (deadline) {
    return {
      state: "failed",
      stopReason: "budget_exceeded",
      detail: `the wall-clock budget (${r.budget_seconds}s) stopped the run at ${r.wall_clock_seconds}s, not the solver; last reported time ${solver.lastTime}`,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      exitCode: r.exit_code,
      deadline: true,
    };
  }
  if (r.exit_code !== 0) {
    return {
      state: "failed",
      stopReason: "solver_error",
      detail: `the solver exited ${r.exit_code}; last reported time ${solver.lastTime}`,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      exitCode: r.exit_code,
      deadline: false,
    };
  }
  // Only a clean process exit is eligible for a finished state, and even then
  // the log decides whether the physics completed.
  if (!solver.terminatedNormally) {
    return {
      state: "failed",
      stopReason: "solver_error",
      detail:
        solver.lastTime !== null
          ? `the process exited 0 but the log reports time steps without a normal end; last time ${solver.lastTime}`
          : "the process exited 0 but no solver output was produced",
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      exitCode: r.exit_code,
      deadline: false,
    };
  }
  const reached =
    solver.lastTime !== null && solver.lastTime >= requestedEndTime * 0.999;
  return {
    state: reached ? "finished" : "failed",
    stopReason: reached ? null : "short_interval",
    detail: reached
      ? "the solver exited 0, ended normally, and reached the requested end time"
      : `the solver exited 0 and ended normally but the last reported time ${solver.lastTime} is short of the requested ${requestedEndTime}`,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    exitCode: r.exit_code,
    deadline: false,
  };
}
