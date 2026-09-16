#!/usr/bin/env node
/**
 * The propose → build integration test.
 *
 * Purpose: prove that the *real* evaluator output can pass through evidence
 * assembly and the production candidate CLI, and that a labelled test proposal
 * builds a candidate through the pinned RSI-Harness validator.
 *
 * ```text
 * materializeFixture          ← a real fixture, reset
 *      → fake agent           ← deterministic, no model call
 *      → evaluateTrial()      ← the real producer, writes result.json
 *      → assembleEvidencePackage()
 *      → labelled proposal    ← origin = integration test, NOT an LLM proposal
 *      → buildCandidate()     ← production CLI path, real rsihDir + validator
 * ```
 *
 * Nothing here hand-authors an approximation of the evaluator's JSON. The
 * result.json this test grounds a proposal on is the one `evaluateTrial()`
 * wrote, read back through the same parser the builder uses. That is the point:
 * an earlier version of this chain had the two sides tested against different
 * contracts, and both were green.
 *
 * This is a plumbing test. The candidate it builds is `proposed` and is
 * deleted at the end. It is not evidence of improvement, and the proposal is
 * not an observed LLM deficiency — a deterministic script supplied it.
 *
 * Usage: node scripts/integration-candidate.ts
 * Requires the pinned RSI-Harness checkout (third_party/RSI-Harness).
 */
import { rm } from "node:fs/promises";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadFixture } from "../packages/controller/src/fixtures.ts";
import { materializeFixture, loadMaterializedTrial } from "../packages/controller/src/snapshot.ts";
import { runEpisode } from "../packages/controller/src/episode.ts";
import type { LaunchPlan } from "../packages/rsih-adapter/src/index.ts";
import { evaluateTrial } from "../packages/controller/src/evaluate.ts";
import { assembleEvidencePackage, PROPOSER_OUTPUT_DIR } from "../packages/controller/src/evidence.ts";
import {
  buildCandidate,
  type CandidateConstruction,
} from "../packages/controller/src/candidate-builder.ts";
import { buildHarnessSnapshot, defaultResolveGenomeDir } from "../packages/controller/src/harness.ts";
import { resolveInstallation } from "../packages/rsih-adapter/src/index.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNS_DIR = join(REPO_ROOT, "runs");
const GENOMES_DIR = join(REPO_ROOT, "genomes");
const FIXTURE_ROOT = join(REPO_ROOT, "fixtures");

const TRIAL_ID = "integration-candidate-001";
const PROPOSAL_RUN = "integration-proposal-001";
const PARENT_ID = "evocfd:m1-baseline";
const SKILL = "integration-test-skill";

const installation = resolveInstallation({
  rsihRoot: process.env.RSIH_ROOT,
  defaultRoot: join(REPO_ROOT, "third_party", "RSI-Harness"),
});

function check(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`FAIL  ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok    ${message}`);
  }
}

async function main(): Promise<void> {
  await rm(join(RUNS_DIR, TRIAL_ID), { recursive: true, force: true });
  await rm(join(RUNS_DIR, PROPOSAL_RUN), { recursive: true, force: true });

  // 1. A real fixture, freshly materialized.
  const fixture = await loadFixture(join(FIXTURE_ROOT, "control-plane-001"));
  const trial = await materializeFixture({
    fixture,
    trialId: TRIAL_ID,
    runsDir: RUNS_DIR,
    environment: { credential_ref: "gateway-token:default", genome_id: PARENT_ID },
  });
  console.log(`materialized ${TRIAL_ID} (${trial.trialIdentity.slice(0, 16)})`);

  // 2. The deterministic stand-in agent, run through the *real* episode
  // machinery so the record `evaluateTrial` requires is written by the same
  // producer that writes it in production — not hand-authored here. It needs no
  // model call and no container: it does the task's intended solution.
  const episode = await runEpisode({
    id: TRIAL_ID,
    evidenceDir: join(trial.layout.privateDir, "episodes"),
    timeoutMs: 60_000,
    plan: {
      command: process.execPath,
      args: [join(REPO_ROOT, "scripts", "fake-agent.mjs"), trial.layout.agentWorkspace],
      cwd: trial.layout.agentWorkspace,
      env: { ...process.env },
    } as LaunchPlan,
  });
  check(episode.exitCode === 0, `the episode exited 0 (got ${episode.exitCode})`);
  console.log(`fake agent completed through runEpisode (${episode.events.length} events)`);

  // 3. The real evaluator. This is the producer whose output the builder must
  // be able to consume — nothing is hand-written here.
  const result = await evaluateTrial(trial);
  check(result.pass === true, `evaluateTrial judged the trial pass=${result.pass}`);
  check(
    result.error === undefined,
    `the evaluation obtained a verdict with no evaluator error${result.error ? `: ${result.error}` : ""}`,
  );
  check(result.criteria.length > 0, `the evaluation reports ${result.criteria.length} criteria`);

  // 4. The evidence package a real proposer would receive.
  const parentDir = await defaultResolveGenomeDir(GENOMES_DIR, PARENT_ID);
  if (parentDir === null) {
    console.error(`FAIL  parent Genome ${PARENT_ID} not found`);
    process.exitCode = 1;
    return;
  }
  const parentSnapshot = await buildHarnessSnapshot({
    genomeDir: parentDir,
    agentConfigDir: join(REPO_ROOT, "config", "agent-seed"),
    rsihRevision: installation.revision,
    piVersion: installation.piVersion,
  });
  const runRoot = join(RUNS_DIR, PROPOSAL_RUN);
  const pkg = await assembleEvidencePackage({
    runRoot,
    runsDir: RUNS_DIR,
    trialIds: [TRIAL_ID],
    parentGenomeDir: parentDir,
    parentGenomeId: PARENT_ID,
    parentSnapshot,
  });
  check(pkg.digest.length === 64, `the evidence package has a digest (${pkg.digest.slice(0, 16)})`);

  // 5. A labelled test proposal. Its origin is recorded in the rationale so no
  // reader can mistake it for an LLM's judgement of the harness.
  const proposal = {
    schema_version: 1,
    decision: "propose",
    kind: "skill_upsert",
    skill: SKILL,
    rationale:
      "[INTEGRATION TEST] deterministic plumbing check, not an LLM proposal and not an observed deficiency: " +
      "verify that real evaluator output grounds a candidate through the production builder.",
    hypothesis: "[INTEGRATION TEST] the construction path is exercised end to end.",
    expected_effect: "[INTEGRATION TEST] none claimed; this candidate is never activated.",
    risks: [],
    evidence_refs: [
      `evidence/${TRIAL_ID}/evaluation/result.json`,
      `evidence/${TRIAL_ID}/episode/events.jsonl`,
    ],
    skill_content:
      "---\n" +
      `name: ${SKILL}\n` +
      "description: [INTEGRATION TEST] placeholder skill that exists to prove the construction path.\n" +
      "---\n" +
      `# ${SKILL}\n` +
      "\n" +
      "This skill exists only because an integration test needed a real file on a real\n" +
      "allowlist. It states no procedure and should never be activated.\n",
  };
  const outputDir = join(runRoot, PROPOSER_OUTPUT_DIR);
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, "proposal.json"), JSON.stringify(proposal, null, 2) + "\n");

  // 6. The production builder path: the same context build-candidate.ts builds,
  // including the real `rsihDir` the default validator needs.
  const outcome: CandidateConstruction = await buildCandidate({
    context: {
      repoRoot: REPO_ROOT,
      genomesRoot: GENOMES_DIR,
      agentConfigDir: join(REPO_ROOT, "config", "agent-seed"),
      rsihDir: installation.root,
      rsihRevision: installation.revision,
      piVersion: installation.piVersion,
    },
    runRoot,
    parentGenomeId: PARENT_ID,
    proposerEpisodeId: PROPOSAL_RUN,
  });

  check(outcome.kind === "built", `the candidate was built (outcome: ${outcome.kind})`);
  if (outcome.kind === "built") {
    check(
      outcome.record.status === "proposed",
      `the candidate is proposed, not activated (${outcome.record.status})`,
    );
    check(
      outcome.record.parent_harness_identity !== outcome.record.candidate_harness_identity,
      "the candidate's identity differs from its parent's",
    );
    check(
      outcome.record.change.skill === SKILL,
      `the changed skill is ${outcome.record.change.skill}`,
    );
    check(
      outcome.changedFiles.every((file) => file.startsWith("skills/") || file.endsWith("genome.json")),
      `changed files are bounded: ${outcome.changedFiles.join(", ")}`,
    );
    console.log(`candidate ${outcome.record.candidate_genome_id}`);
    console.log(`identity ${outcome.record.candidate_harness_identity.slice(0, 16)}`);
    // The candidate is removed: this test claims nothing and leaves nothing.
    await rm(outcome.genomeDir, { recursive: true, force: true });
  } else if ("reason" in outcome) {
    console.error(`reason  ${outcome.reason}`);
  }

  // The parent must be exactly as it was.
  const parentAfter = await buildHarnessSnapshot({
    genomeDir: parentDir,
    agentConfigDir: join(REPO_ROOT, "config", "agent-seed"),
    rsihRevision: installation.revision,
    piVersion: installation.piVersion,
  });
  check(
    JSON.stringify(parentAfter) === JSON.stringify(parentSnapshot),
    "the parent Genome is byte-identical to what it was before construction",
  );

  await rm(join(RUNS_DIR, TRIAL_ID), { recursive: true, force: true });
  await rm(join(RUNS_DIR, PROPOSAL_RUN), { recursive: true, force: true });
  // Staging must be gone whatever path the build took.
  await rm(join(GENOMES_DIR, ".staging"), { recursive: true, force: true });
}

await main().catch((error) => {
  console.error(`FAIL  unexpected: ${(error as Error).message}`);
  process.exitCode = 1;
});
if (process.exitCode === 0) console.log("\nintegration chain: real evaluator output → evidence → candidate");
else console.error("\nintegration chain failed");
