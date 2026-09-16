/**
 * Compare two judged trials: a parent arm and a candidate arm.
 *
 * This is the thinnest version of the comparison the loop eventually needs, and
 * it is deliberately unable to support the interesting question. It reads two
 * recorded verdicts and reports whether they differ, and in which criteria. It
 * does not say which harness is better: with one trial per arm there is no power
 * to say that, and the script says so at the end so a green comparison is never
 * misread as a promotion.
 *
 * Each arm must be attributable — the trial manifest must record which Genome
 * ran it, or the genome ids must be given — because a comparison that cannot
 * name its arms describes nothing.
 *
 * Usage:
 *   node scripts/compare.ts <parent-trial-id> <candidate-trial-id>
 *
 * Optionally followed by two genome ids, when the trials predate the manifest
 * field that records them:
 *   node scripts/compare.ts m1-trial-001 m1-trial-002 evocfd:m1-baseline evocfd:m1-control-misdirect
 */

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadMaterializedTrial } from "../packages/controller/src/snapshot.ts";
import { compareTrials, type TrialArm } from "../packages/controller/src/compare.ts";
import type { EvaluationResult } from "../packages/controller/src/evaluate.ts";
import { buildHarnessSnapshot, defaultResolveGenomeDir, harnessIdentity } from "../packages/controller/src/harness.ts";
import { resolveInstallation } from "../packages/rsih-adapter/src/index.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNS_DIR = join(REPO_ROOT, "runs");

const PARENT_TRIAL = process.argv[2];
const CANDIDATE_TRIAL = process.argv[3];
const ARG_GENOMES = process.argv.slice(4);

if (!PARENT_TRIAL || !CANDIDATE_TRIAL) {
  console.error("usage: node scripts/compare.ts <parent-trial-id> <candidate-trial-id> [parent-genome candidate-genome]");
  process.exit(2);
}

const installation = resolveInstallation({
  rsihRoot: process.env.RSIH_ROOT,
  defaultRoot: join(REPO_ROOT, "third_party", "RSI-Harness"),
});

async function readVerdict(trialId: string, fixtureId: string): Promise<EvaluationResult> {
  const trial = await loadMaterializedTrial(RUNS_DIR, trialId);
  if (trial.fixtureId !== fixtureId) {
    // compareTrials would report this as incomparable, but failing here names
    // the mistake before the comparison pretends to have two arms.
    throw new Error(
      `trial ${trialId} ran fixture ${trial.fixtureId}, not ${fixtureId}; ` +
        "a comparison is over one task",
    );
  }
  const raw = await readFile(join(trial.layout.privateDir, "result.json"), "utf8");
  return { ...(JSON.parse(raw) as EvaluationResult), trial_id: trialId };
}

async function armFor(trialId: string, genomeId: string | undefined): Promise<TrialArm> {
  const trial = await loadMaterializedTrial(RUNS_DIR, trialId);
  const genome = genomeId ?? trial.genomeId ?? undefined;
  if (genome === undefined) {
    throw new Error(
      `trial ${trialId} records no Genome id in its manifest and none was given; ` +
        "a comparison that cannot name an arm cannot be attributed — pass two genome ids",
    );
  }
  // The arm is content-addressed, so the identity is recomputed from the bundle
  // rather than trusted from the manifest: a manifest that disagreed with its
  // own Genome would silently mislabel the comparison.
  const genomeDir = defaultResolveGenomeDir(genome, join(REPO_ROOT, "genomes"));
  const snapshot = await buildHarnessSnapshot({
    genomeDir,
    agentConfigDir: join(REPO_ROOT, "config", "agent-seed"),
    rsihRevision: installation.revision,
    piVersion: installation.piVersion,
  });
  return {
    genome_id: genome,
    harness_identity: harnessIdentity(snapshot),
    result: await readVerdict(trialId, trial.fixtureId),
  };
}

const parent = await armFor(PARENT_TRIAL, ARG_GENOMES[0]);
const candidate = await armFor(CANDIDATE_TRIAL, ARG_GENOMES[1]);

const comparison = compareTrials({ parent, candidate });

console.log("");
console.log(`parent     ${parent.genome_id} (${parent.harness_identity.slice(0, 16)})`);
console.log(`           trial ${parent.result.trial_id} — ${parent.result.pass ? "PASS" : "FAIL"}`);
console.log(`candidate  ${candidate.genome_id} (${candidate.harness_identity.slice(0, 16)})`);
console.log(`           trial ${candidate.result.trial_id} — ${candidate.result.pass ? "PASS" : "FAIL"}`);
console.log(`comparison ${comparison.kind}`);
if (comparison.reason) {
  console.log(`reason     ${comparison.reason}`);
}
if (comparison.deltas.length > 0) {
  for (const delta of comparison.deltas) {
    const direction = !delta.parent_pass && delta.candidate_pass ? "gained" : "lost";
    console.log(`  ${direction}  ${delta.criterion} — ${delta.detail}`);
  }
} else if (comparison.kind === "same") {
  console.log("  no criterion moved between the two arms");
}
console.log("");
console.log(
  "This describes two trials. It is not evidence that either harness is better —",
  "one trial per arm has no power to say that. Replicates and a promotion rule",
  "are PR 7B, and they are deliberately not here.",
);
