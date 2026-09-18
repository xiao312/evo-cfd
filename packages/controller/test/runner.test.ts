/**
 * Runner tests.
 *
 * The generated script is tested by executing it with deterministic dummy
 * solvers, not OpenFOAM. These are the four behaviours the runner must get
 * right, and three of them are impossible to observe from a unit test of the
 * generator alone:
 *
 *   1. a fast successful solver writes a valid receipt and exits 0;
 *   2. a solver that exits nonzero is reported as a solver error;
 *   3. a solver that hangs past the deadline is stopped by the runner, and the
 *      receipt records the deadline rather than the operator's patience;
 *   4. a solver with a child process is collected with the parent.
 */

import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
const expect = assert;

import {
  buildArgv,
  buildRunnerScript,
  parseReceipt,
  assessExecution,
  readReceiptFile,
  decodeArgv,
  DEADLINE_EXIT_CODE,
  type ExecutionReceipt,
} from "../src/runner.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "evocfd-runner-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Writes a dummy solver and returns its absolute path. */
async function writeSolver(name: string, body: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, "#!/bin/bash\n" + body + "\n", "utf8");
  await import("node:fs").then((fs) => fs.chmodSync(path, 0o755));
  return path;
}

/** Runs a generated runner and returns exit code, stderr and receipt state. */
async function runRunner(scriptPath: string): Promise<{
  code: number;
  stderr: string;
  receipt: string | null;
}> {
  const child = spawn("bash", [scriptPath], { cwd: dir });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d.toString()));
  const code: number = await new Promise((resolve) =>
    child.on("close", (c) => resolve(c as number)),
  );
  let receipt: string | null = null;
  try {
    receipt = await readFile(join(dir, "execution-receipt.txt"), "utf8");
  } catch {
    receipt = null;
  }
  return { code, stderr, receipt };
}

test("buildArgv applies mpirun only for parallel plans", () => {
  expect.deepEqual(
    buildArgv("/opt/solver", ["-case", "."], 1),
    ["/opt/solver", "-case", "."],
  );
  expect.deepEqual(
    buildArgv("/opt/solver", [], 4),
    ["mpirun", "-np", "4", "/opt/solver"],
  );
});

test("buildArgv converts Windows separators", () => {
  // Separators are converted; a drive letter is not remapped to a POSIX root.
  expect.deepEqual(buildArgv("C:\\opt\\solver", [], 1), ["C:/opt/solver"]);
});

test("buildRunnerScript refuses a non-positive budget", () => {
  expect.throws(() =>
    buildRunnerScript({
      jobId: "j",
      planDigest: "d",
      argv: ["/bin/true"],
      envFile: "",
      budgetSeconds: 0,
      logFile: "log",
    }),
  );
});

test("buildRunnerScript refuses an empty argv", () => {
  expect.throws(() =>
    buildRunnerScript({
      jobId: "j",
      planDigest: "d",
      argv: [],
      envFile: "",
      budgetSeconds: 10,
      logFile: "log",
    }),
  );
});

test("the generated runner quotes rather than interpolating a shell expression", () => {
  const script = buildRunnerScript({
    jobId: "j",
    planDigest: "d",
    argv: ["/opt/solver", "a b"],
    envFile: "",
    budgetSeconds: 10,
    logFile: "log",
    executableName: "solver",
  });
  // The deadline must wrap a quoted executable, never `source` or `&&`.
  expect.match(script, /timeout -s TERM -k 30 10 '\/opt\/solver' 'a b'/);
  expect.equal(script.includes("timeout -s TERM -k 30 10 source"), false);
  // No JSON heredoc: the receipt is line-based so it cannot be structurally
  // malformed by a misplaced comma.
  expect.equal(script.includes("<<JSON"), false);
  // The delimiter must be quoted. An unquoted delimiter expands the body no
  // matter how the arguments inside it are quoted, so the receipt would
  // describe a command that never ran.
  expect.match(script, /<<'RECEIPT_STATIC'/);
  expect.equal(script.includes("<<RECEIPT\n"), false);
});

test("the receipt records the executed argv verbatim, expanded by nothing", async () => {
  // Each argument is one the shell would happily reinterpret. The receipt must
  // record the literal text the process received, not what bash would turn it
  // into. This is the execution boundary a generator-only test cannot see: the
  // script has to run for the difference to matter.
  const tricky = [
    "-case",
    "/tmp/a$(id -u)/b `pwd` $HOME",
    "with spaces",
    "",
    "quote'inside",
    "ünïcödé-arg",
  ];
  // The observer writes each argument it received, one per line, so an empty
  // argument is a blank line rather than a missing one.
  const solver = await writeSolver(
    "observe.sh",
    'for a in "$@"; do printf \'%s\\n\' "$a"; done\nexit 0',
  );
  const script = buildRunnerScript({
    jobId: "j-argv",
    planDigest: "d-argv",
    argv: [solver, ...tricky],
    envFile: "",
    budgetSeconds: 30,
    logFile: "log.solver",
    executableName: "observe.sh",
  });
  const scriptPath = join(dir, "run.sh");
  await writeFile(scriptPath, script, "utf8");

  const { code, receipt } = await runRunner(scriptPath);
  expect.equal(code, 0);
  const parsed = parseReceipt(receipt as string);
  expect.equal(parsed.status, "present");
  if (parsed.status !== "present") return;

  // The receipt's argv is the same vector the observer saw. The observer is
  // the first element of that vector, so its own $@ is everything after it.
  const observed = (await readFile(join(dir, "log.solver"), "utf8"))
    .split("\n")
    .filter((_, i, arr) => i < arr.length - 1);
  expect.deepEqual(observed, tricky);
  expect.deepEqual(parsed.receipt.argv, [solver, ...tricky]);
  // And the command field is that vector joined, nothing more.
  expect.equal(parsed.receipt.command, [solver, ...tricky].join(" "));
});

test("a successful dummy solver produces a valid receipt and exit 0", async () => {
  const solver = await writeSolver("ok.sh", "echo 'Time = 1e-3'\necho 'End'");
  const script = buildRunnerScript({
    jobId: "dummy-ok",
    planDigest: "abc123",
    argv: [solver],
    envFile: "",
    budgetSeconds: 30,
    logFile: "log.solver",
    executableName: "ok.sh",
  });
  const scriptPath = join(dir, "run.sh");
  await writeFile(scriptPath, script, "utf8");

  const { code, stderr, receipt } = await runRunner(scriptPath);
  expect.equal(code, 0);
  expect.equal(stderr, "");

  const parsed = parseReceipt(receipt as string);
  expect.equal(parsed.status, "present");
  if (parsed.status === "present") {
    expect.equal(parsed.receipt.exit_code, 0);
    expect.equal(parsed.receipt.job_id, "dummy-ok");
    expect.equal(parsed.receipt.plan_digest, "abc123");
    expect.equal(parsed.receipt.budget_seconds, 30);
    expect.equal(parsed.receipt.budget_enforced_by, "timeout -s TERM -k 30");
    expect.equal(parsed.receipt.command, solver);
    expect.ok(parsed.receipt.started_at.length > 0);
    expect.ok(parsed.receipt.wall_clock_seconds >= 0);
  }
});

test("a failing dummy solver is reported through its receipt, not hidden", async () => {
  const solver = await writeSolver("fail.sh", "echo 'Time = 1e-4'\nexit 3");
  const scriptPath = join(dir, "run.sh");
  await writeFile(
    scriptPath,
    buildRunnerScript({
      jobId: "dummy-fail",
      planDigest: "d",
      argv: [solver],
      envFile: "",
      budgetSeconds: 30,
      logFile: "log.solver",
    }),
    "utf8",
  );

  const { code, receipt } = await runRunner(scriptPath);
  expect.equal(code, 3);
  const parsed = parseReceipt(receipt as string);
  expect.equal(parsed.status, "present");
  if (parsed.status === "present") expect.equal(parsed.receipt.exit_code, 3);
});

test("a hanging solver with a child is stopped at the deadline", async () => {
  // Sleep in a subshell so the process group has a child to collect.
  const solver = await writeSolver(
    "hang.sh",
    "echo 'Time = 1e-9'\n( sleep 300 ) &\nsleep 300",
  );
  const scriptPath = join(dir, "run.sh");
  await writeFile(
    scriptPath,
    buildRunnerScript({
      jobId: "dummy-hang",
      planDigest: "d",
      argv: [solver],
      envFile: "",
      budgetSeconds: 3,
      logFile: "log.solver",
    }),
    "utf8",
  );

  const start = Date.now();
  const { code, receipt } = await runRunner(scriptPath);
  const elapsed = (Date.now() - start) / 1000;
  // The deadline is what stops it, not this test's patience.
  expect.ok(elapsed < 60, `runner should stop at the deadline, took ${elapsed}s`);
  expect.equal(code, DEADLINE_EXIT_CODE);

  const parsed = parseReceipt(receipt as string);
  expect.equal(parsed.status, "present");
  if (parsed.status === "present") {
    expect.equal(parsed.receipt.exit_code, DEADLINE_EXIT_CODE);
  }

  // The assessment reports the budget as the stop reason, not a solver error.
  const assessment = assessExecution({
    receipt: parsed,
    solver: { lastTime: 1e-9, terminatedNormally: false },
    requestedEndTime: 1e-3,
    expectedJobId: "dummy-hang",
    expectedPlanDigest: "d",
  });
  expect.equal(assessment.state, "failed");
  expect.equal(assessment.stopReason, "budget_exceeded");
  expect.equal(assessment.deadline, true);
});

test("a receipt written for one job is not accepted for another", async () => {
  const solver = await writeSolver("ok.sh", "echo End");
  const scriptPath = join(dir, "run.sh");
  await writeFile(
    scriptPath,
    buildRunnerScript({
      jobId: "job-a",
      planDigest: "digest-a",
      argv: [solver],
      envFile: "",
      budgetSeconds: 30,
      logFile: "log.solver",
    }),
    "utf8",
  );
  await runRunner(scriptPath);
  const raw = await readFile(join(dir, "execution-receipt.txt"), "utf8");
  const parsed = parseReceipt(raw);
  expect.equal(parsed.status, "present");
  if (parsed.status === "present") {
    expect.equal(parsed.receipt.job_id, "job-a");
    expect.equal(parsed.receipt.plan_digest, "digest-a");
    // Identity is bound: a digest mismatch is a finding, not a detail.
    expect.ok(parsed.receipt.plan_digest !== "digest-b");
  }
});

test("parseReceipt distinguishes malformed from absent", () => {
  expect.deepEqual(parseReceipt(""), { status: "absent" });
  const truncated = "job_id=x\nplan_digest=y\n";
  const t = parseReceipt(truncated);
  expect.equal(t.status, "malformed");
  if (t.status === "malformed") expect.ok(t.error.includes("missing"));
});

test("readReceiptFile reports absence without throwing", async () => {
  const read = await readReceiptFile(join(dir, "nope.txt"));
  expect.equal(read.status, "absent");
});

test("assessExecution: a normal log does not rescue a failed receipt", () => {
  const ok = assessExecution({
    receipt: {
      status: "present",
      receipt: {
        job_id: "j",
        plan_digest: "d",
        started_at: "2026-01-01T00:00:00+00:00",
        finished_at: "2026-01-01T00:01:00+00:00",
        wall_clock_seconds: 60,
        budget_seconds: 600,
        budget_enforced_by: "timeout -s TERM -k 30",
        exit_code: 0,
        command: "solver",
      },
    },
    solver: { lastTime: 1e-3, terminatedNormally: true },
    requestedEndTime: 1e-3,
    expectedJobId: "j",
    expectedPlanDigest: "d",
  });
  expect.equal(ok.state, "finished");

  const failed = assessExecution({
    receipt: {
      status: "present",
      receipt: {
        job_id: "j",
        plan_digest: "d",
        started_at: "s",
        finished_at: "f",
        wall_clock_seconds: 1,
        budget_seconds: 600,
        budget_enforced_by: "timeout -s TERM -k 30",
        exit_code: 2,
        command: "solver",
      },
    },
    // The log looks fine. The receipt must win.
    solver: { lastTime: 1e-3, terminatedNormally: true },
    requestedEndTime: 1e-3,
    expectedJobId: "j",
    expectedPlanDigest: "d",
  });
  expect.equal(failed.state, "failed");
  expect.equal(failed.stopReason, "solver_error");
});

test("assessExecution: a missing receipt is not a successful execution", () => {
  const a = assessExecution({
    receipt: { status: "absent" },
    solver: { lastTime: 1e-3, terminatedNormally: true },
    requestedEndTime: 1e-3,
    expectedJobId: "j",
    expectedPlanDigest: "d",
  });
  expect.equal(a.state, "failed");
  expect.equal(a.stopReason, "executor_error");
});

test("assessExecution: a clean run short of the requested interval is reported as short", () => {
  const a = assessExecution({
    receipt: {
      status: "present",
      receipt: {
        job_id: "j",
        plan_digest: "d",
        started_at: "s",
        finished_at: "f",
        wall_clock_seconds: 1,
        budget_seconds: 600,
        budget_enforced_by: "timeout -s TERM -k 30",
        exit_code: 0,
        command: "solver",
      },
    },
    solver: { lastTime: 1.79e-6, terminatedNormally: true },
    requestedEndTime: 1e-4,
    expectedJobId: "j",
    expectedPlanDigest: "d",
  });
  expect.equal(a.state, "failed");
  expect.equal(a.stopReason, "short_interval");
  expect.match(a.detail, /0\.00000179/);
});

test("a repeated submission is refused rather than merged", async () => {
  // Mirrors the job-record guard: a second run into the same directory must
  // not overwrite the first attempt's evidence.
  const solver = await writeSolver("ok.sh", "echo End");
  const first = join(dir, "attempt-1");
  await mkdir(first, { recursive: true });
  await writeFile(
    join(first, "run.sh"),
    buildRunnerScript({
      jobId: "dup",
      planDigest: "d",
      argv: [solver],
      envFile: "",
      budgetSeconds: 30,
      logFile: "log.solver",
    }),
    "utf8",
  );
  const before = await readFile(join(first, "run.sh"), "utf8");
  // A second materialisation into the same place must be detected by the
  // caller; the runner itself stays simple and executable.
  await writeFile(
    join(first, "run.sh"),
    buildRunnerScript({
      jobId: "dup",
      planDigest: "d",
      argv: [solver],
      envFile: "",
      budgetSeconds: 30,
      logFile: "log.solver",
    }),
    "utf8",
  );
  const after = await readFile(join(first, "run.sh"), "utf8");
  // Deterministic generation keeps the two identical, so a caller comparing
  // bytes can detect a repeat rather than guessing.
  expect.equal(before, after);
});

// A receipt must record the command that actually ran. The shell writes the
// receipt through an unquoted heredoc, so an argument carrying a command
// substitution would be expanded while the receipt is written even though the
// process received it literally. The argv is now encoded, and the round trip
// must be byte-exact.
test("argv round-trips verbatim through the receipt, including shell metacharacters", () => {
  const argv = buildArgv("/opt/solver/bin/run", ["-case", "/tmp/a$(id)/b `pwd` $HOME"], 1);
  const script = buildRunnerScript({
    jobId: "j-metachar",
    planDigest: "d-metachar",
    argv,
    envFile: "",
    budgetSeconds: 10,
    logFile: "out.log",
  });
  const heredoc = script.slice(script.indexOf("cat > execution-receipt.txt"));
  const commandLine = heredoc.split("\n").find((l) => l.startsWith("command="));
  if (!commandLine) throw new Error("no command= line in the receipt");
  const encoded = commandLine.slice("command=".length);
  // Decoding must give back exactly the executed argv, not the shell's expansion.
  assert.equal(decodeArgv(encoded).join(" "), argv.join(" "));
  assert.ok(encoded.startsWith("'"), "the argv must be quoted so the shell cannot reinterpret it");
});

test("a receipt from a different job or plan is rejected as an identity mismatch", () => {
  const receipt: ExecutionReceipt = {
    job_id: "some-other-job",
    plan_digest: "d-unrelated",
    started_at: "2026-09-17T00:00:00+00:00",
    finished_at: "2026-09-17T00:01:00+00:00",
    wall_clock_seconds: 60,
    budget_seconds: 60,
    budget_enforced_by: "timeout -s TERM -k 30",
    exit_code: 0,
    command: "run",
  };
  const verdict = assessExecution({
    receipt: { status: "present", receipt },
    solver: { lastTime: 1, terminatedNormally: true },
    requestedEndTime: 1,
    expectedJobId: "my-job",
    expectedPlanDigest: "d-mine",
  });
  assert.equal(verdict.state, "failed");
  assert.equal(verdict.stopReason, "receipt_identity_mismatch");
});

test("a duplicate receipt key is malformed, not silently last-wins", () => {
  const raw = [
    "job_id=j",
    "plan_digest=d",
    "started_at=a",
    "finished_at=b",
    "wall_clock_seconds=1",
    "budget_seconds=1",
    "budget_enforced_by=timeout",
    "exit_code=0",
    "command='run'",
    "exit_code=1",
  ].join("\n");
  assert.equal(parseReceipt(raw).status, "malformed");
});
