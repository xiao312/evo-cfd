#!/usr/bin/env node
/**
 * Prepare a proposal run: assemble the evidence, stage the output, and write
 * the proposer's launch plan.
 *
 * A proposal run is not a trial and the proposer is not the agent a trial
 * runs. The trial agent is scored on a workspace; the proposer is scored on
 * one file it writes, and it sees evidence a trial agent never would —
 * verdicts, event streams, the parent Genome — because deciding whether a
 * harness should change requires knowing what it did. What it never sees is
 * how it is judged: the evidence package carries results, never the evaluator
 * that produced them, and the Genome tree it reviews is read-only.
 *
 * The launch plan is written before anything runs, exactly as a trial's is,
 * so what executes is what is written down and nothing is launched on the
 * strength of a decision made mid-flight.
 *
 * Usage: node scripts/run-proposer.ts --parent <genome-id> --trials <id,...>
 *                          [--run-id <id>]
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assembleEvidencePackage, PROPOSER_OUTPUT_DIR } from "../packages/controller/src/evidence.ts";
import { buildProposerContainer } from "../packages/controller/src/isolate.ts";
import {
  buildHarnessSnapshot,
  defaultResolveGenomeDir,
  harnessIdentity,
} from "../packages/controller/src/harness.ts";
import { buildLaunchPlan, resolveInstallation } from "../packages/rsih-adapter/src/index.ts";
import { loadMaterializedTrial } from "../packages/controller/src/snapshot.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOST_ROOT = process.env.EVOCFD_HOST_ROOT ?? REPO_ROOT;
const RUNS_DIR = join(REPO_ROOT, "runs");
const HOST_RUNS_DIR = join(HOST_ROOT, "runs");
const GENOMES_DIR = join(REPO_ROOT, "genomes");
const SEED_CONFIG_DIR = join(REPO_ROOT, "config", "agent-seed");
const PROPOSER_GENOME_DIR = join(GENOMES_DIR, "evocfd-proposer");
const IMAGE = "evocfd-dev:node22";

const PARENT_ID = argValue("--parent") ?? "evocfd:m1-baseline";
const TRIAL_IDS = (argValue("--trials") ?? "")
  .split(",")
  .map((id) => id.trim())
  .filter((id) => id.length > 0);
const RUN_ID = argValue("--run-id") ?? "proposal-001";

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 || index + 1 >= process.argv.length ? undefined : process.argv[index + 1];
}

const installation = resolveInstallation({
  rsihRoot: process.env.RSIH_ROOT,
  defaultRoot: join(REPO_ROOT, "third_party", "RSI-Harness"),
});

const parentDir = await defaultResolveGenomeDir(GENOMES_DIR, PARENT_ID);
if (parentDir === null) {
  console.error(`parent Genome ${PARENT_ID} not found under ${GENOMES_DIR}`);
  process.exit(2);
}
if (TRIAL_IDS.length === 0) {
  console.error("usage: node scripts/run-proposer.ts --parent <genome-id> --trials <id,id,...>");
  process.exit(2);
}

// The evidence is only evidence if it was recorded. A trial id that was never
// materialized is a claim about a run that did not happen.
for (const trialId of TRIAL_IDS) {
  try {
    await loadMaterializedTrial(RUNS_DIR, trialId);
  } catch (error) {
    console.error(`trial ${trialId} is not a recorded trial: ${(error as Error).message}`);
    process.exit(2);
  }
}

const parentSnapshot = await buildHarnessSnapshot({
  genomeDir: parentDir,
  agentConfigDir: SEED_CONFIG_DIR,
  rsihRevision: installation.revision,
  piVersion: installation.piVersion,
});

const runRoot = join(RUNS_DIR, RUN_ID);
await mkdir(join(runRoot, "private"), { recursive: true });

const pkg = await assembleEvidencePackage({
  runRoot,
  runsDir: RUNS_DIR,
  trialIds: TRIAL_IDS,
  parentGenomeDir: parentDir,
  parentGenomeId: PARENT_ID,
  parentSnapshot,
});

// The scaffold is the proposal's shape without its content. The proposer fills
// it rather than inventing structure, so a malformed proposal is a proposer
// failure about fields, not a parsing failure about shapes.
const outputDir = join(runRoot, PROPOSER_OUTPUT_DIR);
await mkdir(outputDir, { recursive: true });
await writeFile(
  join(outputDir, "proposal-scaffold.json"),
  JSON.stringify(
    { schema_version: 1, decision: "no_change", rationale: "", evidence_refs: [] },
    null,
    2,
  ) + "\n",
);

// The proposer's prompt. Short, because the contract lives in the Genome: the
// instructions component is what a harness is, and a prompt that duplicated it
// would be a second, divergent copy of the same rules.
const taskDir = join(runRoot, "agent");
await mkdir(taskDir, { recursive: true });
const PROMPT = [
  "Review the recorded evidence in `/proposal-input/` and decide whether the",
  "harness that produced it should change.",
  "",
  "Write your decision to `/output/proposal.json`, starting from the scaffold at",
  "`/output/proposal-scaffold.json`. Read `/proposal-input/parent/genome/` to see",
  "the harness you are reviewing. The instructions you were given say what a",
  "proposal may contain and what a skill must state. Then stop.",
  "",
].join("\n");
await writeFile(join(taskDir, "TASK.md"), PROMPT);

const launch = buildProposerContainer(
  {
    runRoot: join(HOST_RUNS_DIR, RUN_ID),
    rsihDir: join(HOST_ROOT, "third_party", "RSI-Harness"),
    agentStateDir: join(HOST_RUNS_DIR, "agent-state", RUN_ID),
    genomeDir: join(HOST_ROOT, "genomes", "evocfd-proposer"),
    uid: 1001,
    gid: 1001,
    extraHosts: ["host.docker.internal:host-gateway"],
  },
  IMAGE,
);

const plan = buildLaunchPlan(
  { root: "/rsih", source: "default", revision: null, piVersion: null },
  { home: "/agent-state", path: "/opt/node/bin:/usr/bin:/bin", agentDir: "/agent-state" },
  {
    genome: "/genome/genome.json",
    cwd: "/output",
    runId: RUN_ID,
    profile: "evocfd-intern-ai",
    model: "Atria-Dawn-Preview",
    maxTurns: 20,
    sessionDir: "/agent-state/sessions",
    noContextFiles: true,
    // The prompt is positional: Pi treats a bare token as the initial prompt,
    // and without one the proposer would open a session and exit.
    extraArgs: [PROMPT],
  },
);

const envArgs = Object.entries(plan.env).flatMap(([name, value]) => ["-e", `${name}=${value}`]);
// The agent configuration is already inside the mounted agent-state directory
// (seeded on the host before the container starts), so nothing else from the
// repository's config tree needs to be visible to the proposer.
const argv = [
  "docker",
  "run",
  ...envArgs,
  ...launch.args,
  plan.command,
  ...plan.args,
];

const proposerLaunch = {
  run_id: RUN_ID,
  parent_genome_id: PARENT_ID,
  trials: TRIAL_IDS,
  image: IMAGE,
  evidence_digest: pkg.digest,
  parent_harness_identity: harnessIdentity(parentSnapshot),
  // The proposer runs under its own Genome, which is outside the lineage it
  // reviews: an instrument cannot be part of what it measures.
  proposer_genome_dir: PROPOSER_GENOME_DIR,
  harness: {
    ...parentSnapshot,
    rsih_root: "/rsih",
    note: "the harness the proposer reviews, not the harness it runs under",
  },
  command: "docker",
  args: argv.slice(1),
  cwd: HOST_ROOT,
  env: plan.env,
};
await writeFile(
  join(runRoot, "private", "proposer-launch.json"),
  JSON.stringify(proposerLaunch, null, 2) + "\n",
);

console.log(`assembled evidence for ${RUN_ID} (digest ${pkg.digest.slice(0, 16)})`);
console.log(`  trials    ${TRIAL_IDS.join(", ")}`);
console.log(`  parent    ${PARENT_ID} (${harnessIdentity(parentSnapshot).slice(0, 16)})`);
console.log(`wrote ${runRoot}/private/proposer-launch.json`);
console.log("");
console.log("Run the proposer where Docker lives:");
console.log(`  node scripts/execute-proposer.ts ${RUN_ID}`);
console.log(`  node scripts/build-candidate.ts ${RUN_ID} --parent ${PARENT_ID}`);
