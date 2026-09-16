import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import {
  buildCommand,
  cancelJob,
  executePlan,
  inspectContainer,
  planDigest,
  readJobRecord,
  readLastTime,
  readTerminatedNormally,
  resolveProfile,
  TERMINAL_STATES,
  updateJobState,
  writeJobRecord,
} from "../src/cfd-exec.ts";
import type { CfdJobPlan, CfdJobState } from "../src/cfd-job.ts";

const profile = resolveProfile({
  id: "of8-realfluid",
  executable: "/data2/kexiao/of8/rf-profile/bin/realFluidReactingFoam",
  executableSha256: "2d2d98f7d7f6b53e0a4b145054ee0181c769ca26abb542af0cc863bec2ee989e",
  envFile: "/data2/kexiao/of8/rf-profile-env.sh",
  libraryPaths: [
    "/data2/kexiao/of8/rf-profile/lib",
    "/data2/kexiao/of8/OpenFOAM-8/platforms/linux64GccDPInt32Opt/lib",
  ],
  expectedProfileLibraries: [
    "libreactionThermophysicalModels.so",
    "libspecie.so",
    "libchemistryModel.so",
  ],
});

function makePlan(caseDir: string, logFile: string): CfdJobPlan {
  return {
    jobId: `job-${randomBytes(4).toString("hex")}`,
    profile,
    caseDir,
    args: [],
    budgetSeconds: 60,
    requestedEndTime: 0.002,
    ranks: 1,
    logFile,
  };
}

test("planDigest is stable and distinguishes differing plans", () => {
  const plan = makePlan("/case/a", "log.txt");
  const same = { ...plan };
  const other = { ...plan, requestedEndTime: 0.01 };
  assert.equal(planDigest(plan), planDigest(same));
  assert.notEqual(planDigest(plan), planDigest(other));
});

test("writeJobRecord then readJobRecord round-trips", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cfdjob-"));
  const plan = makePlan("/case/a", "log.txt");
  const state: CfdJobState = {
    jobId: plan.jobId,
    state: "submitted",
    submittedAt: 123,
    startedAt: null,
    finishedAt: null,
    container: null,
    lastReportedTime: null,
    terminatedNormally: false,
    stopReason: null,
    detail: "",
  };
  await writeJobRecord(dir, { plan, state, planDigest: planDigest(plan) });
  const back = await readJobRecord(dir);
  assert.equal(back?.plan.jobId, plan.jobId);
  assert.equal(back?.planDigest, planDigest(plan));
  await rm(dir, { recursive: true, force: true });
});

test("readJobRecord returns null when no record exists", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cfdjob-"));
  assert.equal(await readJobRecord(dir), null);
  await rm(dir, { recursive: true, force: true });
});

test("readJobRecord rejects a record whose plan was rewritten", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cfdjob-"));
  const plan = makePlan("/case/a", "log.txt");
  const state: CfdJobState = {
    jobId: plan.jobId,
    state: "submitted",
    submittedAt: 1,
    startedAt: null,
    finishedAt: null,
    container: null,
    lastReportedTime: null,
    terminatedNormally: false,
    stopReason: null,
    detail: "",
  };
  await writeJobRecord(dir, { plan, state, planDigest: planDigest(plan) });
  // Tamper with the plan after the fact.
  const raw = await import("node:fs/promises").then((fs) =>
    fs.readFile(join(dir, "job-record.json"), "utf8"),
  );
  const tampered = JSON.parse(raw);
  tampered.plan.requestedEndTime = 999;
  await import("node:fs/promises").then((fs) =>
    fs.writeFile(join(dir, "job-record.json"), JSON.stringify(tampered)),
  );
  await assert.rejects(() => readJobRecord(dir), /does not match its own digest/);
  await rm(dir, { recursive: true, force: true });
});

test("writeJobRecord refuses to overwrite an existing record", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cfdjob-"));
  const plan = makePlan("/case/a", "log.txt");
  const state: CfdJobState = {
    jobId: plan.jobId,
    state: "submitted",
    submittedAt: 1,
    startedAt: null,
    finishedAt: null,
    container: null,
    lastReportedTime: null,
    terminatedNormally: false,
    stopReason: null,
    detail: "",
  };
  const record = { plan, state, planDigest: planDigest(plan) };
  await writeJobRecord(dir, record);
  await assert.rejects(() => writeJobRecord(dir, record), /already exists/);
  await rm(dir, { recursive: true, force: true });
});

test("updateJobState advances state and preserves the plan digest", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cfdjob-"));
  const plan = makePlan("/case/a", "log.txt");
  const submitted: CfdJobState = {
    jobId: plan.jobId,
    state: "submitted",
    submittedAt: 1,
    startedAt: null,
    finishedAt: null,
    container: null,
    lastReportedTime: null,
    terminatedNormally: false,
    stopReason: null,
    detail: "",
  };
  await writeJobRecord(dir, { plan, state: submitted, planDigest: planDigest(plan) });
  const finished: CfdJobState = {
    ...submitted,
    state: "finished",
    finishedAt: 5,
    terminatedNormally: true,
    lastReportedTime: 0.002,
    detail: "solver exited 0",
  };
  await updateJobState(dir, finished);
  const back = await readJobRecord(dir);
  assert.equal(back?.state.state, "finished");
  assert.equal(back?.state.lastReportedTime, 0.002);
  assert.equal(back?.planDigest, planDigest(plan));
  await rm(dir, { recursive: true, force: true });
});

test("readLastTime finds the last reported physical time", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cfdjob-"));
  const log = join(dir, "log.txt");
  await writeFile(
    log,
    ["Time = 1e-05", "some solver output", "Time = 0.00199", "Time = 0.002", "End"].join(
      "\n",
    ) + "\n",
  );
  assert.equal(await readLastTime(log), 0.002);
  await rm(dir, { recursive: true, force: true });
});

test("readLastTime returns null for a missing log", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cfdjob-"));
  assert.equal(await readLastTime(join(dir, "nope.txt")), null);
  await rm(dir, { recursive: true, force: true });
});

test("readTerminatedNormally requires the final line to be End", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cfdjob-"));
  const log = join(dir, "log.txt");
  await writeFile(log, "Time = 0.002\nEnd\n");
  assert.equal(await readTerminatedNormally(log), true);
  await writeFile(log, "Time = 0.002\nFOAM exiting\n");
  assert.equal(await readTerminatedNormally(log), false);
  await rm(dir, { recursive: true, force: true });
});

test("buildCommand sources the profile environment before the solver", () => {
  const plan = makePlan("/case/a", "log.txt");
  const command = buildCommand(plan);
  assert.ok(command.startsWith("source /data2/kexiao/of8/rf-profile-env.sh"));
  assert.ok(command.includes("realFluidReactingFoam"));
});

test("buildCommand converts Windows separators, which bash cannot read", () => {
  // A plan assembled on the controller's side of the boundary can carry a
  // Windows path; the command runs under bash, where \U, \x and \t are
  // escapes that silently eat the path. This is the same defect class as the
  // EVOCFD_HOST_ROOT mount bug, and it is caught here rather than at runtime.
  // The backslash is built from a charCode so the test source itself cannot
  // be mangled by its own escaping.
  const bs = String.fromCharCode(92);
  const exe = ["C:", "Users", "xiaox", "solver.exe"].join(bs);
  const caseArg = ["C:", "Users", "xiaox", "case"].join(bs);
  const plan: CfdJobPlan = {
    ...makePlan("/case/a", "log.txt"),
    profile: { ...profile, executable: exe },
    args: ["-case", caseArg],
  };
  const command = buildCommand(plan);
  assert.ok(!command.includes(bs), `command still carries a backslash: ${command}`);
  assert.ok(command.includes("C:/Users/xiaox/solver.exe"));
  assert.ok(command.includes("C:/Users/xiaox/case"));
});

test("buildCommand wraps multi-rank runs in mpirun", () => {
  const plan = { ...makePlan("/case/a", "log.txt"), ranks: 4 };
  assert.ok(buildCommand(plan).includes("mpirun -np 4"));
});

test("executePlan reports a solver that fails", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cfdjob-"));
  const failing = join(dir, "failing-solver.sh");
  await writeFile(failing, "#!/bin/sh\nexit 3\n");
  const plan: CfdJobPlan = {
    ...makePlan(dir, "log.txt"),
    profile: { ...profile, executable: `sh ${failing}`, envFile: "/dev/null" },
    budgetSeconds: 30,
  };
  const state = await executePlan(plan, dir, dir);
  assert.equal(state.state, "failed");
  assert.equal(state.stopReason, "solver_error");
  assert.match(state.detail, /exited with code/);
  await rm(dir, { recursive: true, force: true });
});

test("executePlan reports a solver that succeeds and ends normally", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cfdjob-"));
  // A fake solver that prints the lines the parser looks for.
  const fake = join(dir, "fake-solver.sh");
  await writeFile(
    fake,
    "#!/bin/sh\nprintf 'Time = 1e-05\\nTime = 0.002\\nEnd\\n'\n",
  );
  const plan: CfdJobPlan = {
    ...makePlan(dir, "log.txt"),
    profile: {
      ...profile,
      executable: `sh ${fake}`,
      envFile: "/dev/null",
    },
    budgetSeconds: 30,
  };
  const state = await executePlan(plan, dir, dir);
  assert.equal(state.state, "finished");
  assert.equal(state.terminatedNormally, true);
  assert.equal(state.lastReportedTime, 0.002);
  await rm(dir, { recursive: true, force: true });
});

test("executePlan stops a job that exceeds its budget", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cfdjob-"));
  const fake = join(dir, "fake-solver.sh");
  await writeFile(fake, "#!/bin/sh\nsleep 30\n");
  const plan: CfdJobPlan = {
    ...makePlan(dir, "log.txt"),
    profile: { ...profile, executable: `sh ${fake}`, envFile: "/dev/null" },
    budgetSeconds: 1,
  };
  const state = await executePlan(plan, dir, dir);
  assert.equal(state.state, "cancelled");
  assert.equal(state.stopReason, "budget");
  await rm(dir, { recursive: true, force: true });
});

test("a controller restart finds an existing job record", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cfdjob-"));
  const plan = makePlan(dir, "log.txt");
  const state: CfdJobState = {
    jobId: plan.jobId,
    state: "running",
    submittedAt: 100,
    startedAt: 101,
    finishedAt: null,
    container: null,
    lastReportedTime: null,
    terminatedNormally: false,
    stopReason: null,
    detail: "",
  };
  await writeJobRecord(dir, { plan, state, planDigest: planDigest(plan) });
  // Simulate a restart: a fresh process reads the record.
  const found = await readJobRecord(dir);
  assert.equal(found?.state.state, "running");
  assert.equal(found?.plan.jobId, plan.jobId);
  await rm(dir, { recursive: true, force: true });
});

test("inspectContainer returns null when docker is unavailable", () => {
  // docker is absent on the development host; the function must not throw.
  const facts = inspectContainer("nonexistent-container-id");
  assert.equal(facts, null);
});

test("cancelJob reports when a container cannot be stopped", () => {
  const result = cancelJob("nonexistent-container-id", "job-x");
  // Without docker, the stop fails and the state must not claim cancellation.
  assert.notEqual(result.state, "cancelled");
});

test("TERMINAL_STATES has exactly three states", () => {
  assert.deepEqual(TERMINAL_STATES, ["finished", "failed", "cancelled"]);
});
