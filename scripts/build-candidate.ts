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
import { writeReport } from "../packages/controller/src/report.ts";

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
    // The default validator joins `rsihDir/src/cli.ts`; omitting it made the
    // production path throw where every test path injected a stub.
    rsihDir: installation.root,
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

// The machine-readable twin of the prose above. `no_change`, `duplicate` and
// `rejected` are outcomes rather than errors, and a ledger that reads this file
// needs them as first-class statuses — not as the absence of a candidate. A run
// that produced nothing is a *proposal* report; a run that produced a bundle is
// a *candidate* report, and the two are what a comparison step distinguishes.
const produced = outcome.kind === "built" || outcome.kind === "duplicate";
await writeReport({
  runRoot: join(RUNS_DIR, RUN_ID),
  report: {
    run_id: RUN_ID,
    run_kind: produced ? "candidate" : "proposal",
    status:
      outcome.kind === "built"
        ? "built"
        : outcome.kind === "duplicate"
          ? "duplicate"
          : outcome.kind === "no_change"
            ? "no_change"
            : "rejected",
    reason: outcome.kind === "rejected" ? outcome.reason : undefined,
    subject: PARENT_ID,
    parent_harness_identity: produced ? outcome.record.parent_harness_identity : undefined,
    candidate_genome_id: produced ? outcome.record.candidate_genome_id : undefined,
    candidate_harness_identity: produced ? outcome.record.candidate_harness_identity : undefined,
    proposer_harness_identity: produced ? outcome.record.proposer_harness_identity : undefined,
    artifacts: produced
      ? // The candidate itself lives in the genomes tree, outside the run
        // root, so it is pointed at by id rather than by a relative path
        // that would have to escape this directory to reach it.
        ["private/output/proposal.json", `genome:${outcome.record.candidate_genome_id}`]
      : ["private/output/proposal.json"],
  },
});
