#!/usr/bin/env node
/**
 * Execute a prepared proposal run's recorded launch plan, and keep the evidence.
 *
 * This is `execute-trial.ts` for a proposer, and deliberately so: a proposer is
 * an agent episode like any other, recorded through the same `runEpisode()`
 * path with the same raw event stream, stderr and result. There is no second,
 * bespoke LLM invocation path, because a second path would be a second place
 * for an unrecorded decision to hide.
 *
 * The proposer's credential reaches its config directory the same way a trial
 * agent's does: from the environment, at execution time, never written into the
 * recorded plan.
 *
 * Run this where Docker lives.
 *
 * Usage: node scripts/execute-proposer.ts <run-id>
 */
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runEpisode } from "../packages/controller/src/episode.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNS_DIR = join(REPO_ROOT, "runs");

const RUN_ID = process.argv[2];
if (typeof RUN_ID !== "string" || RUN_ID.length === 0) {
  console.error("usage: node scripts/execute-proposer.ts <run-id>");
  process.exit(2);
}

const launchPath = join(RUNS_DIR, RUN_ID, "private", "proposer-launch.json");
const launch = JSON.parse(await readFile(launchPath, "utf8")) as {
  run_id: string;
  parent_genome_id: string;
  evidence_digest: string;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
};

const stateDir = join(RUNS_DIR, "agent-state", RUN_ID);
await mkdir(stateDir, { recursive: true });

{
  const seedDir = join(REPO_ROOT, "config", "agent-seed");
  const token = process.env.EVOCFD_GATEWAY_TOKEN;
  if (!token) {
    console.error(
      "EVOCFD_GATEWAY_TOKEN is not set; the proposer cannot authenticate to the LLM gateway",
    );
    process.exit(2);
  }
  // Same trap as a trial: RSIH's vendored Pi reads RSIH_CODING_AGENT_DIR, which
  // RSIH defaults to $HOME/.rsih, so the seed lands there or every provider is
  // invisible.
  const configDir = join(stateDir, ".rsih");
  await mkdir(configDir, { recursive: true });
  await cp(join(seedDir, "settings.json"), join(configDir, "settings.json"));
  const models = JSON.parse(await readFile(join(seedDir, "models.json"), "utf8")) as Record<
    string,
    unknown
  >;
  const provider = models.providers["evocfd-intern-ai"] as Record<string, unknown>;
  provider.apiKey = token;
  await writeFile(join(configDir, "models.json"), JSON.stringify(models, null, 2) + "\n");
  await writeFile(
    join(configDir, "auth.json"),
    JSON.stringify({ "evocfd-intern-ai": { type: "api_key", key: token } }, null, 2) + "\n",
  );
  console.log(`seeded ${configDir} with the proposer config and gateway credential`);
}

const evidenceDir = join(RUNS_DIR, RUN_ID, "private", "episodes");
await mkdir(evidenceDir, { recursive: true });

console.log(`running proposer ${RUN_ID}: ${launch.command} ${launch.args.join(" ")}`);

const result = await runEpisode({
  id: RUN_ID,
  plan: { command: launch.command, args: launch.args, cwd: REPO_ROOT, env: launch.env },
  evidenceDir,
  // A proposer that ran forever would be a proposer burning credentials, so
  // the budget is enforced here rather than trusted to the proposer.
  timeoutMs: 10 * 60 * 1000,
});

console.log("");
console.log(`episode    ${result.id}`);
console.log(`exit       ${result.exitCode ?? "none"}${result.signal ? ` (${result.signal})` : ""}`);
console.log(`timed out  ${result.timedOut}`);
console.log(`events     ${result.events.length} (${result.malformed.length} malformed)`);
console.log(`evidence   ${result.evidencePath}`);

if (result.exitCode !== 0) {
  console.error("the proposer episode did not exit cleanly; no proposal will be constructed");
  process.exitCode = 1;
}
