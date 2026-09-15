import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { buildLaunchPlan } from "../src/index.ts";
import type { Installation } from "../src/index.ts";

const installation: Installation = {
  root: "/opt/RSI-Harness",
  source: "RSIH_ROOT",
  revision: "33c4f8dfac4359987f2e814e187de67c332498de",
  piVersion: "0.84.3",
};

const environment = {
  home: "/home/worker",
  path: "/usr/local/bin:/usr/bin:/bin",
  agentDir: "/state/agent",
};

const options = {
  genome: "/cases/fixture-1/genome.json",
  cwd: "/cases/fixture-1/task",
};

test("runs RSI-Harness from source through Node's type stripping", () => {
  const plan = buildLaunchPlan(installation, environment, options);
  assert.equal(plan.command, "node");
  assert.deepEqual(plan.args.slice(0, 6), [
    "--experimental-strip-types",
    join(installation.root, "src", "cli.ts"),
    "--genome",
    options.genome,
    "--cwd",
    options.cwd,
  ]);
});

test("emits JSON and skips ambient context files by default", () => {
  const plan = buildLaunchPlan(installation, environment, options);
  assert.ok(plan.args.includes("--json"));
  assert.ok(plan.args.includes("--no-context-files"));
});

test("context files can be re-enabled explicitly", () => {
  const plan = buildLaunchPlan(installation, environment, { ...options, noContextFiles: false });
  assert.ok(!plan.args.includes("--no-context-files"));
});

test("optional flags are absent until given", () => {
  const plan = buildLaunchPlan(installation, environment, options);
  for (const flag of ["--profile", "--model", "--max-turns", "--run-id", "--session-dir", "--config"]) {
    assert.ok(!plan.args.includes(flag), `unexpected ${flag}`);
  }
});

test("forwards profile, model, turns, run id, session dir, and config", () => {
  const plan = buildLaunchPlan(installation, environment, {
    ...options,
    profile: "intern-ai",
    model: "Atria-Dawn-Preview",
    maxTurns: 12,
    runId: "r-1",
    sessionDir: "/runs/r-1/session",
    config: "/state/pi.json",
  });
  const at = (flag: string) => plan.args.indexOf(flag);
  const after = (flag: string) => plan.args[at(flag) + 1];
  assert.equal(after("--profile"), "intern-ai");
  assert.equal(after("--model"), "Atria-Dawn-Preview");
  assert.equal(after("--max-turns"), "12"); // stringified, not a raw number
  assert.equal(after("--run-id"), "r-1");
  assert.equal(after("--session-dir"), "/runs/r-1/session");
  assert.equal(after("--config"), "/state/pi.json");
});

test("extra arguments are appended after everything else", () => {
  const plan = buildLaunchPlan(installation, environment, {
    ...options,
    extraArgs: ["@taskfile.md"],
  });
  assert.equal(plan.args[plan.args.length - 1], "@taskfile.md");
});

test("rejects relative paths for genome and cwd", () => {
  assert.throws(
    () => buildLaunchPlan(installation, environment, { ...options, genome: "genome.json" }),
    /Launch option genome must be an absolute path/,
  );
  assert.throws(
    () => buildLaunchPlan(installation, environment, { ...options, cwd: "task" }),
    /Launch option cwd must be an absolute path/,
  );
});

test("the worker environment is the controlled one, not the controller's", () => {
  const plan = buildLaunchPlan(installation, environment, options);
  assert.equal(plan.env.PATH, environment.path);
  assert.equal(plan.env.PI_CODING_AGENT_DIR, environment.agentDir);
  assert.equal(Object.keys(plan.env).length, 8);
});

test("the task workspace is the process cwd", () => {
  assert.equal(buildLaunchPlan(installation, environment, options).cwd, options.cwd);
});
