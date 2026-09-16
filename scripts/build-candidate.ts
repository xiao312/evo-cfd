#!/usr/bin/env node
/**
 * Construct a candidate harness from a recorded proposal.
 *
 * This is the deterministic half of PR 6, and it runs where the Genome tree is
 * writable rather than where Docker lives: constructing a candidate touches the
 * repository's `genomes/` directory and reads the pinned RSI-Harness checkout,
 * but it launches no container. The proposer wrote prose; this is what turns
 * that prose into a bundle, validates it, and refuses it if it cannot run.
 *
 * The script reports which of the four outcomes happened, because `no_change`
 * and `duplicate` are results and not errors: a run that concluded the harness
 * needs no change has produced the correct artifact, and so has a run that
 * found the candidate already built.
 *
 * Usage: node scripts/build-candidate.ts <run-id> --parent <genome-id>
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildCandidate } from "../packages/controller/src/candidate-builder.ts";
import { resolveInstallation } from "../packages/rsih-adapter/src/index.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNS_DIR = join(REPO_ROOT, "runs");

const RUN_ID = process.argv[2];
const PARENT_ID = argValue("--parent") ?? "evocfd:m1-baseline";

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 || index + 1 >= process.argv.length ? undefined : process.argv[index + 1];
}

if (typeof RUN_ID !== "string" || RUN_ID.length === 0) {
  console.error("usage: node scripts/build-candidate.ts <run-id> --parent <genome-id>");
  process.exit(2);
}

const installation = resolveInstallation({
  rsihRoot: process.env.RSIH_ROOT,
  defaultRoot: join(REPO_ROOT, "third_party", "RSI-Harness"),
});

const outcome = await buildCandidate({
  context: {
    repoRoot: REPO_ROOT,
    genomesRoot: join(REPO_ROOT, "genomes"),
    agentConfigDir: join(REPO_ROOT, "config", "agent-seed"),
    rsihRevision: installation.revision,
    piVersion: installation.piVersion,
  },
  runRoot: join(RUNS_DIR, RUN_ID),
  parentGenomeId: PARENT_ID,
  proposerEpisodeId: RUN_ID,
});

console.log(`proposal run  ${RUN_ID}`);
switch (outcome.kind) {
  case "no_change":
    console.log("outcome       no_change");
    console.log(`rationale     ${outcome.proposal.rationale.slice(0, 200)}`);
    console.log(`evidence      ${outcome.proposal.evidence_refs.length} refs`);
    console.log("candidate     none");
    break;
  case "duplicate":
    console.log("outcome       duplicate");
    console.log(`candidate     ${outcome.record.candidate_genome_id}`);
    console.log(`identity      ${outcome.record.candidate_harness_identity.slice(0, 16)}`);
    console.log(`status        ${outcome.record.status}`);
    console.log(`at            ${outcome.genomeDir}`);
    break;
  case "built":
    console.log("outcome       built");
    console.log(`candidate     ${outcome.record.candidate_genome_id}`);
    console.log(`parent        ${outcome.record.parent_genome_id}`);
    console.log(`identity      ${outcome.record.candidate_harness_identity.slice(0, 16)}`);
    console.log(`parent id     ${outcome.record.parent_harness_identity.slice(0, 16)}`);
    console.log(`skill         ${outcome.record.change.skill} (${outcome.record.change.kind})`);
    console.log(`changed       ${outcome.changedFiles.join(", ")}`);
    console.log(`status        ${outcome.record.status}`);
    console.log(`at            ${outcome.genomeDir}`);
    break;
  case "rejected":
    console.log("outcome       rejected");
    console.log(`reason        ${outcome.reason}`);
    if (outcome.proposal) console.log(`decision      ${outcome.proposal.decision}`);
    break;
}
