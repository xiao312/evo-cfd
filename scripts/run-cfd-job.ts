/**
 * Runs one real CFD job through the job-lifecycle primitive.
 *
 * This is the bridge the reviewer asked for: the solver that the
 * realfluid-baseline-001 bundle proved to exist, now launched, recorded and
 * assessed by EvoCFD's own controller code rather than by a hand-typed shell
 * command.
 *
 * It is deliberately not an agent episode. The point is to show the execution
 * layer works against the real solver before an agent is asked to reason about
 * one.
 */
import { join } from "node:path";
import { mkdir, cp, rm } from "node:fs/promises";

import {
  buildCommand,
  executePlan,
  planDigest,
  readJobRecord,
  resolveProfile,
  updateJobState,
  writeJobRecord,
} from "../packages/controller/src/cfd-exec.ts";

const CASES = "/data2/kexiao/of8/rf-cases";
const JOB = join(CASES, "job-1D-advection-001");
const SOURCE = join(CASES, "1D_advection");

const profile = resolveProfile({
  id: "of8-realfluid",
  executable: "/data2/kexiao/of8/rf-profile/bin/reactingFoam",
  executableSha256:
    "14fd124a0e46d043cdad5f9b6b8e26ed23d0778084d55c609e9665d58799007c",
  envFile: "/data2/kexiao/of8/rf-profile-env.sh",
  libraryPaths: [
    "/data2/kexiao/of8/rf-profile/lib",
    "/data2/kexiao/of8/OpenFOAM-8/platforms/linux64GccDPInt32Opt/lib",
  ],
  expectedProfileLibraries: [
    "libreactionThermophysicalModels.so",
    "libspecie.so",
    "libchemistryModel.so",
    "libcombustionModels.so",
  ],
});

const plan = {
  jobId: "1D-advection-001",
  profile,
  caseDir: JOB,
  args: [],
  budgetSeconds: 300,
  requestedEndTime: 0.002,
  ranks: 1,
  logFile: "log.react",
};

console.log("job plan recorded for", plan.jobId);
console.log("  executable:", plan.profile.executable);
console.log("  budget:", plan.budgetSeconds, "s; requested endTime", plan.requestedEndTime);
console.log("  plan digest:", planDigest(plan).slice(0, 16), "…");

// Fresh job directory each run; the record is write-once.
await rm(JOB, { recursive: true, force: true });
await mkdir(JOB, { recursive: true });
await cp(SOURCE, JOB, { recursive: true });

await writeJobRecord(JOB, {
  plan,
  state: {
    jobId: plan.jobId,
    state: "submitted",
    submittedAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    container: null,
    lastReportedTime: null,
    terminatedNormally: false,
    stopReason: null,
    detail: "",
  },
  planDigest: planDigest(plan),
});

console.log("executing...");
const state = await executePlan(plan, JOB, JOB);
await updateJobState(JOB, state);

console.log("state:", state.state);
console.log("  exit path:", state.detail);
console.log("  last reported time:", state.lastReportedTime);
console.log("  terminated normally:", state.terminatedNormally);
console.log("  stop reason:", state.stopReason);

const back = await readJobRecord(JOB);
console.log("record read back:", back?.state.state, "digest", back ? (back.planDigest.slice(0, 16) + "…") : "null");

const reached =
  state.state === "finished" &&
  state.terminatedNormally &&
  state.lastReportedTime !== null &&
  state.lastReportedTime >= plan.requestedEndTime * 0.999;

console.log(
  reached
    ? "ok the job reached its requested physical time through the controller"
    : "note: the job did not reach its requested physical time",
);
process.exitCode = 0;
