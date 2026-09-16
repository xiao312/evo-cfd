import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AGENT_STATE_PATH,
  GENOME_PATH,
  RSIH_PATH,
  TASK_PATH,
  buildProposerContainer,
  isMounted,
  type AgentContainerLaunch,
} from "../src/isolate.ts";

const SPEC = {
  runRoot: "/data2/kexiao/EvoCFD/runs/proposal-001",
  rsihDir: "/data2/kexiao/EvoCFD/third_party/RSI-Harness",
  agentStateDir: "/data2/kexiao/EvoCFD/runs/agent-state/proposal-001",
  genomeDir: "/data2/kexiao/EvoCFD/genomes/evocfd-proposer",
  uid: 1001,
  gid: 1001,
};

test("proposer isolation: builds a docker argv from host paths", () => {
  const launch = buildProposerContainer(SPEC, "evocfd-dev:node22");
  assert.equal(launch.image, "evocfd-dev:node22");
  assert.equal(launch.args[0], "--rm");
  assert.ok(launch.args.includes("--read-only"));
  assert.ok(launch.args.includes("--user=1001:1001"));
  assert.ok(launch.args.includes("--cap-drop=ALL"));
  assert.ok(launch.args.includes("--security-opt=no-new-privileges"));
});

test("proposer isolation: has exactly six mounts, and only two are writable", () => {
  const launch = buildProposerContainer(SPEC, "evocfd-dev:node22");
  assert.equal(launch.mounts.length, 6);
  const writable = launch.mounts.filter((mount) => mount.mode === "rw");
  assert.equal(writable.length, 2);
  assert.deepEqual(
    writable.map((mount) => mount.container).sort(),
    ["/agent-state", "/output"].sort(),
  );
});

test("proposer isolation: the evidence package and the prompt are read-only", () => {
  const launch = buildProposerContainer(SPEC, "evocfd-dev:node22");
  const byContainer = new Map(launch.mounts.map((mount) => [mount.container, mount]));
  assert.equal(byContainer.get("/proposal-input")?.mode, "ro");
  assert.equal(byContainer.get(TASK_PATH)?.mode, "ro");
  assert.equal(byContainer.get(RSIH_PATH)?.mode, "ro");
  assert.equal(byContainer.get(GENOME_PATH)?.mode, "ro");
});

test("proposer isolation: the docker socket is not mounted", () => {
  const launch = buildProposerContainer(SPEC, "evocfd-dev:node22");
  assert.ok(
    !launch.args.some((arg) => arg.includes("docker.sock")),
    "a proposer must not be able to run containers",
  );
  assert.ok(!launch.args.some((arg) => arg.includes("/var/run")));
});

test("proposer isolation: the parent Genome is visible only through the evidence", () => {
  const launch = buildProposerContainer(SPEC, "evocfd-dev:node22");
  // The parent's bundle directory is never mounted directly.
  assert.ok(
    !launch.mounts.some((mount) => mount.host.endsWith("genomes/m1-baseline")),
    "the parent Genome must not be a mount",
  );
  // It is reachable only as a subtree of the read-only evidence package.
  const evidence = launch.mounts.find((mount) => mount.container === "/proposal-input");
  assert.ok(evidence);
  assert.ok(evidence.host.endsWith("private/proposal-input"));
});

test("proposer isolation: rejects a non-absolute path", () => {
  for (const overrides of [
    { runRoot: "runs/proposal-001" },
    { rsihDir: "third_party/RSI-Harness" },
    { agentStateDir: "agent-state/x" },
    { genomeDir: "genomes/evocfd-proposer" },
  ]) {
    assert.throws(
      () => buildProposerContainer({ ...SPEC, ...overrides }, "evocfd-dev:node22"),
      /must be an absolute path/,
      `expected rejection of ${JSON.stringify(overrides)}`,
    );
  }
});

test("proposer isolation: rejects running as root", () => {
  assert.throws(
    () => buildProposerContainer({ ...SPEC, uid: 0 }, "evocfd-dev:node22"),
    /must not run as root/,
  );
  assert.throws(
    () => buildProposerContainer({ ...SPEC, gid: 0 }, "evocfd-dev:node22"),
    /must not run as root/,
  );
});

test("proposer isolation: the working directory is the output directory", () => {
  const launch = buildProposerContainer(SPEC, "evocfd-dev:node22");
  const workingDirIndex = launch.args.indexOf("-w");
  assert.equal(launch.args[workingDirIndex + 1], "/output");
});

test("proposer isolation: the same spec always builds the same command", () => {
  const a = buildProposerContainer(SPEC, "evocfd-dev:node22");
  const b = buildProposerContainer(SPEC, "evocfd-dev:node22");
  assert.deepEqual(a.args, b.args);
  assert.deepEqual(a.mounts, b.mounts);
});

test("proposer isolation: isMounted reports reachability and nothing else", () => {
  const launch: AgentContainerLaunch = buildProposerContainer(SPEC, "evocfd-dev:node22");
  const evidenceFile = "/data2/kexiao/EvoCFD/runs/proposal-001/private/proposal-input/evidence/m1-trial-001/episode/events.jsonl";
  assert.ok(isMounted(launch, evidenceFile), "a file inside a mount is reachable");
  assert.ok(isMounted(launch, SPEC.runRoot + "/agent/TASK.md"), "the prompt is reachable");
  // The run root as a whole is not mounted — only the two subdirectories a
  // proposer needs, which is the point of the boundary.
  assert.ok(!isMounted(launch, SPEC.runRoot), "the run root is not itself a mount");
  assert.ok(
    !isMounted(launch, "/data2/kexiao/EvoCFD/genomes/m1-baseline"),
    "the parent Genome is not mounted",
  );
  assert.ok(
    !isMounted(launch, "/data2/kexiao/EvoCFD/fixtures/control-plane-001/evaluator/check.mjs"),
    "an evaluator is not mounted",
  );
  assert.ok(
    !isMounted(launch, "/data2/kexiao/EvoCFD/runs/proposal-002"),
    "another proposal run is not mounted",
  );
});

test("proposer isolation: extra hosts are forwarded verbatim", () => {
  const launch = buildProposerContainer(
    { ...SPEC, extraHosts: ["host.docker.internal:host-gateway"] },
    "evocfd-dev:node22",
  );
  const index = launch.args.indexOf("--add-host");
  assert.equal(launch.args[index + 1], "host.docker.internal:host-gateway");
});
