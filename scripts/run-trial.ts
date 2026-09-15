#!/usr/bin/env node
/**
 * Prepare one trial for execution: materialize it and write the launch plan.
 *
 * Preparation and execution are separated because they happen in different
 * places. Materializing needs no privileges; executing the agent needs Docker,
 * and the controller container deliberately has no Docker client. So this
 * script writes `private/agent-launch.json` — a complete, reproducible
 * description of how to run the agent — and `scripts/execute-trial.ts` runs it
 * where Docker actually lives.
 *
 * The launch plan is built by the rsih-adapter, so the trial drives
 * RSI-Harness's own CLI rather than Pi directly: the harness layer is where
 * turns are capped and where the genome is applied, which makes the harness
 * itself the thing a trial varies. The plan is recorded before it is run, so
 * what executes is exactly what is written down.
 *
 * Usage: node scripts/run-trial.ts <fixture-id> [--prepare] [--judge]
 *                          [--trial-id <id>] [--fake]
 */
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildAgentContainer } from "../packages/controller/src/isolate.ts";
import { evaluateTrial } from "../packages/controller/src/evaluate.ts";
import { loadMaterializedTrial, materializeFixture, digestTree } from "../packages/controller/src/snapshot.ts";
import { loadFixture } from "../packages/controller/src/fixtures.ts";
import { buildLaunchPlan, resolveInstallation } from "../packages/rsih-adapter/src/index.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// The controller sees the repository at a different path than the host does;
// mount sources must be host paths. See scripts/verify-isolation.mjs.
const HOST_ROOT = process.env.EVOCFD_HOST_ROOT ?? REPO_ROOT;
const RUNS_DIR = join(REPO_ROOT, "runs");
const HOST_RUNS_DIR = join(HOST_ROOT, "runs");
const FIXTURE_ROOT = join(REPO_ROOT, "fixtures");
const GENOME_ID = "m1-baseline";
const IMAGE = "evocfd-dev:node22";

const FIXTURE_ID = process.argv[2] ?? "control-plane-001";
const MODE_FAKE = process.argv.includes("--fake");
const MODE_JUDGE = process.argv.includes("--judge");
const TRIAL_ID = argValue("--trial-id") ?? `${FIXTURE_ID}-trial-001`;

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 || index + 1 >= process.argv.length ? undefined : process.argv[index + 1];
}

/**
 * The recorded identity of the harness that runs this trial.
 *
 * A trial's harness is what the programme varies, so it must be identifiable
 * rather than implicit: the genome bundle, the RSI-Harness revision it is driven
 * through, and the Pi version that revision vendors. Without this a trial record
 * says nothing about which agent loop produced the work.
 */
async function harnessIdentity(): Promise<{
  genome_id: string;
  genome_digest: string;
  rsih_root: string;
  rsih_revision: string | null;
  pi_version: string | null;
}> {
  const installation = resolveInstallation({
    rsihRoot: process.env.RSIH_ROOT,
    defaultRoot: join(REPO_ROOT, "third_party", "RSI-Harness"),
  });
  const genomeDir = join(REPO_ROOT, "genomes", GENOME_ID);
  const genome = await digestTree(genomeDir);
  return {
    genome_id: GENOME_ID,
    genome_digest: genome.digest,
    rsih_root: "/rsih",
    rsih_revision: installation.revision,
    pi_version: installation.piVersion,
  };
}

/** Seed the agent's config directory with everything except the credential. */
const SEED_CONFIG_DIR = join(REPO_ROOT, "config", "agent-seed");

if (!MODE_JUDGE) {
  const fixture = await loadFixture(join(FIXTURE_ROOT, FIXTURE_ID));
  const stateDir = join(RUNS_DIR, "agent-state", TRIAL_ID);
  await mkdir(stateDir, { recursive: true });
  const trial = await materializeFixture({ fixture, trialId: TRIAL_ID, runsDir: RUNS_DIR });
  console.log(`materialized ${TRIAL_ID} at ${trial.layout.root}`);

  const launch = buildAgentContainer(
    {
      trialRoot: join(HOST_RUNS_DIR, TRIAL_ID),
      rsihDir: join(HOST_ROOT, "third_party", "RSI-Harness"),
      agentStateDir: join(HOST_RUNS_DIR, "agent-state", TRIAL_ID),
      // The Genome bundle is the harness: read-only, so an agent cannot rewrite
      // the harness it is judged against.
      genomeDir: join(HOST_ROOT, "genomes", GENOME_ID),
      uid: 1001,
      gid: 1001,
    },
    IMAGE,
  );

  // What the agent is asked to do, as a launch plan the rsih-adapter built.
  // Container paths, because the plan executes inside the isolated container.
  const limits = fixture.definition.trial;

  const plan = MODE_FAKE
    ? {
        command: "node",
        args: ["/prober/fake-agent.mjs", "/task/workspace"],
        cwd: "/task/workspace",
        env: {},
      }
    : buildLaunchPlan(
        {
          root: "/rsih",
          source: "default",
          revision: null,
          piVersion: null,
        },
        // The worker runs inside the container; its HOME and PATH are the
        // container's own.
        { home: "/home/dfode", path: "/opt/node/bin:/usr/bin:/bin", agentDir: "/agent-state" },
        {
          genome: `/genome/genome.json`,
          cwd: "/task/workspace",
          runId: TRIAL_ID,
          profile: "evocfd-intern-ai",
          model: "Atria-Dawn-Preview",
          maxTurns: limits.max_agent_turns,
          sessionDir: "/agent-state/sessions",
          noContextFiles: true,
        },
      );

  const extraMounts = MODE_FAKE
    ? ["-v", `${join(HOST_ROOT, "scripts", "fake-agent.mjs")}:/prober/fake-agent.mjs:ro`]
    : [
        "-v",
        `${join(HOST_ROOT, "config", "agent-seed")}:/agent-seed:ro`,
        // The llm-only profile reaches the LLM gateway on the host's bridge
        // address and nothing else: the tunnel binds 172.17.0.1, and this
        // mapping is what makes that reachable from inside the container.
        "--add-host", "host.docker.internal:host-gateway",
      ];

  const envArgs = Object.entries(plan.env).flatMap(([name, value]) => ["-e", `${name}=${value}`]);

  const argv = [
    "docker",
    "run",
    ...extraMounts,
    ...envArgs,
    ...launch.args,
    plan.command,
    ...plan.args,
  ];

  const agentLaunch = {
    trial_id: TRIAL_ID,
    fixture_id: FIXTURE_ID,
    image: IMAGE,
    seed_config_dir: MODE_FAKE ? null : "/agent-seed",
    network_profile: limits.network_profile,
    max_agent_turns: limits.max_agent_turns,
    max_wall_seconds: limits.max_wall_seconds,
    harness: MODE_FAKE ? null : await harnessIdentity(),
    // Recorded verbatim and before anything runs; the episode runner executes
    // this exact plan.
    command: "docker",
    args: argv.slice(1),
    cwd: HOST_ROOT,
    env: plan.env,
  };
  await mkdir(trial.layout.privateDir, { recursive: true });
  await writeFile(
    join(trial.layout.privateDir, "agent-launch.json"),
    JSON.stringify(agentLaunch, null, 2) + "\n",
  );

  console.log(`wrote ${trial.layout.privateDir}/agent-launch.json`);
  console.log("");
  console.log("Run the agent where Docker lives, then judge it:");
  console.log(`  node scripts/execute-trial.ts ${TRIAL_ID}`);
  console.log(`  node scripts/run-trial.ts ${FIXTURE_ID} --judge --trial-id ${TRIAL_ID}`);
}

if (MODE_JUDGE) {
  const trial = await loadMaterializedTrial(RUNS_DIR, TRIAL_ID);
  const result = await evaluateTrial(trial);
  console.log("");
  console.log(`trial      ${result.trial_id}`);
  console.log(`verdict    ${result.pass ? "PASS" : "FAIL"}`);
  if (result.error) console.log(`error      ${result.error}`);
  for (const criterion of result.criteria) {
    console.log(`  ${criterion.pass ? "pass" : "fail"}  ${criterion.criterion} — ${criterion.detail}`);
  }
  console.log(`identity   ${result.trial_identity}`);
  process.exitCode = result.pass ? 0 : 1;
}
