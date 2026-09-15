/**
 * Enforced isolation tests.
 *
 * The boundary is a property of the command that gets run, so it is tested as
 * one: given the same spec, the generated argument list must mount exactly the
 * agent's four things, nothing that judges or records it, and must not grant
 * the process anything it does not need.
 *
 * A container-level check that the mounts actually deny access runs on the
 * compute host through scripts/verify-isolation.mjs, not here: this suite must
 * pass anywhere, with no Docker available.
 *
 * Run with: node --experimental-strip-types --test test/*.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { buildAgentContainer, isMounted, type IsolationSpec } from "../src/isolate.ts";

const SPEC: IsolationSpec = {
  trialRoot: "/runs/trial-001",
  rsihDir: "/opt/rsih",
  agentStateDir: "/runs/agent-state/trial-001",
  uid: 1001,
  gid: 1001,
  extraHosts: ["host.docker.internal:host-gateway"],
};

function launch() {
  return buildAgentContainer(SPEC, "evocfd-agent:node22");
}

test("the agent view is mounted exactly four times", () => {
  const { mounts } = launch();
  assert.deepEqual(
    mounts.map((m) => `${m.container}:${m.mode}`),
    ["/task:ro", "/task/workspace:rw", "/rsih:ro", "/agent-state:rw"],
  );
});

test("the prompt is read-only and the workspace is the only writable task path", () => {
  const { mounts } = launch();
  const task = mounts.find((m) => m.container === "/task");
  const workspace = mounts.find((m) => m.container === "/task/workspace");
  assert.equal(task?.mode, "ro");
  assert.equal(workspace?.mode, "rw");
  assert.equal(mounts.filter((m) => m.mode === "rw").length, 2);
});

test("nothing that judges or records the trial is mounted", () => {
  const { mounts } = launch();
  for (const mount of mounts) {
    assert.equal(mount.host.includes("private"), false, `private path mounted: ${mount.host}`);
    assert.equal(mount.host.includes("manifests"), false, `manifests path mounted: ${mount.host}`);
    assert.equal(mount.host.includes("evaluator"), false, `evaluator path mounted: ${mount.host}`);
  }
});

test("the denied paths are exactly the ones an agent must not reach", () => {
  const { denied } = launch();
  // Normalized to segments: the host path separator differs by platform, but
  // the shape of what is denied must not.
  const norm = (p: string) => p.split(/[/\\]+/).filter(Boolean).join("/");
  assert.deepEqual(
    denied.map(norm).sort(),
    [
      "runs/trial-001",
      "runs/trial-001/manifests",
      "runs/trial-001/private",
      "runs/trial-001/private/evaluator",
    ].sort(),
  );
});

test("isMounted sees the agent paths and nothing beyond the boundary", () => {
  const l = launch();
  assert.equal(isMounted(l, join(SPEC.trialRoot, "agent", "workspace", "app.js")), true);
  assert.equal(isMounted(l, join(SPEC.trialRoot, "agent", "TASK.md")), true);
  assert.equal(isMounted(l, SPEC.rsihDir), true);
  assert.equal(isMounted(l, join(SPEC.trialRoot, "private", "evaluator", "check.mjs")), false);
  assert.equal(isMounted(l, join(SPEC.trialRoot, "manifests", "trial.json")), false);
  // A sibling trial, under the same runs root but outside this trial.
  assert.equal(isMounted(l, "/runs/trial-002/agent/workspace/app.js"), false);
});

test("the container is hardened and runs as a non-root user", () => {
  const { args } = launch();
  assert.ok(args.includes("--cap-drop=ALL"));
  assert.ok(args.includes("--security-opt=no-new-privileges"));
  assert.ok(args.includes("--user=1001:1001"));
  assert.ok(args.includes("--read-only"));
  assert.ok(args.some((arg) => arg.startsWith("--tmpfs=/tmp")));
  assert.equal(args.includes("--privileged"), false);
  // No access to the host daemon: that would be the whole machine.
  assert.equal(args.some((arg) => arg.includes("docker.sock")), false);
  assert.equal(args.some((arg) => arg.includes("/var/run/docker.sock")), false);
});

test("the agent works inside its workspace, not on the host filesystem", () => {
  const { args } = launch();
  const workIndex = args.indexOf("-w");
  assert.equal(args[workIndex + 1], "/task/workspace");
});

test("the command is reproducible", () => {
  assert.deepEqual(launch().args, launch().args);
});

test("a spec with a relative path is refused", () => {
  for (const spec of [
    { ...SPEC, trialRoot: "runs/trial-001" },
    { ...SPEC, rsihDir: "rsih" },
    { ...SPEC, agentStateDir: "state" },
  ]) {
    assert.throws(() => buildAgentContainer(spec, "img"), /must be an absolute path/);
  }
});

test("a spec that would run the agent as root is refused", () => {
  assert.throws(() => buildAgentContainer({ ...SPEC, uid: 0 }, "img"), /must not run as root/);
  assert.throws(() => buildAgentContainer({ ...SPEC, gid: 0 }, "img"), /must not run as root/);
});
