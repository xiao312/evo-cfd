/**
 * Harness identity and candidate representation tests.
 *
 * These test the invariants the comparison machinery will rest on: that a
 * harness is identified by its content rather than its location, that the
 * identity is secret-free, that a candidate cannot claim a parent it does not
 * have, and that ancestry is walkable — or reported as broken rather than
 * silently truncated.
 *
 * Run with: node --experimental-strip-types --test test/*.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CandidateExistsError,
  CandidateMissingError,
  HarnessError,
  LineageBreakError,
  buildHarnessSnapshot,
  candidateLineage,
  defaultResolveGenomeDir,
  harnessIdentity,
  readCandidate,
  recordCandidate,
  type HarnessSnapshot,
} from "../src/harness.ts";
import { digestTree } from "../src/snapshot.ts";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

const SEED_GENOME_ID = "evocfd:m1-baseline";

/**
 * The identity of the proposer Genome as it stands in the repo. Hand-written
 * records in this suite name it, because a candidate record without the
 * instrument that produced it is not auditable and the writer now refuses one.
 */
const PROPOSER_IDENTITY = harnessIdentity(
  await buildHarnessSnapshot({
    genomeDir: join(REPO_ROOT, "genomes", "evocfd-proposer"),
    agentConfigDir: join(REPO_ROOT, "config", "agent-seed"),
    rsihRevision: "33c4f8d",
    piVersion: "0.84.3",
  }),
);

/** A minimal but real bundle: a manifest, a component and its contract. */
async function writeBundle(dir: string, genomeId: string, text = "seed instructions"): Promise<void> {
  await mkdir(join(dir, "components"), { recursive: true });
  await mkdir(join(dir, "contracts"), { recursive: true });
  await writeFile(
    join(dir, "genome.json"),
    JSON.stringify(
      {
        genome_schema_version: "3",
        genome_id: genomeId,
        parent_id: genomeId,
        version: 1,
        base: "default",
        components: [
          { id: "instructions", source: "./components/instructions.json", contract: "./contracts/instructions.dev.md" },
        ],
      },
      null,
      2,
    ) + "\n",
  );
  await writeFile(
    join(dir, "components", "instructions.json"),
    JSON.stringify({ component_schema_version: "1", component_id: "instructions", config: { append_system_prompt: text } }, null, 2) + "\n",
  );
  await writeFile(join(dir, "contracts", "instructions.dev.md"), `# instructions\n\n${text}\n`);
}

/** A secret-free agent configuration, as it lives in the repository. */
async function writeAgentConfig(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "settings.json"),
    JSON.stringify(
      { defaultProvider: "evocfd-intern-ai", defaultModel: "Atria-Dawn-Preview", defaultThinkingLevel: "high" },
      null,
      2,
    ) + "\n",
  );
  await writeFile(
    join(dir, "models.json"),
    JSON.stringify(
      {
        providers: {
          "evocfd-intern-ai": {
            baseUrl: "http://host.docker.internal:18080/v1",
            api: "openai-completions",
            // Deliberately absent: the repository copy carries no credential.
            models: [{ id: "Atria-Dawn-Preview", reasoning: true }],
          },
        },
      },
      null,
      2,
    ) + "\n",
  );
}

/** A candidate bundle: a copy of its parent plus one changed skill. */
async function writeCandidate(
  parentDir: string,
  dir: string,
  genomeId: string,
  skillText: string,
): Promise<void> {
  await cp(parentDir, dir, { recursive: true });
  // The parent's own record describes the parent; copying it into the child
  // would make the child look like a candidate of itself.
  await rm(join(dir, "candidate.json"), { force: true });
  await mkdir(join(dir, "skills", "diagnose-before-fixing"), { recursive: true });
  await writeFile(
    join(dir, "skills", "diagnose-before-fixing", "SKILL.md"),
    `# diagnose-before-fixing\n\n${skillText}\n`,
  );
  await writeFile(
    join(dir, "genome.json"),
    JSON.stringify(
      {
        genome_schema_version: "3",
        genome_id: genomeId,
        parent_id: SEED_GENOME_ID,
        version: 1,
        base: "default",
        components: [
          {
            id: "skills",
            source: "./components/skills.json",
            contract: "./contracts/skills.dev.md",
          },
        ],
      },
      null,
      2,
    ) + "\n",
  );
  await writeFile(
    join(dir, "components", "skills.json"),
    JSON.stringify(
      {
        component_schema_version: "1",
        component_id: "skills",
        config: { skills: [{ source: "./skills/diagnose-before-fixing" }] },
      },
      null,
      2,
    ) + "\n",
  );
}

/** Snapshot a bundle written to a temp directory. */
async function snapshotOf(root: string, genomeDir: string): Promise<HarnessSnapshot> {
  return buildHarnessSnapshot({
    genomeDir,
    agentConfigDir: join(root, "agent-config"),
    rsihRevision: "33c4f8d",
    piVersion: "0.84.3",
  });
}

/** A seed harness in its own temp directory. */
async function seedHarness(root: string): Promise<{ snapshot: HarnessSnapshot; dir: string }> {
  const genomeDir = join(root, "genomes", "m1-baseline");
  await writeBundle(genomeDir, SEED_GENOME_ID);
  const agentConfigDir = join(root, "agent-config");
  await writeAgentConfig(agentConfigDir);
  return { snapshot: await snapshotOf(root, genomeDir), dir: genomeDir };
}

test("a bundle without a readable manifest is refused", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-"));
  const genomeDir = join(root, "genomes", "empty");
  await mkdir(genomeDir, { recursive: true });
  await assert.rejects(
    () => snapshotOf(root, genomeDir),
    (error: Error) => error instanceof HarnessError && /no readable Genome bundle/.test(error.message),
  );
});

test("a bundle that declares no genome_id is refused", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-"));
  const genomeDir = join(root, "genomes", "nameless");
  await mkdir(join(genomeDir, "components"), { recursive: true });
  await writeFile(join(genomeDir, "genome.json"), JSON.stringify({ genome_schema_version: "3" }));
  await assert.rejects(
    () => snapshotOf(root, genomeDir),
    (error: Error) => error instanceof HarnessError && /declares no genome_id/.test(error.message),
  );
});

test("identity follows content, not location", async () => {
  const left = await mkdtemp(join(tmpdir(), "harness-"));
  const right = await mkdtemp(join(tmpdir(), "harness-"));
  const leftHarness = await seedHarness(left);
  const rightHarness = await seedHarness(right);

  assert.equal(
    harnessIdentity(leftHarness.snapshot),
    harnessIdentity(rightHarness.snapshot),
    "the same bundle at two paths is the same harness",
  );
});

test("identity changes when any load-bearing part changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-"));
  const seed = await seedHarness(root);

  const changedText = join(root, "genomes", "changed-instructions");
  await writeBundle(changedText, SEED_GENOME_ID, "different instructions");
  const changed = await snapshotOf(root, changedText);
  assert.notEqual(harnessIdentity(seed.snapshot), harnessIdentity(changed));

  // A changed agent configuration changes the harness, because the provider,
  // model and reasoning level are declared by the harness.
  const changedConfig = join(root, "agent-config-alt");
  await writeAgentConfig(changedConfig);
  await writeFile(join(changedConfig, "settings.json"), JSON.stringify({ defaultProvider: "evocfd-intern-ai", defaultModel: "Atria-Dawn-Preview", defaultThinkingLevel: "medium" }, null, 2) + "\n");
  const altConfig = await buildHarnessSnapshot({
    genomeDir: seed.dir,
    agentConfigDir: changedConfig,
    rsihRevision: seed.snapshot.rsih_revision,
    piVersion: seed.snapshot.pi_version,
  });
  assert.notEqual(harnessIdentity(seed.snapshot), harnessIdentity(altConfig));

  // A changed runtime changes the harness.
  const altRuntime = await buildHarnessSnapshot({
    genomeDir: seed.dir,
    agentConfigDir: join(root, "agent-config"),
    rsihRevision: "deadbeef",
    piVersion: seed.snapshot.pi_version,
  });
  assert.notEqual(harnessIdentity(seed.snapshot), harnessIdentity(altRuntime));
});

test("identity is secret-free", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-"));
  const seed = await seedHarness(root);
  const identity = harnessIdentity(seed.snapshot);
  const configText = await readFileText(join(root, "agent-config", "models.json"));

  assert.doesNotMatch(identity, /apiKey|key|token|secret/i, "no secret value in the identity");
  assert.doesNotMatch(configText, /apiKey/, "the digested repository copy carries no credential");
});

test("the snapshot covers the whole bundle, not only genome.json", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-"));
  const seed = await seedHarness(root);

  const withSkill = join(root, "genomes", "with-skill");
  await cp(seed.dir, withSkill, { recursive: true });
  await mkdir(join(withSkill, "skills", "one"), { recursive: true });
  await writeFile(join(withSkill, "skills", "one", "SKILL.md"), "# one\n");

  const snapshot = await snapshotOf(root, withSkill);
  assert.notEqual(
    harnessIdentity(seed.snapshot),
    harnessIdentity(snapshot),
    "a skill added to the bundle changes the harness identity",
  );
});

test("a candidate record is excluded from its own digest", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-"));
  const seed = await seedHarness(root);

  const candidateDir = join(root, "genomes", "m1-candidate-001");
  await writeCandidate(seed.dir, candidateDir, "evocfd:m1-candidate-001", "establish what is wrong first");
  const candidateSnapshot = await snapshotOf(root, candidateDir);

  const before = harnessIdentity(candidateSnapshot);
  await recordCandidate({
    genomeDir: candidateDir,
    candidateSnapshot,
    record: {
      candidate_genome_id: "evocfd:m1-candidate-001",
      parent_genome_id: SEED_GENOME_ID,
      proposer_harness_identity: PROPOSER_IDENTITY,
      parent_harness_identity: harnessIdentity(seed.snapshot),
      change: {
        kind: "skill_upsert",
        skill: "diagnose-before-fixing",
        rationale: "the agent changed a file before establishing what was wrong",
        proposer_episode: "m1-trial-001",
      },
      status: "proposed",
    },
    now: () => new Date("2026-09-15T20:00:00Z"),
  });

  const after = harnessIdentity(await snapshotOf(root, candidateDir));
  assert.equal(
    before,
    after,
    "writing the record must not change the identity it records",
  );
  assert.notEqual(
    before,
    harnessIdentity(seed.snapshot),
    "the candidate is still a different harness from its parent",
  );
});

test("a candidate record is written once and read back exactly", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-"));
  const seed = await seedHarness(root);
  const candidateDir = join(root, "genomes", "m1-candidate-002");
  await writeCandidate(seed.dir, candidateDir, "evocfd:m1-candidate-002", "text");
  const candidateSnapshot = await snapshotOf(root, candidateDir);

  const written = await recordCandidate({
    genomeDir: candidateDir,
    candidateSnapshot,
    record: {
      candidate_genome_id: "evocfd:m1-candidate-002",
      parent_genome_id: SEED_GENOME_ID,
      proposer_harness_identity: PROPOSER_IDENTITY,
      parent_harness_identity: harnessIdentity(seed.snapshot),
      change: {
        kind: "skill_modify",
        skill: "diagnose-before-fixing",
        rationale: "tighten the trigger",
        proposer_episode: "m1-trial-002",
      },
      status: "proposed",
    },
    now: () => new Date("2026-09-15T20:01:00Z"),
  });

  assert.equal(written.candidate_harness_identity, harnessIdentity(candidateSnapshot));
  assert.equal(written.created_at, "2026-09-15T20:01:00.000Z");

  const read = await readCandidate(candidateDir);
  assert.deepEqual(read, written, "what is read back is what was written");

  await assert.rejects(
    () =>
      recordCandidate({
        genomeDir: candidateDir,
        candidateSnapshot,
        record: written,
        now: () => new Date("2026-09-15T20:02:00Z"),
      }),
    (error: Error) => error instanceof CandidateExistsError,
    "a second record over the same bundle is refused",
  );
});

test("a bundle without a record is a seed, not an empty candidate", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-"));
  const seed = await seedHarness(root);
  await assert.rejects(
    () => readCandidate(seed.dir),
    (error: Error) => error instanceof CandidateMissingError,
  );
});

test("a malformed record is refused rather than trusted", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-"));
  const seed = await seedHarness(root);
  const candidateDir = join(root, "genomes", "m1-candidate-003");
  await writeCandidate(seed.dir, candidateDir, "evocfd:m1-candidate-003", "text");

  await writeFile(join(candidateDir, "candidate.json"), "{ this is not json");
  await assert.rejects(() => readCandidate(candidateDir), (error: Error) => error instanceof CandidateMissingError);

  await writeFile(join(candidateDir, "candidate.json"), JSON.stringify({ candidate_genome_id: "x" }));
  await assert.rejects(
    () => readCandidate(candidateDir),
    (error: Error) => error instanceof CandidateMissingError && /has no/.test(error.message),
  );

  await writeFile(
    join(candidateDir, "candidate.json"),
    JSON.stringify({
      candidate_genome_id: "x",
      parent_genome_id: "p",
      proposer_harness_identity: PROPOSER_IDENTITY,
      parent_harness_identity: "i",
      candidate_harness_identity: "i",
      change: { kind: "rewrite_the_solver", skill: "s", rationale: "r", proposer_episode: "e" },
      status: "proposed",
    }),
  );
  await assert.rejects(
    () => readCandidate(candidateDir),
    (error: Error) => error instanceof CandidateMissingError && /malformed change/.test(error.message),
  );
});

test("lineage walks from a candidate back to its seed", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-"));
  const genomesRoot = join(root, "genomes");
  const seed = await seedHarness(root);

  const firstDir = join(genomesRoot, "m1-candidate-010");
  await writeCandidate(seed.dir, firstDir, "evocfd:m1-candidate-010", "first");
  const firstSnapshot = await snapshotOf(root, firstDir);
  await recordCandidate({
    genomeDir: firstDir,
    candidateSnapshot: firstSnapshot,
    record: {
      candidate_genome_id: "evocfd:m1-candidate-010",
      parent_genome_id: SEED_GENOME_ID,
      proposer_harness_identity: PROPOSER_IDENTITY,
      parent_harness_identity: harnessIdentity(seed.snapshot),
      change: {
        kind: "skill_upsert",
        skill: "diagnose-before-fixing",
        rationale: "first",
        proposer_episode: "m1-trial-001",
      },
      status: "proposed",
    },
  });

  const secondDir = join(genomesRoot, "m1-candidate-011");
  await writeCandidate(firstDir, secondDir, "evocfd:m1-candidate-011", "second");
  const secondSnapshot = await snapshotOf(root, secondDir);
  await recordCandidate({
    genomeDir: secondDir,
    candidateSnapshot: secondSnapshot,
    record: {
      candidate_genome_id: "evocfd:m1-candidate-011",
      parent_genome_id: "evocfd:m1-candidate-010",
      proposer_harness_identity: PROPOSER_IDENTITY,
      parent_harness_identity: harnessIdentity(firstSnapshot),
      change: {
        kind: "skill_modify",
        skill: "diagnose-before-fixing",
        rationale: "second",
        proposer_episode: "m1-trial-002",
      },
      status: "proposed",
    },
  });

  const lineage = await candidateLineage({
    genomesRoot,
    genomeId: "evocfd:m1-candidate-011",
    agentConfigDir: join(root, "agent-config"),
    rsihRevision: "33c4f8d",
    piVersion: "0.84.3",
  });

  assert.equal(lineage.length, 3, "seed, first candidate, second candidate");
  assert.equal(lineage[0].genome_id, SEED_GENOME_ID);
  assert.equal(lineage[0].change?.skill, "diagnose-before-fixing");
  assert.equal(lineage[1].genome_id, "evocfd:m1-candidate-010");
  assert.equal(lineage[2].genome_id, "evocfd:m1-candidate-011");
  assert.equal(lineage[2].change, undefined, "the last link changes nothing further");

  assert.equal(
    lineage[0].harness_identity,
    harnessIdentity(seed.snapshot),
    "the seed's recorded identity is the lineage's root",
  );
  assert.notEqual(lineage[0].harness_identity, lineage[1].harness_identity);
  assert.notEqual(lineage[1].harness_identity, lineage[2].harness_identity);
});

test("a lineage whose parent is missing is a break, not a prefix", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-"));
  const genomesRoot = join(root, "genomes");
  const seed = await seedHarness(root);

  const orphanDir = join(genomesRoot, "m1-candidate-020");
  await writeCandidate(seed.dir, orphanDir, "evocfd:m1-candidate-020", "orphan");
  await recordCandidate({
    genomeDir: orphanDir,
    candidateSnapshot: await snapshotOf(root, orphanDir),
    record: {
      candidate_genome_id: "evocfd:m1-candidate-020",
      parent_genome_id: "evocfd:does-not-exist",
      proposer_harness_identity: PROPOSER_IDENTITY,
      parent_harness_identity: "0".repeat(64),
      change: {
        kind: "skill_upsert",
        skill: "s",
        rationale: "r",
        proposer_episode: "e",
      },
      status: "proposed",
    },
  });

  await assert.rejects(
    () =>
      candidateLineage({
        genomesRoot,
        genomeId: "evocfd:m1-candidate-020",
        agentConfigDir: join(root, "agent-config"),
        rsihRevision: "33c4f8d",
        piVersion: "0.84.3",
      }),
    (error: Error) =>
      error instanceof LineageBreakError && /is not present/.test(error.message),
  );
});

test("a lineage whose parent exists but under a forged identity is a break", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-"));
  const genomesRoot = join(root, "genomes");
  const seed = await seedHarness(root);

  // A candidate whose parent *is* present, but whose record claims an identity
  // the parent does not have: a record moved into the wrong lineage, or a
  // parent that changed after the candidate was built against it. Trusting the
  // claim would compare this candidate against something that is not what it
  // was built from.
  const candidateDir = join(genomesRoot, "m1-candidate-021");
  await writeCandidate(seed.dir, candidateDir, "evocfd:m1-candidate-021", "forged");
  await recordCandidate({
    genomeDir: candidateDir,
    candidateSnapshot: await snapshotOf(root, candidateDir),
    record: {
      candidate_genome_id: "evocfd:m1-candidate-021",
      parent_genome_id: SEED_GENOME_ID,
      proposer_harness_identity: PROPOSER_IDENTITY,
      parent_harness_identity: "f".repeat(64),
      change: { kind: "skill_upsert", skill: "s", rationale: "r", proposer_episode: "e" },
      status: "proposed",
    },
  });

  await assert.rejects(
    () =>
      candidateLineage({
        genomesRoot,
        genomeId: "evocfd:m1-candidate-021",
        agentConfigDir: join(root, "agent-config"),
        rsihRevision: "33c4f8d",
        piVersion: "0.84.3",
      }),
    (error: Error) =>
      error instanceof LineageBreakError && /claims parent identity/.test(error.message),
  );
});

test("a candidate record found in the wrong bundle is a break", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-"));
  const genomesRoot = join(root, "genomes");
  const seed = await seedHarness(root);

  // The record names a genome id that is not the bundle it sits in — a
  // directory renamed, or a record hand-edited into the wrong bundle. This
  // cannot be written through recordCandidate, which is precisely why the
  // walker has to check it as well.
  const candidateDir = join(genomesRoot, "m1-candidate-022");
  await writeCandidate(seed.dir, candidateDir, "evocfd:m1-candidate-022", "mislabeled");
  await writeFile(
    join(candidateDir, "candidate.json"),
    JSON.stringify(
      {
        candidate_genome_id: "evocfd:totally-different",
        parent_genome_id: SEED_GENOME_ID,
        proposer_harness_identity: PROPOSER_IDENTITY,
      parent_harness_identity: harnessIdentity(seed.snapshot),
        candidate_harness_identity: harnessIdentity(await snapshotOf(root, candidateDir)),
        change: { kind: "skill_upsert", skill: "s", rationale: "r", proposer_episode: "e" },
        status: "proposed",
        created_at: "2026-01-01T00:00:00.000Z",
      },
      null,
      2,
    ) + "\n",
  );

  await assert.rejects(
    () =>
      candidateLineage({
        genomesRoot,
        genomeId: "evocfd:m1-candidate-022",
        agentConfigDir: join(root, "agent-config"),
        rsihRevision: "33c4f8d",
        piVersion: "0.84.3",
      }),
    (error: Error) =>
      error instanceof LineageBreakError && /claims genome id/.test(error.message),
  );
});

test("cyclic ancestry is refused", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-"));
  const genomesRoot = join(root, "genomes");
  const seed = await seedHarness(root);

  const aDir = join(genomesRoot, "m1-candidate-030");
  const bDir = join(genomesRoot, "m1-candidate-031");
  await writeCandidate(seed.dir, aDir, "evocfd:m1-candidate-030", "a");
  await writeCandidate(seed.dir, bDir, "evocfd:m1-candidate-031", "b");

  // A genuine two-cycle: each candidate claims the other as parent, and each
  // claim is backed by the other's real identity. Identity claims are verified
  // on the walk, so a cycle made of forgeries would be rejected earlier and
  // would not exercise the cycle check itself.
  const [identityA, identityB] = await Promise.all([
    snapshotOf(root, aDir).then(harnessIdentity),
    snapshotOf(root, bDir).then(harnessIdentity),
  ]);
  await recordCandidate({
    genomeDir: aDir,
    candidateSnapshot: await snapshotOf(root, aDir),
    record: {
      candidate_genome_id: "evocfd:m1-candidate-030",
      parent_genome_id: "evocfd:m1-candidate-031",
      proposer_harness_identity: PROPOSER_IDENTITY,
      parent_harness_identity: identityB,
      change: { kind: "skill_upsert", skill: "s", rationale: "r", proposer_episode: "e" },
      status: "proposed",
    },
  });
  await recordCandidate({
    genomeDir: bDir,
    candidateSnapshot: await snapshotOf(root, bDir),
    record: {
      candidate_genome_id: "evocfd:m1-candidate-031",
      parent_genome_id: "evocfd:m1-candidate-030",
      proposer_harness_identity: PROPOSER_IDENTITY,
      parent_harness_identity: identityA,
      change: { kind: "skill_upsert", skill: "s", rationale: "r", proposer_episode: "e" },
      status: "proposed",
    },
  });

  await assert.rejects(
    () =>
      candidateLineage({
        genomesRoot,
        genomeId: "evocfd:m1-candidate-030",
        agentConfigDir: join(root, "agent-config"),
        rsihRevision: "33c4f8d",
        piVersion: "0.84.3",
      }),
    (error: Error) => error instanceof LineageBreakError && /cyclic/.test(error.message),
  );
});

test("resolution is by declared id, not directory name", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-"));
  const genomesRoot = join(root, "genomes");
  const renamed = join(genomesRoot, "whatever-this-directory-is-called");
  await writeBundle(renamed, SEED_GENOME_ID);

  const dir = await defaultResolveGenomeDir(genomesRoot, SEED_GENOME_ID);
  assert.equal(dir, renamed);

  assert.equal(await defaultResolveGenomeDir(genomesRoot, "evocfd:nothing"), null);
  assert.equal(await defaultResolveGenomeDir(join(root, "no-such-root"), SEED_GENOME_ID), null);
});

test("an empty genomes root resolves nothing without throwing", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-"));
  assert.equal(await defaultResolveGenomeDir(join(root, "empty"), SEED_GENOME_ID), null);
});

test("a seed whose parent points at itself is a cycle, not a lineage", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-"));
  const genomesRoot = join(root, "genomes");
  await writeAgentConfig(join(root, "agent-config"));
  // A bundle that claims to be its own ancestor has no walkable ancestry.
  await writeBundle(join(genomesRoot, "self-parent"), SEED_GENOME_ID);
  await recordCandidate({
    genomeDir: join(genomesRoot, "self-parent"),
    candidateSnapshot: await snapshotOf(root, join(genomesRoot, "self-parent")),
    record: {
      candidate_genome_id: SEED_GENOME_ID,
      parent_genome_id: SEED_GENOME_ID,
      // Its own real identity, so the self-claim passes verification and the
      // walk reaches the cycle check rather than the identity check.
      proposer_harness_identity: PROPOSER_IDENTITY,
      parent_harness_identity: harnessIdentity(await snapshotOf(root, join(genomesRoot, "self-parent"))),
      change: { kind: "skill_upsert", skill: "s", rationale: "r", proposer_episode: "e" },
      status: "proposed",
    },
  });

  await assert.rejects(
    () =>
      candidateLineage({
        genomesRoot,
        genomeId: SEED_GENOME_ID,
        agentConfigDir: join(root, "agent-config"),
        rsihRevision: "33c4f8d",
        piVersion: "0.84.3",
      }),
    (error: Error) => error instanceof LineageBreakError && /cyclic/.test(error.message),
  );
});

async function readFileText(path: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  return readFile(path, "utf8");
}
