import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { EVIDENCE_DIR, PROPOSER_OUTPUT_DIR } from "../src/evidence.ts";
import {
  buildCandidate,
  candidateContentDigest,
  readProposal,
  type CandidateBuildContext,
} from "../src/candidate-builder.ts";
import {
  buildHarnessSnapshot,
  candidateLineage,
  harnessIdentity,
  readCandidate,
  recordCandidate,
} from "../src/harness.ts";
import { digestFileMap } from "../src/snapshot.ts";
import { validateProposal, type HarnessProposal } from "../src/proposal.ts";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const BASELINE = join(REPO_ROOT, "genomes", "m1-baseline");
const RSIH_DIR = join(REPO_ROOT, "third_party", "RSI-Harness");
const AGENT_CONFIG_DIR = join(REPO_ROOT, "config", "agent-seed");

const RSIH_PRESENT = existsSync(RSIH_DIR);

/**
 * A stand-in for `rsih genome validate` that checks what the real one checks
 * for these bundles: the manifest declares the id the record will claim, the
 * components it names all exist, and every skill it registers ships a file.
 * It validates the *shape*, which is what the construction logic can be
 * trusted on without the runtime; whether the runtime accepts a bundle is a
 * different question and is answered by CI-rsih.
 */
async function stubValidateBundle(input: {
  rsihDir: string;
  genomeDir: string;
  genomeId: string;
}): Promise<void> {
  const genomeDir = input.genomeDir;
  const genomeId = input.genomeId;
  const manifest = JSON.parse(await readFile(join(genomeDir, "genome.json"), "utf8")) as {
    genome_id: string;
    components: Array<{ id: string; source?: string; contract?: string }>;
  };
  assert.equal(manifest.genome_id, genomeId, "the manifest must declare the id the builder named");
  for (const component of manifest.components) {
    if (component.source) {
      const source = await readFile(join(genomeDir, component.source), "utf8").catch(() => null);
      assert.ok(source !== null, `component ${component.id} names a missing source ${component.source}`);
      if (component.id === "skills") {
        const config = JSON.parse(source) as { config: { skills: Array<{ source: string }> } };
        for (const skill of config.config.skills) {
          const skillFile = await readFile(join(genomeDir, skill.source, "SKILL.md"), "utf8").catch(() => null);
          assert.ok(skillFile !== null, `the registered skill ${skill.source} ships no SKILL.md`);
        }
      }
    }
    if (component.contract) {
      const contract = await readFile(join(genomeDir, component.contract), "utf8").catch(() => null);
      assert.ok(contract !== null, `component ${component.id} names a missing contract ${component.contract}`);
    }
  }
}

const SKILL = "verify-before-claim";
const SKILL_FILE = `skills/${SKILL}/SKILL.md`;
const PARENT_ID = "evocfd:m1-baseline";
let parentIdentityCached: string | undefined;
/** The seed's harness identity, computed once: the digest the builder hashes against. */
async function parentIdentity(): Promise<string> {
  if (parentIdentityCached === undefined) {
    parentIdentityCached = harnessIdentity(
      await buildHarnessSnapshot({
        genomeDir: BASELINE,
        agentConfigDir: AGENT_CONFIG_DIR,
        rsihRevision: "33c4f8d",
        piVersion: "0.84.3",
      }),
    );
  }
  return parentIdentityCached;
}
const SKILL_CONTENT =
  "---\n" +
  `name: ${SKILL}\n` +
  "description: Run the program before reporting that it is fixed.\n" +
  "---\n" +
  "# Verify before claim\n" +
  "\n" +
  "Run it. Read the output. Then report the outcome.\n";

/** A scratch genomes tree with one baseline parent, plus its run directory. */
/**
 * A small evidence package with a recorded, judged trial: exactly what a
 * proposal is expected to cite. The builder grounds references against this,
 * so the fixture has to ship one rather than let every test invent paths.
 */
/**
 * The candidate id the builder must produce for a given skill content: parent,
 * skill, and the content digest the builder computes. The digest function is
 * imported rather than hard-coded, so a test that varies the content still
 * expects the id the builder will actually name — and two different contents
 * get two different ids.
 */
function expectedId(content = SKILL_CONTENT, kind: "skill_upsert" | "skill_modify" = "skill_upsert"): string {
  if (parentIdentityCached === undefined) {
    throw new Error("expectedId called before parentIdentity() was awaited");
  }
  return `${PARENT_ID}--${SKILL}--${candidateContentDigest(parentIdentityCached, {
    kind,
    skill: SKILL,
    skill_content: content,
  })}`;
}

function expectedDirName(content = SKILL_CONTENT): string {
  return expectedId(content).replaceAll(":", "-");
}

async function writeJudgedEvidence(runRoot: string, trialId = "m1-trial-001"): Promise<void> {
  const base = join(runRoot, "private", "proposal-input", "evidence", trialId);
  await mkdir(join(base, "episode"), { recursive: true });
  await mkdir(join(base, "task"), { recursive: true });
  await mkdir(join(base, "evaluation"), { recursive: true });
  await writeFile(join(base, "episode", "events.jsonl"), '{"type":"session"}\n');
  await writeFile(join(base, "episode", "result.json"), JSON.stringify({ exit_code: 0 }) + "\n");
  await writeFile(join(base, "task", "TASK.md"), "# Do the thing\n");
  // Written in the shape `evaluateTrial` actually produces — `pass` and
  // `criteria`, never a `verdict` string — so the fixture cannot drift from the
  // producer's contract the way the hand-authored `{verdict: "pass"}` did.
  await writeEvaluation(join(base, "evaluation", "result.json"), { pass: true });
  await writeFile(join(base, "trial-manifest.json"), JSON.stringify({ trial_id: trialId }) + "\n");
  await mkdir(join(runRoot, "private", "proposal-input", "parent", "genome"), { recursive: true });
  // The real package ships the whole parent Genome subtree here; the fixture
  // mirrors that so a reference to `parent/` resolves as it would for a real
  // proposer.
  await cp(BASELINE, join(runRoot, "private", "proposal-input", "parent", "genome"), { recursive: true });
  await writeFile(
    join(runRoot, "private", "proposal-input", "parent", "harness-snapshot.json"),
    JSON.stringify({ genome_id: "evocfd:m1-baseline" }) + "\n",
  );
}

/** A scratch genomes tree with one baseline parent, plus its run directory. */
/**
 * Write an evaluation result in the exact shape `evaluateTrial` produces.
 *
 * This is the producer's contract, not an approximation of it: `pass` and
   * `criteria`, with `error` present only when no trustworthy verdict was
   * obtained. An earlier version of this helper wrote `{verdict: "pass"}`, which
   * matched what the consumer happened to expect and bore no relation to what
   * the producer writes — so both sides were tested against the same wrong
   * thing.
   */
async function writeEvaluation(
  path: string,
  options: { pass?: boolean; error?: string } = {},
): Promise<void> {
  const pass = options.pass ?? true;
  await writeFile(
    path,
    JSON.stringify(
      {
        trial_id: "m1-trial-001",
        fixture_id: "control-plane-001",
        pass,
        criteria: pass
          ? [{ criterion: "report", pass: true, detail: "REPORT.md is not empty" }]
          : [{ criterion: "report", pass: false, detail: "REPORT.md is empty" }],
        error: options.error,
        exit_code: pass ? 0 : 1,
        budget_seconds: 60,
        elapsed_seconds: 1,
        evaluator_digest: "e".repeat(64),
        workspace_digest: "w".repeat(64),
        episode_id: "episode",
        episode_exit_code: 0,
        episode_timed_out: false,
        trial_identity: "t".repeat(64),
      },
      null,
      2,
    ) + "\n",
  );
}

async function fixture(skill = SKILL): Promise<{
  root: string;
  genomesRoot: string;
  runRoot: string;
  context: CandidateBuildContext;
  parentDigest: Map<string, string>;
}> {
  const root = await mkdtemp(join(tmpdir(), "evocfd-cand-"));
  // The expected ids below hash against the parent's real identity, so warm
  // it from the seed bundle before any test asks for one.
  await parentIdentity();
  const genomesRoot = join(root, "genomes");
  const runRoot = join(root, "runs", "proposal-001");
  await mkdir(join(genomesRoot, "m1-baseline"), { recursive: true });
  await cp(BASELINE, join(genomesRoot, "m1-baseline"), { recursive: true });
  await mkdir(join(runRoot, PROPOSER_OUTPUT_DIR), { recursive: true });
  // The proposal's evidence references must resolve inside the package the
  // proposer was given, so the fixture ships a small judged one.
  await writeJudgedEvidence(runRoot);
  const context: CandidateBuildContext = {
    repoRoot: REPO_ROOT,
    genomesRoot,
    agentConfigDir: AGENT_CONFIG_DIR,
    rsihDir: RSIH_DIR,
    rsihRevision: "33c4f8d",
    piVersion: "0.84.3",
    // The unit suite validates bundle shape itself; the real runtime is
    // exercised by the RSIH integration suite and by the one test below that
    // skips when the checkout is absent.
    validateBundle: stubValidateBundle,
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
  // The references must resolve, so every run root that gets a proposal also
  // gets the judged evidence package those references point into.
  await writeJudgedEvidence(runRoot);
  await mkdir(join(runRoot, PROPOSER_OUTPUT_DIR), { recursive: true });
  await writeFile(join(runRoot, PROPOSER_OUTPUT_DIR, "proposal.json"), JSON.stringify(proposal, null, 2) + "\n");
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
    join(f.runRoot, PROPOSER_OUTPUT_DIR, "proposal.json"),
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

  assert.equal(outcome.record.candidate_genome_id, expectedId());
  assert.equal(outcome.record.parent_genome_id, "evocfd:m1-baseline");
  assert.equal(outcome.record.change.kind, "skill_upsert");
  assert.equal(outcome.record.change.skill, SKILL);
  assert.equal(outcome.record.status, "proposed");
  assert.ok(outcome.record.created_at);

  // The published directory uses the id with `:` flattened, so it is a legal
  // path component on every filesystem.
  assert.equal(outcome.genomeDir, join(f.genomesRoot, expectedDirName()));
  const manifest = JSON.parse(await readFile(join(outcome.genomeDir, "genome.json"), "utf8"));
  assert.equal(manifest.genome_id, expectedId());
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

test("candidate: the candidate validates under the pinned RSI-Harness", async (t) => {
  // The external checkout is gitignored and cloned only where EvoCFD actually
  // runs. This is the one assertion that needs it, so it belongs to the RSIH
  // integration tier rather than to CI-fast, and it says so rather than
  // silently degrading into a shape check.
  if (!RSIH_PRESENT) {
    t.skip(`no RSI-Harness checkout at ${RSIH_DIR}; run CI-rsih for this assertion`);
    return;
  }
  const f = await fixture();
  await writeProposal(f.runRoot);
  // Override the stub with the real runtime for this one bundle.
  const outcome = await buildCandidate({
    context: { ...f.context, validateBundle: undefined },
    runRoot: f.runRoot,
    parentGenomeId: "evocfd:m1-baseline",
    proposerEpisodeId: "proposal-001",
    stagingRoot: join(f.root, "staging"),
  });
  assert.equal(outcome.kind, "built");
  if (outcome.kind !== "built") throw new Error("unreachable");

  // Reaching this point means `rsih genome validate` accepted the bundle.
  // Re-run it explicitly so the assertion is not only inferred from the
  // absence of a rejection.
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
    join(f.runRoot, PROPOSER_OUTPUT_DIR, "proposal.json"),
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
    parentGenomeId: expectedId(),
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
    parentGenomeId: expectedId(),
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
    genomeId: expectedId(),
    agentConfigDir: AGENT_CONFIG_DIR,
    rsihRevision: "33c4f8d",
    piVersion: "0.84.3",
  });

  assert.equal(lineage.length, 2);
  assert.equal(lineage[0].genome_id, "evocfd:m1-baseline");
  assert.equal(lineage[1].genome_id, expectedId());
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
  await mkdir(join(f.runRoot, PROPOSER_OUTPUT_DIR), { recursive: true });
  await writeFile(join(f.runRoot, PROPOSER_OUTPUT_DIR, "proposal.json"), "{not json");
  await assert.rejects(() => readProposal(f.runRoot), /not valid JSON/);
  await rm(f.root, { recursive: true, force: true });
});

test("candidate: a proposal written outside the output directory is not found", async () => {
  const f = await fixture();
  // The proposer's only writable path is private/output. A proposal that turns
  // up under private/ instead was not written by the proposer this run gave a
  // writable path to, so it is not this run's proposal.
  await mkdir(join(f.runRoot, "private"), { recursive: true });
  await writeFile(join(f.runRoot, "private", "proposal.json"), "{}\n");
  const outcome = await buildWith(f);
  assert.equal(outcome.kind, "rejected");
  if (outcome.kind !== "rejected") throw new Error("unreachable");
  assert.match(outcome.reason, /no proposal at/);
  await rm(f.root, { recursive: true, force: true });
});

test("candidate: the same skill with different content is a second candidate, not a duplicate", async () => {
  const f = await fixture();
  await writeProposal(f.runRoot);

  // The first proposal's content.
  const first = await buildWith(f);
  assert.equal(first.kind, "built");
  if (first.kind !== "built") throw new Error("unreachable");

  // A second proposal for the *same skill* with different content. Same parent,
  // same skill name, different bytes: a different harness, which has to be able
  // to exist alongside the first. Under the old naming this was reported as a
  // duplicate and the second content was silently unreachable.
  const secondRun = join(f.root, "runs", "proposal-004");
  const otherContent =
    "---\n" +
    `name: ${SKILL}\n` +
    "description: Run the program and quote the exact line before reporting.\n" +
    "---\n" +
    "# Verify before claim\n" +
    "\n" +
    "Run it, paste the line that matters, then report.\n";
  await writeProposal(secondRun, { skill_content: otherContent });
  const second = await buildCandidate({
    context: f.context,
    runRoot: secondRun,
    parentGenomeId: "evocfd:m1-baseline",
    proposerEpisodeId: "proposal-004",
    stagingRoot: join(f.root, "staging"),
  });

  assert.equal(second.kind, "built");
  if (second.kind !== "built") throw new Error("unreachable");
  assert.notEqual(second.record.candidate_harness_identity, first.record.candidate_harness_identity);
  assert.notEqual(second.genomeDir, first.genomeDir);
  assert.notEqual(expectedDirName(otherContent), expectedDirName());
  assert.equal(second.genomeDir, join(f.genomesRoot, expectedDirName(otherContent)));

  // Both candidates exist simultaneously and each carries its own identity.
  const both = await readdir(f.genomesRoot);
  assert.ok(both.includes(expectedDirName()));
  assert.ok(both.includes(expectedDirName(otherContent)));

  // A re-run of the *first* proposal is still a duplicate of the first, so an
  // unchanged proposal never produces a second directory.
  const rerun = await buildWith(f);
  assert.equal(rerun.kind, "duplicate");
  if (rerun.kind !== "duplicate") throw new Error("unreachable");
  assert.equal(rerun.genomeDir, first.genomeDir);

  await rm(f.root, { recursive: true, force: true });
});

test("candidate: skill_upsert is refused for a skill the parent already registers", async () => {
  const f = await fixture();
  await writeProposal(f.runRoot);
  const first = await buildWith(f);
  if (first.kind !== "built") throw new Error("unreachable");

  // The candidate now carries the skill, so a further *upsert* of the same
  // skill against it is a modify wearing an upsert's label. The two have
  // different provenance: upsert means the harness gained a capability it never
  // had.
  const parentOfSecond = join(f.genomesRoot, "with-skills");
  await cp(first.genomeDir, parentOfSecond, { recursive: true });
  await rm(join(parentOfSecond, "candidate.json"), { force: true });
  await rm(first.genomeDir, { recursive: true, force: true });

  const secondRun = join(f.root, "runs", "proposal-005");
  await writeProposal(secondRun, { kind: "skill_upsert" });
  const outcome = await buildCandidate({
    context: f.context,
    runRoot: secondRun,
    parentGenomeId: first.record.candidate_genome_id,
    proposerEpisodeId: "proposal-005",
    stagingRoot: join(f.root, "staging"),
  });
  assert.equal(outcome.kind, "rejected");
  if (outcome.kind !== "rejected") throw new Error("unreachable");
  assert.match(outcome.reason, /already registers that skill; use skill_modify/);
  await rm(f.root, { recursive: true, force: true });
});

test("candidate: a proposal that cites no trial evidence is refused", async () => {
  const f = await fixture();
  await writeProposal(f.runRoot, {
    evidence_refs: ["parent/genome/genome.json"],
  });
  const outcome = await buildWith(f);
  assert.equal(outcome.kind, "rejected");
  if (outcome.kind !== "rejected") throw new Error("unreachable");
  assert.match(outcome.reason, /at least one trial artifact under evidence\//);
  await rm(f.root, { recursive: true, force: true });
});

test("candidate: an evidence reference that does not resolve is refused", async () => {
  const f = await fixture();
  await writeProposal(f.runRoot, {
    evidence_refs: ["evidence/m1-trial-001/episode/events.jsonl", "evidence/nowhere/evaluation/result.json"],
  });
  const outcome = await buildWith(f);
  assert.equal(outcome.kind, "rejected");
  if (outcome.kind !== "rejected") throw new Error("unreachable");
  assert.match(outcome.reason, /does not resolve/);
  await rm(f.root, { recursive: true, force: true });
});

test("candidate: an absolute evidence reference is refused", async () => {
  const f = await fixture();
  await writeProposal(f.runRoot, { evidence_refs: ["/etc/passwd"] });
  const outcome = await buildWith(f);
  assert.equal(outcome.kind, "rejected");
  if (outcome.kind !== "rejected") throw new Error("unreachable");
  assert.match(outcome.reason, /is absolute/);
  await rm(f.root, { recursive: true, force: true });
});

test("candidate: a reference that escapes the evidence package is refused", async () => {
  const f = await fixture();
  await writeProposal(f.runRoot, { evidence_refs: ["../../../../etc/passwd"] });
  const outcome = await buildWith(f);
  assert.equal(outcome.kind, "rejected");
  if (outcome.kind !== "rejected") throw new Error("unreachable");
  assert.match(outcome.reason, /escapes the evidence package/);
  await rm(f.root, { recursive: true, force: true });
});

test("candidate: a proposal resting on an unjudged trial is refused", async () => {
  const f = await fixture();
  await writeProposal(f.runRoot);
  // Replace the evaluation with the shape written when a trial reached no
  // verdict: `error` set, no trustworthy judgement — *after* the fixture is
  // written so it is not overwritten. "I have not looked yet" is not
  // "no change needed".
  await writeEvaluation(join(f.runRoot, EVIDENCE_DIR, "evidence", "m1-trial-001", "evaluation", "result.json"), {
    pass: false,
    error: "the evaluator could not obtain a verdict",
  });
  const outcome = await buildWith(f);
  assert.equal(outcome.kind, "rejected");
  if (outcome.kind !== "rejected") throw new Error("unreachable");
  assert.match(outcome.reason, /no trustworthy judgement/);
  await rm(f.root, { recursive: true, force: true });
});

/**
 * A task that failed is judged evidence. This is the case the earlier `verdict`
 * parser got backwards in the worst way: a failing trial is exactly what a
 * repair proposal is for, and it must not be refused as "unjudged".
 */
test("candidate: a proposal resting on a failed trial is accepted as judged", async () => {
  const f = await fixture();
  await writeProposal(f.runRoot);
  await writeEvaluation(join(f.runRoot, EVIDENCE_DIR, "evidence", "m1-trial-001", "evaluation", "result.json"), {
    pass: false,
  });
  const outcome = await buildWith(f);
  assert.equal(outcome.kind, "built");
  if (outcome.kind !== "built") throw new Error("unreachable");
  assert.equal(outcome.record.status, "proposed");
  await rm(f.root, { recursive: true, force: true });
});
