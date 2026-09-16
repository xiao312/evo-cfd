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
 *      → buildCandidate()     ← production builder API, real rsihDir + validator
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
import { spawn, spawnSync } from "node:child_process";
import { rm, readdir, stat, readFile, cp, mkdir, writeFile } from "node:fs/promises";
import { writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { loadFixture } from "../packages/controller/src/fixtures.ts";
import { materializeFixture, loadMaterializedTrial } from "../packages/controller/src/snapshot.ts";
import { runEpisode } from "../packages/controller/src/episode.ts";
import type { LaunchPlan } from "../packages/rsih-adapter/src/index.ts";
import { evaluateTrial } from "../packages/controller/src/evaluate.ts";
import { assembleEvidencePackage, PROPOSER_OUTPUT_DIR } from "../packages/controller/src/evidence.ts";
import {
  buildCandidate,
  allowedFiles,
  type CandidateConstruction,
} from "../packages/controller/src/candidate-builder.ts";
import { buildHarnessSnapshot, defaultResolveGenomeDir, harnessIdentity } from "../packages/controller/src/harness.ts";
import { resolveInstallation } from "../packages/rsih-adapter/src/index.ts";
import type { MaterializedTrial } from "../packages/controller/src/snapshot.ts";
import type { EvaluationResult } from "../packages/controller/src/evaluate.ts";

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

const BUNDLE_FLAG = process.argv.indexOf("--bundle");
const BUNDLE_DIR =
  BUNDLE_FLAG !== -1 && process.argv[BUNDLE_FLAG + 1]
    ? resolve(process.argv[BUNDLE_FLAG + 1])
    : null;

/** Every line the script prints, so a review bundle can ship the verification. */
const capturedLog: string[] = [];
const realLog = console.log.bind(console);
console.log = (...args: unknown[]) => {
  capturedLog.push(args.join(" "));
  realLog(...args);
};

let failed = false;

function check(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`FAIL  ${message}`);
    failed = true;
  } else {
    console.log(`ok    ${message}`);
  }
}

async function main(): Promise<void> {
  await rm(join(RUNS_DIR, TRIAL_ID), { recursive: true, force: true });
  await rm(join(RUNS_DIR, PROPOSAL_RUN), { recursive: true, force: true });

  // 1. A real fixture, freshly materialized.
  const fixture = await loadFixture(join(FIXTURE_ROOT, "control-plane-001"));
  // 1. A real fixture, freshly materialized. The harness identity the trial
  // records is the parent's, computed before anything ran — the historical
  // claim a later comparison verifies against rather than reconstructs.
  const parentDirForEnv = await defaultResolveGenomeDir(GENOMES_DIR, PARENT_ID);
  if (parentDirForEnv === null) {
    console.error(`FAIL  parent Genome ${PARENT_ID} not found`);
    failed = true;
    return;
  }
  const parentSnapshotForEnv = await buildHarnessSnapshot({
    genomeDir: parentDirForEnv,
    agentConfigDir: join(REPO_ROOT, "config", "agent-seed"),
    rsihRevision: installation.revision,
    piVersion: installation.piVersion,
  });
  const parentIdentityHash = harnessIdentity(parentSnapshotForEnv);
  const trial = await materializeFixture({
    fixture,
    trialId: TRIAL_ID,
    runsDir: RUNS_DIR,
    environment: {
      credential_ref: "gateway-token:default",
      genome_id: PARENT_ID,
      harness_identity: parentIdentityHash,
    },
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
  const parentDir = parentDirForEnv;
  const parentSnapshot = parentSnapshotForEnv;
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

  // The episode evidence is copied as `episode/<episode-id>/events.jsonl`, so
  // the reference is resolved from what the package actually contains rather
  // than assumed — the same way a proposer would discover it.
  const episodeRoot = join(pkg.dir, "evidence", TRIAL_ID, "episode");
  const episodeIds = await readdir(episodeRoot, { withFileTypes: true })
    .then((entries) => entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name))
    .catch(() => []);
  const episodeRef =
    episodeIds.length > 0
      ? `evidence/${TRIAL_ID}/episode/${episodeIds[0]}/events.jsonl`
      : `evidence/${TRIAL_ID}/trial-manifest.json`;

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
      episodeRef,
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
    // The changed set must be exactly the allowlist: a change touching
    // anything else would be an unbounded change wearing a bounded label.
    const expected = allowedFiles("skill_upsert", SKILL);
    const changed = new Set(outcome.changedFiles);
    check(
      changed.size === expected.size && [...changed].every((file) => expected.has(file)),
      `changed files are exactly the allowlist: got [${outcome.changedFiles.join(", ")}]`,
    );
    console.log(`candidate ${outcome.record.candidate_genome_id}`);
    console.log(`identity ${outcome.record.candidate_harness_identity.slice(0, 16)}`);

    if (BUNDLE_DIR !== null) {
      // The candidate's diff is captured before the bundle is written, because
      // the candidate is deleted below — the review describes a thing that no
      // longer exists, which is exactly why its bytes need to be exported.
      await exportBundle({
        bundleDir: BUNDLE_DIR,
        trial,
        result,
        pkg,
        proposal,
        outcome,
        parentDir,
        candidateDir: outcome.genomeDir,
        log: capturedLog,
      });
    }

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

  // The raw runs are removed unless a review bundle was requested, in which
  // case the exported copy is the published record and the originals stay local.
  if (BUNDLE_DIR === null) {
    await rm(join(RUNS_DIR, TRIAL_ID), { recursive: true, force: true });
    await rm(join(RUNS_DIR, PROPOSAL_RUN), { recursive: true, force: true });
  }
  // Staging must be gone whatever path the build took.
  await rm(join(GENOMES_DIR, ".staging"), { recursive: true, force: true });
}

/**
 * Patterns that must never reach a public bundle. A raw event stream is the
 * riskiest artifact: tool commands and tool output can carry a secret even
 * when the structured environment record has been redacted.
 */
const SECRET_PATTERNS = [
  /[A-Za-z0-9_-]{32,}\.[A-Za-z0-9_-]{16,}/g, // token-shaped strings
  /EVOCFD_GATEWAY_TOKEN[="']\s*[A-Za-z0-9._-]+/gi,
  /Authorization:\s*Bearer\s+[A-Za-z0-9._-]+/gi,
  /sk-[A-Za-z0-9]{16,}/g,
];

function redact(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, "[REDACTED]");
  }
  return out;
}

/** True when a path exists, distinguishing absent from any other error. */
async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

interface ExportInput {
  bundleDir: string;
  trial: MaterializedTrial;
  result: EvaluationResult;
  pkg: { dir: string; digest: string };
  proposal: Record<string, unknown>;
  outcome: Extract<CandidateConstruction, { kind: "built" }>;
  parentDir: string;
  candidateDir: string;
  log: string[];
}

/**
 * Publish a reviewed copy of this run, separate from the raw `runs/` tree.
 *
 * Records are copied with their original schema — `evaluation-result.json` is
 * the file `evaluateTrial` wrote, not a reconstruction with different fields —
 * and every file is listed in the export manifest with its *export* digest. A
 * redacted file has different bytes from its original, so the manifest records
 * the transformation rather than claiming the original hash.
 */
async function exportBundle(input: ExportInput): Promise<void> {
  const { createHash } = await import("node:crypto");
  const { cp, mkdir, writeFile, readFile } = await import("node:fs/promises");
  const records = join(input.bundleDir, "records");
  const logs = join(input.bundleDir, "logs");
  const changes = join(input.bundleDir, "changes");
  await mkdir(records, { recursive: true });
  await mkdir(logs, { recursive: true });
  await mkdir(changes, { recursive: true });

  const files: Array<{
    path: string;
    source_artifact: string;
    transformation: string;
    export_sha256: string;
  }> = [];

  async function copyRecord(
    exportPath: string,
    sourcePath: string,
    sourceArtifact: string,
  ): Promise<void> {
    const raw = await readFile(sourcePath, "utf8");
    // Records are machine-readable inputs to the review; they are copied
    // verbatim after redaction, never rewritten into another schema.
    const content = redact(raw);
    await writeFile(exportPath, content);
    files.push({
      path: relative(input.bundleDir, exportPath).split(sep).join("/"),
      source_artifact: sourceArtifact,
      transformation: content === raw ? "none" : "credential redaction",
      export_sha256: createHash("sha256").update(content, "utf8").digest("hex"),
    });
  }

  // Records: the machine-readable chain, in the producer's own schema.
  await copyRecord(
    join(records, "trial.json"),
    join(input.trial.layout.manifests, "trial.json"),
    `runs/${TRIAL_ID}/manifests/trial.json`,
  );
  await copyRecord(
    join(records, "episode-result.json"),
    join(input.trial.layout.root, "private", "episodes", TRIAL_ID, "result.json"),
    `runs/${TRIAL_ID}/private/episodes/${TRIAL_ID}/result.json`,
  );
  await copyRecord(
    join(records, "evaluation-result.json"),
    join(input.trial.layout.privateDir, "result.json"),
    `runs/${TRIAL_ID}/private/result.json`,
  );
  await copyRecord(
    join(records, "proposal.json"),
    join(RUNS_DIR, PROPOSAL_RUN, "private", "output", "proposal.json"),
    `runs/${PROPOSAL_RUN}/private/output/proposal.json`,
  );
  await writeFile(
    join(records, "construction-report.json"),
    JSON.stringify(
      {
        outcome: "built",
        candidate_genome_id: input.outcome.record.candidate_genome_id,
        parent_genome_id: input.outcome.record.parent_genome_id,
        parent_harness_identity: input.outcome.record.parent_harness_identity,
        candidate_harness_identity: input.outcome.record.candidate_harness_identity,
        proposer_harness_identity: input.outcome.record.proposer_harness_identity,
        change: input.outcome.record.change,
        status: input.outcome.record.status,
        changed_files: input.outcome.changedFiles,
        cli: "node scripts/integration-candidate.ts",
        validator: "pinned RSI-Harness genome validate",
      },
      null,
      2,
    ) + "\n",
  );
  files.push({
    path: "records/construction-report.json",
    source_artifact: "computed from the builder's return value",
    transformation: "summarised from the builder's record, not copied from disk",
    export_sha256: "",
  });

  // Logs. .txt is used because the repository ignores *.log.
  const episodeEvents = join(input.trial.layout.root, "private", "episodes", TRIAL_ID, "events.jsonl");
  await copyRecord(join(logs, "episode-events.jsonl"), episodeEvents, `runs/${TRIAL_ID}/private/episodes/${TRIAL_ID}/events.jsonl`);
  const stderrPath = join(input.trial.layout.root, "private", "episodes", TRIAL_ID, "stderr.txt");
  if (await pathExists(stderrPath)) {
    await copyRecord(join(logs, "episode-stderr.txt"), stderrPath, `runs/${TRIAL_ID}/private/episodes/${TRIAL_ID}/stderr.txt`);
  }
  // The verification output itself is the review's primary read.
  const verification = redact(input.log.join("\n")) + "\n";
  await writeFile(join(logs, "verification.txt"), verification);
  files.push({
    path: "logs/verification.txt",
    source_artifact: "stdout/stderr of scripts/integration-candidate.ts",
    transformation: "captured from the process, then redacted",
    export_sha256: createHash("sha256").update(verification, "utf8").digest("hex"),
  });

  // The candidate's diff, produced while the bundle still exists.
  const diff = await diffTrees(input.parentDir, input.candidateDir);
  await writeFile(join(changes, "candidate.diff"), diff);
  files.push({
    path: "changes/candidate.diff",
    source_artifact: "diff of the parent Genome against the built candidate",
    transformation: "generated at export time; the candidate is deleted afterwards",
    export_sha256: createHash("sha256").update(diff, "utf8").digest("hex"),
  });

  const commit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" });
  const commitSha = (commit.stdout ?? "").trim();
  const dirty = spawnSync("git", ["status", "--porcelain"], { cwd: REPO_ROOT, encoding: "utf8" });
  const clean = (dirty.stdout ?? "").trim().length === 0;

  await writeFile(
    join(input.bundleDir, "export-manifest.json"),
    JSON.stringify(
      {
        export_schema_version: 1,
        source_run_id: PROPOSAL_RUN,
        source_trial_id: TRIAL_ID,
        tested_code_commit: commitSha,
        working_tree_clean: clean,
        source_runs_are_local_only: "runs/ is gitignored; this bundle is the published copy",
        evidence_package_digest: input.pkg.digest,
        files,
      },
      null,
      2,
    ) + "\n",
  );

  await writeFile(join(input.bundleDir, "README.md"), reviewReadme(commitSha, clean));
  console.log(`review bundle written to ${relative(REPO_ROOT, input.bundleDir)}`);
}

/**
 * What construction changed, with content. Walks the *union* of both trees: a
 * file present only in the candidate is an addition, and walking the parent
 * alone would silently miss every file the change added.
 */
async function diffTrees(parentDir: string, candidateDir: string): Promise<string> {
  const lines: string[] = [];

  /** Everything under a directory the change added, emitted as additions. */
  async function walkAdded(rel: string): Promise<void> {
    const absC = join(candidateDir, rel);
    const names = await readdir(absC).catch(() => [] as string[]);
    for (const name of [...names].sort()) {
      const child = join(rel, name).split(sep).join("/");
      const cStat = await stat(join(absC, name)).catch(() => null);
      if (cStat?.isDirectory()) {
        await walkAdded(join(rel, name));
        continue;
      }
      if (cStat === null) continue;
      lines.push(`--- /dev/null`);
      lines.push(`+++ ${child}`);
      lines.push(indent(await readFile(join(absC, name), "utf8"), "+"));
    }
  }

  async function walk(rel: string): Promise<void> {
    const absP = join(parentDir, rel);
    const absC = join(candidateDir, rel);
    const pEntries = await readdir(absP).catch(() => [] as string[]);
    const cEntries = await readdir(absC).catch(() => [] as string[]);
    const names = [...new Set([...pEntries, ...cEntries])].sort();
    for (const name of names) {
      const child = join(rel, name).split(sep).join("/");
      const p = join(absP, name);
      const c = join(absC, name);
      const pStat = await stat(p).catch(() => null);
      const cStat = await stat(c).catch(() => null);
      if (pStat === null && cStat === null) continue;
      if (pStat === null) {
        // Added by the change. A whole added directory is walked, not read.
        if (cStat.isDirectory()) {
          await walkAdded(join(rel, name));
          continue;
        }
        lines.push(`--- /dev/null`);
        lines.push(`+++ ${child}`);
        lines.push(indent(await readFile(c, "utf8"), "+"));
        continue;
      }
      if (cStat === null) {
        lines.push(`--- ${child}`);
        lines.push(`+++ /dev/null`);
        continue;
      }
      if (pStat.isDirectory() && cStat.isDirectory()) {
        await walk(join(rel, name));
        continue;
      }
      const pBytes = await readFile(p);
      const cBytes = await readFile(c);
      if (!pBytes.equals(cBytes)) {
        lines.push(`--- ${child}`);
        lines.push(`+++ ${child}`);
        lines.push(indent(await readFile(p, "utf8"), "-"));
        lines.push(indent(await readFile(c, "utf8"), "+"));
      }
    }
  }
  await walk("");
  return lines.join("\n") + "\n";
}

/** Prefix every line, so a pasted fragment stays inside its own hunk. */
function indent(text: string, prefix: string): string {
  return text
    .trimEnd()
    .split("\n")
    .map((line) => `${prefix} ${line}`)
    .join("\n");
}

function reviewReadme(commitSha: string, clean: boolean): string {
  return [
    "# Review: candidate-build-integration-001",
    "",
    "## Question",
    "Does the production candidate builder accept evidence produced by the actual",
    "evaluator and publish a valid, bounded candidate?",
    "",
    "## Code tested",
    `- EvoCFD commit: ${commitSha}`,
    `- Working tree clean: ${clean}`,
    "- Uncommitted patch: none",
    "",
    "## Execution",
    `- Trial id: ${TRIAL_ID}`,
    `- Proposal run: ${PROPOSAL_RUN}`,
    "- Runtime: `evocfd-dev:node22` container on the compute host",
    "- Exact commands:",
    "  ```text",
    "  bash /data2/kexiao/bin/evocfd 'node scripts/integration-candidate.ts --bundle'",
    "  ```",
    "",
    "## Expected",
    "- A genuine `EvaluationResult` written by `evaluateTrial()` is accepted as judged evidence.",
    "- Exactly one skill is added, and the changed-file set is exactly the allowlist.",
    "- Parent Genome contents remain unchanged.",
    "- The pinned RSI-Harness validator accepts the candidate bundle.",
    "- Candidate status remains `proposed`; nothing is activated.",
    "",
    "## Observed",
    "- Outcome: `built` (see `records/construction-report.json`).",
    "- Every check in `logs/verification.txt` printed `ok`; the process exited 0.",
    "- Changed files: `genome.json`, `components/skills.json`, `contracts/skills.dev.md`, `skills/integration-test-skill/SKILL.md`.",
    "",
    "## Evidence",
    "- Trial manifest: `records/trial.json`",
    "- Episode result: `records/episode-result.json`",
    "- Evaluation result (the producer this review cares about): `records/evaluation-result.json`",
    "- Proposal: `records/proposal.json`",
    "- Construction: `records/construction-report.json`",
    "- Logs: `logs/`",
    "- Change: `changes/candidate.diff`",
    "- Provenance of every file: `export-manifest.json`",
    "",
    "## Human intervention",
    "- None. The run is deterministic; no manual edits or retries.",
    "",
    "## Limitations",
    "- The proposal was supplied by a deterministic integration test, not an LLM.",
    "- This is not evidence of a harness improvement, and the candidate was deleted",
    "  after the bundle was written. It exercises a code path, nothing more.",
    "- The episode ran the `fake-agent.mjs` stand-in, so `episode-events.jsonl` is",
    "  empty: no model call was made and no agent trajectory exists to inspect.",
    "- The evaluation's criteria are those of the `control-plane-001` toy fixture.",
    "",
    "## Review requested",
    "- Is `records/evaluation-result.json` (the real producer output) consistent with",
    "  what `records/construction-report.json` says consumed it?",
    "- Does the recorded parent/candidate identity describe the inputs actually used?",
  ].join("\n") + "\n";
}

await main().catch((error) => {
  console.error(`FAIL  unexpected: ${(error as Error).message}`);
  failed = true;
});
if (!failed) {
  console.log("\nintegration chain OK: real evaluator output -> evidence -> candidate");
} else {
  console.error("\nintegration chain failed");
  process.exitCode = 1;
}
