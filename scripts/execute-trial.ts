#!/usr/bin/env node
/**
 * Execute a prepared trial's recorded launch plan and keep the evidence.
 *
 * This is the only place an agent is started, and it starts nothing it did not
 * read: the plan comes from `private/agent-launch.json`, written by
 * `run-trial.ts` before anything ran. The plan is executed through
 * `runEpisode()`, so every episode leaves the same auditable trail — raw
 * events.jsonl, stderr, and a result — rather than being a Docker command run
 * for its exit status.
 *
 * The agent's credential is the one thing not written down in advance. The
 * gateway token reaches the agent's config directory at execution time from the
 * environment, and never enters the repository or the recorded plan.
 *
 * Run this where Docker lives. Requires the trial's `private/agent-launch.json`.
 *
 * Usage: node scripts/execute-trial.ts <trial-id>
 */
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runEpisode } from "../packages/controller/src/episode.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOST_ROOT = process.env.EVOCFD_HOST_ROOT ?? REPO_ROOT;
const RUNS_DIR = join(REPO_ROOT, "runs");
const HOST_RUNS_DIR = join(HOST_ROOT, "runs");

const TRIAL_ID = process.argv[2];
if (typeof TRIAL_ID !== "string" || TRIAL_ID.length === 0) {
  console.error("usage: node scripts/execute-trial.ts <trial-id>");
  process.exit(2);
}

const launchPath = join(RUNS_DIR, TRIAL_ID, "private", "agent-launch.json");
const launch = JSON.parse(await readFile(launchPath, "utf8")) as {
  trial_id: string;
  fixture_id: string;
  seed_config_dir: string | null;
  max_wall_seconds: number;
  max_agent_turns: number;
  network_profile: string;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
};

const stateDir = join(RUNS_DIR, "agent-state", TRIAL_ID);
await mkdir(stateDir, { recursive: true });

// The agent's config directory is seeded from the repository (provider
// endpoints, model list — the network profile, which is not a secret) plus the
// one credential, which arrives from the environment and is written where the
// agent reads it. Nothing here is recorded into the episode plan.
if (launch.seed_config_dir) {
  const seedDir = join(REPO_ROOT, "config", "agent-seed");
  const token = process.env.EVOCFD_GATEWAY_TOKEN;
  if (!token) {
    console.error(
      "EVOCFD_GATEWAY_TOKEN is not set; the agent cannot authenticate to the LLM gateway",
    );
    process.exit(2);
  }
  // RSIH's vendored Pi resolves its agent directory from RSIH_CODING_AGENT_DIR,
  // which RSIH's own CLI defaults to $HOME/.rsih. Seeding one level too shallow
  // makes every provider invisible and the agent dies with Unknown provider
  // before its first turn, so the seed lands where Pi actually looks.
  const configDir = join(stateDir, ".rsih");
  await mkdir(configDir, { recursive: true });
  await cp(join(seedDir, "settings.json"), join(configDir, "settings.json"));
  // Pi resolves a provider's key from its models entry, so the credential is
  // merged into the seeded provider definition here. The repository copy carries
  // no key at all; the runtime file is written from the environment and is never
  // part of the recorded launch plan.
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
  console.log(`seeded ${configDir} with the agent config and gateway credential`);
}

const evidenceDir = join(RUNS_DIR, TRIAL_ID, "private", "episodes");
await mkdir(evidenceDir, { recursive: true });

console.log(`running ${TRIAL_ID}: ${launch.command} ${launch.args.join(" ")}`);

const result = await runEpisode({
  id: TRIAL_ID,
  plan: { command: launch.command, args: launch.args, cwd: REPO_ROOT, env: launch.env },
  evidenceDir,
  // The fixture's wall-clock bound, enforced here by killing the process group
  // rather than by trusting the agent to watch the clock.
  timeoutMs: launch.max_wall_seconds * 1000,
});

console.log("");
console.log(`episode    ${result.id}`);
console.log(`exit       ${result.exitCode ?? "none"}${result.signal ? ` (${result.signal})` : ""}`);
console.log(`timed out  ${result.timedOut}`);
console.log(`events     ${result.events.length} (${result.malformed.length} malformed)`);
console.log(`evidence   ${result.evidencePath}`);
process.exitCode = result.exitCode === 0 ? 0 : 1;
