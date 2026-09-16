import { test } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { buildCandidate, readProposal, type CandidateBuildContext } from "../src/candidate-builder.ts";
import { buildHarnessSnapshot, candidateLineage, readCandidate, recordCandidate } from "../src/harness.ts";
import { digestFileMap } from "../src/snapshot.ts";
import { validateProposal, type HarnessProposal } from "../src/proposal.ts";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const BASELINE = join(REPO_ROOT, "genomes", "m1-baseline");
const RSIH_DIR = join(REPO_ROOT, "third_party", "RSI-Harness");
const AGENT_CONFIG_DIR = join(REPO_ROOT, "config", "agent-seed");

const SKILL = "verify-before-claim";
const SKILL_FILE = `skills/${SKILL}/SKILL.md`;
const SKILL_CONTENT =
  "---\n" +
  `name: ${SKILL}\n` +
  "description: Run the program before reporting that it is fixed.\n" +
  "---\n" +
  "# Verify before claim\n" +
  "\n" +
  "Run it. Read the output. Then report the outcome.\n";

/** A scratch genomes tree with one baseline parent, plus its run directory. */
async function fixture(skill = SKILL): Promise<{
  root: string;
  genomesRoot: string;
  runRoot: string;
  context: CandidateBuildContext;
  parentDigest: Map<string, string>;
}> {
  const root = await mkdtemp(join(tmpdir(), "evocfd-cand-"));
  const genomesRoot = join(root, "genomes");
  const runRoot = join(root, "runs", "proposal-001");
  await mkdir(join(genomesRoot, "m1-baseline"), { recursive: true });
  await cp(BASELINE, join(genomesRoot, "m1-baseline"), { recursive: true });
  await mkdir(join(runRoot, "private"), { recursive: true });
  const context: CandidateBuildContext = {
    repoRoot: REPO_ROOT,
    genomesRoot,
    agentConfigDir: AGENT_CONFIG_DIR,
    rsihDir: RSIH_DIR,
    rsihRevision: "33c4f8d",
    piVersion: "0.84.3",
  };
  return {
    root,
    genomesRoot,
    runRoot,
    context,
    parentDigest: await digestFileMap(join(genomesRoot, "m1-baseline"), ["candidate.json"]),
  };
}

async function writeProposal(runRoot: string, overrides: Record<string, unknown> = {}): Promise<void> {
  const proposal: Record<string, unknown> = {
    schema_version: 1,
    decision: "propose",
    kind: "skill_upsert",
    skill: SKILL,
    rationale: "The agent reported a fix without running the program.",
    hypothesis: "The harness teaches no verification step before a claim.",
    expected_effect: "The agent runs the program before reporting success.",
    risks: ["The skill may fire when running is not possible."],
    evidence_refs: ["evidence/m1-trial-001/episode/events.jsonl"],
    skill_content: SKILL_CONTENT,
    ...overrides,
  };
  validateProposal(proposal as HarnessProposal);
  await writeFile(join(runRoot, "private", "proposal.json"), JSON.stringify(proposal, null, 2) + "\n");
}

async function buildWith(fixture: Awaited<ReturnType<typeof fixture>>) {
  return buildCandidate({
    context: fixture.context,
    runRoot: fixture.runRoot,
    parentGenomeId: "evocfd:m1-baseline",
    proposerEpisodeId: "proposal-001",
    stagingRoot: join(fixture.root, "staging"),
  });
}

test("candidate: a no_change proposal builds nothing", async () => {
  const f = await fixture();
  await writeProposal(f.runRoot, { decision: "no_change", rationale: "Nothing to change.", skill: undefined });
  // A no_change carries no skill fields at all; write it directly.
  await writeFile(
    join(f.runRoot, "private", "proposal.json"),
    JSON.stringify(
      { schema_version: 1, decision: "no_change", rationale: "Nothing to change.", evidence_refs: [] },
      null,
      2,
    ) + "\n",
  );

  const outcome = await buildWith(f);
  assert.equal(outcome.kind, "no_change");

  // No candidate directory was created for a decision that creates nothing:
  // the parent is the only thing in the tree.
  const entries = await readdir(f.genomesRoot);
  assert.deepEqual(entries, ["m1-baseline"]);
  await rm(f.root, { recursive: true, force: true });
});

test("candidate: a skill_upsert builds, publishes and records", async () => {
  const f = await fixture();
  await writeProposal(f.runRoot);
  const outcome = await buildWith(f);

  assert.equal(outcome.kind, "built");
  if (outcome.kind !== "built") throw new Error("unreachable");

  assert.equal(outcome.record.candidate_genome_id, `evocfd:m1-baseline--${SKILL}`);
  assert.equal(outcome.record.parent_genome_id, "evocfd:m1-baseline");
  assert.equal(outcome.record.change.kind, "skill_upsert");
  assert.equal(outcome.record.change.skill, SKILL);
  assert.equal(outcome.record.status, "proposed");
  assert.ok(outcome.record.created_at);

  // The published directory uses the id with `:` flattened, so it is a legal
  // path component on every filesystem.
  assert.equal(outcome.genomeDir, join(f.genomesRoot, "evocfd-m1-baseline--verify-before-claim"));
  const manifest = JSON.parse(await readFile(join(outcome.genomeDir, "genome.json"), "utf8"));
  assert.equal(manifest.genome_id, "evocfd:m1-baseline--verify-before-claim");
  assert.equal(manifest.parent_id, "evocfd:m1-baseline");
  assert.equal(manifest.version, 2);
  assert.deepEqual(
    manifest.components.map((c: { id: string }) => c.id),
    ["instructions", "skills"],
  );

  // The skill file is where the manifest says it is, with the content proposed.
  const skill = await readFile(join(outcome.genomeDir, SKILL_FILE), "utf8");
  assert.ok(skill.includes("Verify before claim"));

  await rm(f.root, { recursive: true, force: true });
});

test("candidate: the changed-file set is exactly the allowlist", async () => {
  const f = await fixture();
  await writeProposal(f.runRoot);
  const outcome = await buildWith(f);
  assert.equal(outcome.kind, "built");
  if (outcome.kind !== "built") throw new Error("unreachable");

  assert.deepEqual(outcome.changedFiles.sort(), [
    "components/skills.json",
    "contracts/skills.dev.md",
    "genome.json",
    SKILL_FILE,
  ]);

  // Nothing else in the bundle moved: the instructions component and its
  // contract are byte-identical to the parent's.
  const parentInstructions = await readFile(join(f.genomesRoot, "m1-baseline", "components", "instructions.json"), "utf8");
  const candidateInstructions = await readFile(join(outcome.genomeDir, "components", "instructions.json"), "utf8");
  assert.equal(parentInstructions, candidateInstructions);
  await rm(f.root, { recursive: true, force: true });
});

test("candidate: the candidate validates under the pinned RSI-Harness", async () => {
  const f = await fixture();
  await writeProposal(f.runRoot);
  const outcome = await buildWith(f);
  assert.equal(outcome.kind, "built");
  if (outcome.kind !== "built") throw new Error("unreachable");

  // buildCandidate uses the real validator by default; reaching this point means
  // `rsih genome validate` accepted the bundle. Re-run it explicitly so the
  // assertion is not only inferred from the absence of a rejection.
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", join(RSIH_DIR, "src", "cli.ts"), "genome", "validate", outcome.genomeDir],
    { encoding: "utf8", windowsHide: true },
  );
  assert.equal(result.status, 0, `validation failed: ${result.stderr}`);
  assert.match(result.stdout, /2 components/);
  await rm(f.root, { recursive: true, force: true });
});

test("candidate: candidate.json is excluded from its own bundle's digest", async () => {
  const f = await fixture();
  await writeProposal(f.runRoot);
  const outcome = await buildWith(f);
  if (outcome.kind !== "built") throw new Error("unreachable");

  // The record exists, names its own identity, and that identity was computable
  // — which is only possible if the file was excluded from the hash.
  const record = await readCandidate(outcome.genomeDir);
  assert.equal(record.candidate_genome_id, outcome.record.candidate_genome_id);
  assert.equal(record.candidate_harness_identity, outcome.record.candidate_harness_identity);
  await rm(f.root, { recursive: true, force: true });
});

test("candidate: an identical rebuild is a duplicate, not a second directory", async () => {
  const f = await fixture();
  await writeProposal(f.runRoot);

  const first = await buildWith(f);
  assert.equal(first.kind, "built");
  const second = await buildWith(f);
  assert.equal(second.kind, "duplicate");
  if (second.kind !== "duplicate") throw new Error("unreachable");

  assert.equal(second.genomeDir, first.genomeDir);
  assert.equal(second.record.candidate_harness_identity, first.record.candidate_harness_identity);
  await rm(f.root, { recursive: true, force: true });
});

test("candidate: construction leaves the parent Genome untouched", async () => {
  const f = await fixture();
  await writeProposal(f.runRoot);
  await buildWith(f);

  const after = await digestFileMap(join(f.genomesRoot, "m1-baseline"), ["candidate.json"]);
  assert.deepEqual([...after.entries()], [...f.parentDigest.entries()]);
  await rm(f.root, { recursive: true, force: true });
});

test("candidate: rejects a proposal whose parent is absent", async () => {
  const f = await fixture();
  await writeProposal(f.runRoot);
  const outcome = await buildCandidate({
    context: f.context,
    runRoot: f.runRoot,
    parentGenomeId: "evocfd:nonexistent",
    proposerEpisodeId: "proposal-001",
  });
  assert.equal(outcome.kind, "rejected");
  if (outcome.kind !== "rejected") throw new Error("unreachable");
  assert.match(outcome.reason, /not present/);
  await rm(f.root, { recursive: true, force: true });
});

test("candidate: rejects a malformed proposal rather than building from it", async () => {
  const f = await fixture();
  await writeFile(
    join(f.runRoot, "private", "proposal.json"),
    JSON.stringify({ schema_version: 1, decision: "propose", kind: "skill_upsert", skill: "Bad Name" }) + "\n",
  );
  const outcome = await buildWith(f);
  assert.equal(outcome.kind, "rejected");
  if (outcome.kind !== "rejected") throw new Error("unreachable");
  assert.match(outcome.reason, /not constructible/);
  await rm(f.root, { recursive: true, force: true });
});

test("candidate: a missing proposal is reported as a rejection", async () => {
  const f = await fixture();
  const outcome = await buildWith(f);
  assert.equal(outcome.kind, "rejected");
  if (outcome.kind !== "rejected") throw new Error("unreachable");
  assert.match(outcome.reason, /no proposal at/);
  await rm(f.root, { recursive: true, force: true });
});

test("candidate: skill_modify is refused when the parent registers no skills", async () => {
  const f = await fixture();
  await writeProposal(f.runRoot, { kind: "skill_modify" });
  const outcome = await buildWith(f);
  assert.equal(outcome.kind, "rejected");
  if (outcome.kind !== "rejected") throw new Error("unreachable");
  assert.match(outcome.reason, /no skills component/);
  await rm(f.root, { recursive: true, force: true });
});

test("candidate: skill_modify rewrites only the skill file", async () => {
  const f = await fixture();
  // First build a candidate that carries the skill, then move it into place as
  // a parent for a modify — the realistic chain, and the one a lineage walks.
  await writeProposal(f.runRoot);
  const first = await buildWith(f);
  if (first.kind !== "built") throw new Error("unreachable");

  const parentOfModify = join(f.genomesRoot, "with-skills");
  await cp(first.genomeDir, parentOfModify, { recursive: true });
  await rm(join(parentOfModify, "candidate.json"), { force: true });
  await rm(first.genomeDir, { recursive: true, force: true });

  const modifyRun = join(f.root, "runs", "proposal-002");
  await mkdir(join(modifyRun, "private"), { recursive: true });
  // A modify that ships different content, or it would be a no-op wearing a
  // change's label.
  await writeProposal(modifyRun, {
    kind: "skill_modify",
    skill_content:
      "---\n" +
      `name: ${SKILL}\n` +
      "description: Run the program and quote its output before reporting.\n" +
      "---\n" +
      "# Verify before claim\n" +
      "\n" +
      "Run it, quote the line that matters, then report.\n",
  });
  const outcome = await buildCandidate({
    context: f.context,
    runRoot: modifyRun,
    parentGenomeId: "evocfd:m1-baseline--verify-before-claim",
    proposerEpisodeId: "proposal-002",
    stagingRoot: join(f.root, "staging"),
  });

  assert.equal(outcome.kind, "built");
  if (outcome.kind !== "built") throw new Error("unreachable");
  assert.deepEqual(outcome.changedFiles.sort(), ["genome.json", SKILL_FILE]);
  const skill = await readFile(join(outcome.genomeDir, SKILL_FILE), "utf8");
  assert.ok(skill.includes("quote the line that matters"));
  // The components manifest was not touched by a modify.
  const comps = JSON.parse(await readFile(join(outcome.genomeDir, "components", "skills.json"), "utf8"));
  assert.equal(comps.config.skills.length, 1);
  await rm(f.root, { recursive: true, force: true });
});

test("candidate: skill_modify of an unregistered skill is refused", async () => {
  const f = await fixture();
  await writeProposal(f.runRoot);
  const first = await buildWith(f);
  if (first.kind !== "built") throw new Error("unreachable");

  const parentOfModify = join(f.genomesRoot, "with-skills");
  await cp(first.genomeDir, parentOfModify, { recursive: true });
  await rm(join(parentOfModify, "candidate.json"), { force: true });
  await rm(first.genomeDir, { recursive: true, force: true });

  const modifyRun = join(f.root, "runs", "proposal-003");
  await mkdir(join(modifyRun, "private"), { recursive: true });
  await writeProposal(modifyRun, { kind: "skill_modify", skill: "not-registered" });
  const outcome = await buildCandidate({
    context: f.context,
    runRoot: modifyRun,
    parentGenomeId: "evocfd:m1-baseline--verify-before-claim",
    proposerEpisodeId: "proposal-003",
  });
  assert.equal(outcome.kind, "rejected");
  if (outcome.kind !== "rejected") throw new Error("unreachable");
  assert.match(outcome.reason, /does not register that skill/);
  await rm(f.root, { recursive: true, force: true });
});

test("candidate: a constructed candidate has a walkable two-link lineage", async () => {
  const f = await fixture();
  await writeProposal(f.runRoot);
  const outcome = await buildWith(f);
  if (outcome.kind !== "built") throw new Error("unreachable");

  const lineage = await candidateLineage({
    genomesRoot: f.genomesRoot,
    genomeId: "evocfd:m1-baseline--verify-before-claim",
    agentConfigDir: AGENT_CONFIG_DIR,
    rsihRevision: "33c4f8d",
    piVersion: "0.84.3",
  });

  assert.equal(lineage.length, 2);
  assert.equal(lineage[0].genome_id, "evocfd:m1-baseline");
  assert.equal(lineage[1].genome_id, "evocfd:m1-baseline--verify-before-claim");
  // The change is attached to the link that produced the next one.
  assert.equal(lineage[0].change?.skill, SKILL);
  assert.equal(lineage[1].change, undefined);
  // And the identities the chain reports are recomputed, not claimed.
  assert.equal(lineage[1].harness_identity, outcome.record.candidate_harness_identity);
  assert.equal(lineage[0].harness_identity, outcome.record.parent_harness_identity);
  await rm(f.root, { recursive: true, force: true });
});

test("candidate: staging is cleaned up whether the build succeeded or failed", async () => {
  const f = await fixture();
  await writeProposal(f.runRoot, { skill: "never-built" });
  await buildWith(f);
  const staging = await readdir(join(f.root, "staging"));
  assert.equal(staging.length, 0, "a successful build must not leave staging behind");
  await rm(f.root, { recursive: true, force: true });
});

test("candidate: a bundle whose genome_id disagrees with the record is refused", async () => {
  const f = await fixture();
  await writeProposal(f.runRoot);
  const outcome = await buildWith(f);
  if (outcome.kind !== "built") throw new Error("unreachable");

  // recordCandidate is the chokepoint: it recomputes from the bundle, so a
  // record claiming another bundle's id cannot be written.
  const otherDir = join(f.genomesRoot, "imposter");
  await cp(outcome.genomeDir, otherDir, { recursive: true });
  await rm(join(otherDir, "candidate.json"), { force: true });
  const imposter = await buildHarnessSnapshot({
    genomeDir: otherDir,
    agentConfigDir: AGENT_CONFIG_DIR,
    rsihRevision: "33c4f8d",
    piVersion: "0.84.3",
  });
  await assert.rejects(
    () =>
      recordCandidate({
        genomeDir: otherDir,
        candidateSnapshot: imposter,
        record: {
          candidate_genome_id: "evocfd:someone-else",
          parent_genome_id: "evocfd:m1-baseline",
          parent_harness_identity: outcome.record.parent_harness_identity,
          change: outcome.record.change,
          status: "proposed",
          proposer_episode: "proposal-001",
        },
      }),
    /claims genome id/,
  );
  await rm(f.root, { recursive: true, force: true });
});

test("candidate: a candidate record may only be created as proposed", async () => {
  const f = await fixture();
  await writeProposal(f.runRoot);
  const outcome = await buildWith(f);
  if (outcome.kind !== "built") throw new Error("unreachable");

  // The only legitimate way to a second status is a state transition that
  // carries trial evidence this builder does not have. The check runs before any
  // record is written, so it is exercised against a bundle that has no record
  // yet.
  const fresh = join(f.genomesRoot, "fresh");
  await cp(outcome.genomeDir, fresh, { recursive: true });
  await rm(join(fresh, "candidate.json"), { force: true });
  const snapshot = await buildHarnessSnapshot({
    genomeDir: fresh,
    agentConfigDir: AGENT_CONFIG_DIR,
    rsihRevision: "33c4f8d",
    piVersion: "0.84.3",
  });
  await assert.rejects(
    () =>
      recordCandidate({
        genomeDir: fresh,
        candidateSnapshot: snapshot,
        record: { ...outcome.record, status: "activated" },
      }),
    /only be created as proposed/,
  );
  await rm(f.root, { recursive: true, force: true });
});

test("candidate: readProposal reports a file that is not JSON", async () => {
  const f = await fixture();
  await mkdir(join(f.runRoot, "private"), { recursive: true });
  await writeFile(join(f.runRoot, "private", "proposal.json"), "{not json");
  await assert.rejects(() => readProposal(f.runRoot), /not valid JSON/);
  await rm(f.root, { recursive: true, force: true });
});
