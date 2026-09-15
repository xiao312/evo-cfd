/**
 * Trial materialization, reset, and identity tests.
 *
 * These test the invariants the whole experiment rests on: that a trial starts
 * from a known state, that the state can be reproduced exactly, that two
 * trials cannot contaminate each other, and that what identifies a trial is
 * its content — never where it sits on disk, and never a credential.
 *
 * The shipped control-plane-001 fixture is used where the point is the real
 * fixture, and a synthesized fixture where the point is an edge case.
 *
 * Run with: node --experimental-strip-types --test test/*.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type LoadedFixture,
  loadFixture,
} from "../src/fixtures.ts";
import {
  ResetDriftError,
  TrialAlreadyExistsError,
  digestTree,
  materializeFixture,
  resetTrial,
  trialIdentity,
  trialLayout,
} from "../src/snapshot.ts";

const REPO_ROOT = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const REAL_FIXTURE_DIR = join(REPO_ROOT, "fixtures", "control-plane-001");

/** A secret sitting in the shell while a trial is materialized. */
const LEAKED_SECRET_NAME = "EVOCFD_GATEWAY_TOKEN";
const LEAKED_SECRET_VALUE = "do-not-record-me";

let staging: string;
let runsA: string;
let runsB: string;
let realFixture: LoadedFixture;

test.before(async () => {
  staging = await mkdtemp(join(tmpdir(), "evocfd-snapshot-"));
  runsA = join(staging, "runs-a");
  runsB = join(staging, "runs-b");
  realFixture = await loadFixture(REAL_FIXTURE_DIR);
  // A credential in the environment must never reach a manifest or a digest.
  process.env[LEAKED_SECRET_NAME] = LEAKED_SECRET_VALUE;
});

test.after(async () => {
  delete process.env[LEAKED_SECRET_NAME];
  await rm(staging, { recursive: true, force: true });
});

/** Build a fixture with one workspace file and one evaluator file. */
async function writeFixture(
  dir: string,
  workspaceFiles: Record<string, string>,
  evaluatorFiles: Record<string, string> = { "check.mjs": "process.exit(0);\n" },
): Promise<LoadedFixture> {
  await mkdir(join(dir, "workspace"), { recursive: true });
  await mkdir(join(dir, "evaluator"), { recursive: true });
  await writeFile(join(dir, "fixture.json"), JSON.stringify(definitionFor(basename(dir))));
  await writeFile(join(dir, "TASK.md"), "probe task\n");
  for (const [path, content] of Object.entries(workspaceFiles)) {
    await mkdir(dirname(join(dir, "workspace", path)), { recursive: true });
    await writeFile(join(dir, "workspace", path), content);
  }
  for (const [path, content] of Object.entries(evaluatorFiles)) {
    await mkdir(dirname(join(dir, "evaluator", path)), { recursive: true });
    await writeFile(join(dir, "evaluator", path), content);
  }
  return loadFixture(dir);
}

function definitionFor(fixtureId: string) {
  return {
    fixture_id: fixtureId,
    version: 1,
    task: { prompt: "TASK.md" },
    workspace: { source: "workspace" },
    evaluation: { source: "evaluator" },
    trial: { network_profile: "llm-only", max_agent_turns: 5, max_wall_seconds: 60 },
  };
}

test("materialization lays out the expected tree", async () => {
  const trial = await materializeFixture({
    fixture: realFixture,
    trialId: "layout",
    runsDir: runsA,
  });
  const layout = trialLayout(runsA, "layout");
  assert.equal(trial.layout.root, layout.root);

  // The agent view: prompt beside the workspace, not inside it.
  await assertFileExists(join(layout.agent, "TASK.md"));
  await assertFileExists(join(layout.agentWorkspace, "app.js"));
  await assertFileExists(join(layout.agentWorkspace, "config.json"));
  await assertFileExists(join(layout.agentWorkspace, "README.md"));

  // The private view, outside the agent tree.
  await assertFileExists(join(layout.evaluator, "check.mjs"));
  await assertFileExists(join(layout.evaluator, "README.md"));

  // The recorded identity, one file per concern.
  for (const path of Object.values(trial.manifests)) {
    await assertFileExists(path);
  }
});

test("the agent workspace is byte-identical to the fixture source", async () => {
  const trial = await materializeFixture({
    fixture: realFixture,
    trialId: "identical",
    runsDir: runsA,
  });
  const source = await digestTree(realFixture.workspaceSource);
  const copied = await digestTree(trial.layout.agentWorkspace);
  assert.equal(copied.digest, source.digest);
  assert.deepEqual(copied.files.sort(), source.files.sort());
});

test("evaluator assets never appear in the agent workspace", async () => {
  const trial = await materializeFixture({
    fixture: realFixture,
    trialId: "no-leak",
    runsDir: runsA,
  });
  const agent = await digestTree(trial.layout.agent);
  for (const name of agent.files) {
    assert.equal(name.includes("evaluator"), false, `evaluator file leaked into agent view: ${name}`);
    assert.equal(name.includes("check"), false, `evaluator file leaked into agent view: ${name}`);
  }
});

test("an existing trial directory is never overwritten", async () => {
  const first = await materializeFixture({
    fixture: realFixture,
    trialId: "once",
    runsDir: runsA,
  });
  const before = await readFile(join(first.layout.agent, "TASK.md"), "utf8");
  await assert.rejects(
    () => materializeFixture({ fixture: realFixture, trialId: "once", runsDir: runsA }),
    (error: unknown) => error instanceof TrialAlreadyExistsError,
  );
  assert.equal(await readFile(join(first.layout.agent, "TASK.md"), "utf8"), before);
});

test("a trial id that is not a plain directory name is refused", async () => {
  await assert.rejects(
    () => materializeFixture({ fixture: realFixture, trialId: "../escape", runsDir: runsA }),
    /not a plain directory name/,
  );
  await assert.rejects(
    () => materializeFixture({ fixture: realFixture, trialId: "has spaces", runsDir: runsA }),
    /not a plain directory name/,
  );
});

test("the shipped evaluator fails on the uncorrected workspace", async () => {
  const trial = await materializeFixture({
    fixture: realFixture,
    trialId: "baseline-state",
    runsDir: runsA,
  });
  const verdict = await runEvaluator(trial.layout);
  assert.equal(verdict.pass, false);
  const failed = verdict.criteria.filter((c) => c.pass === false).map((c) => c.criterion);
  assert.deepEqual(failed.sort(), ["config", "output"]);
  // The program is untouched, so the structure criterion passes as-is.
  assert.ok(verdict.criteria.some((c) => c.criterion === "structure" && c.pass));
});

test("the shipped evaluator passes once the configuration is corrected", async () => {
  const trial = await materializeFixture({
    fixture: realFixture,
    trialId: "corrected",
    runsDir: runsA,
  });
  // The intended fix: align the configuration key with what the program reads,
  // leaving the program alone.
  await writeFile(
    join(trial.layout.agentWorkspace, "config.json"),
    JSON.stringify({ units_per_kit: 12, site: "line-7" }, null, 2),
  );
  const verdict = await runEvaluator(trial.layout);
  assert.equal(verdict.pass, true, JSON.stringify(verdict.criteria, null, 2));
});

test("reset restores the exact initial state, twice", async () => {
  const trial = await materializeFixture({
    fixture: realFixture,
    trialId: "reset",
    runsDir: runsA,
  });
  const initial = trial.workspaceDigest;

  // The agent leaves the workspace in a different state.
  await writeFile(join(trial.layout.agentWorkspace, "config.json"), JSON.stringify({ units_per_kit: 12 }));
  await writeFile(join(trial.layout.agentWorkspace, "agent-note.md"), "i was here\n");
  await rm(join(trial.layout.agentWorkspace, "README.md"));

  const after1 = await resetTrial({ fixture: realFixture, layout: trial.layout });
  assert.equal(after1.workspaceDigest, initial);
  assert.deepEqual((await digestTree(trial.layout.agentWorkspace)).files.sort(), [
    "README.md",
    "app.js",
    "config.json",
  ]);

  // And again, to prove reset is not itself a mutating operation.
  await writeFile(join(trial.layout.agentWorkspace, "agent-note.md"), "i was here again\n");
  const after2 = await resetTrial({ fixture: realFixture, layout: trial.layout });
  assert.equal(after2.workspaceDigest, initial);
  assert.equal(after2.taskDigest, trial.taskDigest);
});

test("reset against a tampered baseline is refused", async () => {
  const trial = await materializeFixture({
    fixture: realFixture,
    trialId: "drift",
    runsDir: runsA,
  });
  // A baseline that no longer matches the fixture must not pass as a reset.
  await assert.rejects(
    () =>
      resetTrial({
        fixture: realFixture,
        layout: trial.layout,
        expected: { taskDigest: "0".repeat(64), workspaceDigest: "1".repeat(64) },
      }),
    (error: unknown) => error instanceof ResetDriftError,
  );
});

test("reset of an unmaterialized trial has no baseline to verify against", async () => {
  const layout = trialLayout(runsA, "never-materialized");
  await mkdir(join(layout.agentWorkspace), { recursive: true });
  await assert.rejects(
    () => resetTrial({ fixture: realFixture, layout }),
    (error: unknown) => error instanceof ResetDriftError && /no recorded baseline/.test(error.message),
  );
});

test("task identity changes when a task input changes", async () => {
  const left = await writeFixture(
    join(staging, "fixtures", "variant-left"),
    { "app.js": "console.log('left');\n" },
  );
  // A second fixture identical except for one workspace byte.
  const rightDir = join(staging, "fixtures", "variant-right");
  const right = await writeFixture(rightDir, { "app.js": "console.log('right');\n" });

  const a = await materializeFixture({ fixture: left, trialId: "t", runsDir: runsA });
  const b = await materializeFixture({ fixture: right, trialId: "t", runsDir: runsB });
  assert.notEqual(a.taskDigest, b.taskDigest);
  assert.notEqual(a.trialIdentity, b.trialIdentity);
});

test("task identity is independent of the runs directory and host paths", async () => {
  // The same fixture materialized into two different run roots, and read from
  // two different fixture locations, must identify identically.
  const relocated = join(staging, "fixtures", "relocated", "control-plane-001");
  await cp(REAL_FIXTURE_DIR, relocated, { recursive: true });
  const relocatedFixture = await loadFixture(relocated);

  const fromA = await materializeFixture({
    fixture: realFixture,
    trialId: "location",
    runsDir: runsA,
  });
  const fromB = await materializeFixture({
    fixture: relocatedFixture,
    trialId: "location",
    runsDir: runsB,
  });
  assert.equal(fromB.taskDigest, fromA.taskDigest);
  assert.equal(fromB.workspaceDigest, fromA.workspaceDigest);
  assert.equal(fromB.trialIdentity, fromA.trialIdentity);
  // Neither manifest mentions an absolute path of the other.
  const manifestA = await readFile(fromA.manifests.trial, "utf8");
  const manifestB = await readFile(fromB.manifests.trial, "utf8");
  assert.equal(manifestB.includes(runsA), false);
  assert.equal(manifestA.includes(runsB), false);
});

test("one trial's generated output never appears in another", async () => {
  const first = await materializeFixture({
    fixture: realFixture,
    trialId: "first",
    runsDir: runsA,
  });
  await writeFile(join(first.layout.agentWorkspace, "agent-note.md"), "trial one artifacts\n");

  const second = await materializeFixture({
    fixture: realFixture,
    trialId: "second",
    runsDir: runsA,
  });
  const files = (await digestTree(second.layout.agent)).files;
  assert.equal(files.includes("agent-note.md"), false);
  assert.equal(await readFile(join(second.layout.agentWorkspace, "config.json"), "utf8"),
    await readFile(join(REAL_FIXTURE_DIR, "workspace", "config.json"), "utf8"));

  // Resetting the second trial does not pull in the first trial's state.
  await resetTrial({ fixture: realFixture, layout: second.layout });
  const afterReset = (await digestTree(second.layout.agent)).files;
  assert.equal(afterReset.includes("agent-note.md"), false);
});

test("the network profile is part of trial identity", async () => {
  const offlineDir = join(staging, "fixtures", "offline-variant", "control-plane-001");
  await cp(REAL_FIXTURE_DIR, offlineDir, { recursive: true });
  const offline = await loadFixture(offlineDir);
  offline.definition.trial.network_profile = "offline";

  const online = await materializeFixture({
    fixture: realFixture,
    trialId: "profile",
    runsDir: runsA,
  });
  const offlineTrial = await materializeFixture({
    fixture: offline,
    trialId: "profile",
    runsDir: runsB,
  });
  assert.equal(offlineTrial.taskDigest, online.taskDigest);
  assert.notEqual(offlineTrial.trialIdentity, online.trialIdentity);
  assert.equal(
    (JSON.parse(await readFile(offlineTrial.manifests.environmentIdentity, "utf8")) as { network_profile: string })
      .network_profile,
    "offline",
  );
});

test("trial identity ignores environment secrets entirely", async () => {
  // A real credential is present in process.env for the whole suite; identity
  // takes only structured inputs, so it cannot depend on it.
  const a = trialIdentity({
    fixtureId: "x",
    fixtureVersion: 1,
    taskDigest: "d".repeat(64),
    networkProfile: "llm-only",
    maxAgentTurns: 5,
    maxWallSeconds: 60,
  });
  process.env[LEAKED_SECRET_NAME] = "a-different-value";
  const b = trialIdentity({
    fixtureId: "x",
    fixtureVersion: 1,
    taskDigest: "d".repeat(64),
    networkProfile: "llm-only",
    maxAgentTurns: 5,
    maxWallSeconds: 60,
  });
  assert.equal(a, b);
});

test("no manifest or digest contains a secret value", async () => {
  const trial = await materializeFixture({
    fixture: realFixture,
    trialId: "secrets",
    runsDir: runsA,
    environment: {
      environment_identity: "egress-identity-hash",
      credential_ref: "gateway-token:default",
    },
  });
  for (const path of Object.values(trial.manifests)) {
    const text = await readFile(path, "utf8");
    assert.equal(text.includes(LEAKED_SECRET_VALUE), false, `secret recorded in ${path}`);
  }
  // The credential is recorded by name only.
  const env = JSON.parse(await readFile(trial.manifests.environmentIdentity, "utf8")) as {
    credential_ref: string;
  };
  assert.equal(env.credential_ref, "gateway-token:default");
});

test("an uncharacterized environment is recorded as such, not as a secret", async () => {
  const trial = await materializeFixture({
    fixture: realFixture,
    trialId: "no-environment",
    runsDir: runsA,
  });
  const env = JSON.parse(await readFile(trial.manifests.environmentIdentity, "utf8")) as {
    environment_identity: string | null;
  };
  assert.equal(env.environment_identity, null);
  assert.notEqual(trial.trialIdentity, "");
});

async function assertFileExists(path: string): Promise<void> {
  try {
    await readFile(path);
  } catch (error) {
    assert.fail(`expected file to exist: ${path} (${(error as Error).message})`);
  }
}

/** Run the shipped evaluator against a materialized trial and parse its verdict. */
async function runEvaluator(layout: {
  evaluator: string;
  agentWorkspace: string;
}): Promise<{
  pass: boolean;
  criteria: { criterion: string; pass: boolean; detail: string }[];
}> {
  const { spawn } = await import("node:child_process");
  const out = await new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, [
      join(layout.evaluator, "check.mjs"),
      layout.agentWorkspace,
      join(REAL_FIXTURE_DIR, "workspace"),
    ]);
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk;
    });
    child.on("error", reject);
    child.on("close", () => resolve(stdout));
  });
  return JSON.parse(out);
}
