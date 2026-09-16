import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  assembleEvidencePackage,
  EVIDENCE_DIR,
  EVIDENCE_MANIFEST,
  PROPOSER_OUTPUT_DIR,
  readEvidenceDigest,
} from "../src/evidence.ts";
import { digestTree } from "../src/snapshot.ts";
import type { HarnessSnapshot } from "../src/harness.ts";

const SNAPSHOT: HarnessSnapshot = {
  genome_id: "evocfd:m1-baseline",
  genome_digest: "a".repeat(64),
  agent_config_digest: "b".repeat(64),
  rsih_revision: "33c4f8d",
  pi_version: "0.84.3",
  context_files: [],
};

/** A synthetic trial tree with the parts a real one records. */
async function recordTrial(
  runsDir: string,
  trialId: string,
  options: { verdict?: string; withEvaluator?: boolean } = {},
): Promise<void> {
  const trialRoot = join(runsDir, trialId);
  await mkdir(join(trialRoot, "manifests"), { recursive: true });
  await mkdir(join(trialRoot, "agent"), { recursive: true });
  await mkdir(join(trialRoot, "workspace"), { recursive: true });
  await mkdir(join(trialRoot, "private", "episodes"), { recursive: true });

  await writeFile(
    join(trialRoot, "manifests", "trial.json"),
    JSON.stringify({ trial_id: trialId, fixture_id: "control-plane-001" }) + "\n",
  );
  await writeFile(join(trialRoot, "agent", "TASK.md"), "# Do the thing\n");
  await writeFile(join(trialRoot, "workspace", "app.js"), "// the agent's final work\n");
  await writeFile(
    join(trialRoot, "private", "episodes", "events.jsonl"),
    '{"type":"session"}\n{"type":"agent_start"}\n',
  );
  await writeFile(
    join(trialRoot, "private", "result.json"),
    JSON.stringify({
      trial_id: trialId,
      verdict: options.verdict ?? "pass",
      criteria: [{ name: "structure", passed: true }],
    }) + "\n",
  );
  if (options.withEvaluator) {
    // The evaluator package is the one thing a proposer must not receive.
    await mkdir(join(trialRoot, "private", "evaluator"), { recursive: true });
    await writeFile(
      join(trialRoot, "private", "evaluator", "check.mjs"),
      "// how the verdict was reached\n",
    );
  }
}

async function scenario(): Promise<{ root: string; runsDir: string; parent: string }> {
  const root = await mkdtemp(join(tmpdir(), "evocfd-evid-"));
  const runsDir = join(root, "runs");
  const parent = join(root, "genomes", "m1-baseline");
  await mkdir(join(runsDir, "proposal-001"), { recursive: true });
  await mkdir(join(parent, "components"), { recursive: true });
  await writeFile(join(parent, "genome.json"), JSON.stringify({ genome_id: "evocfd:m1-baseline" }) + "\n");
  return { root, runsDir, parent };
}

test("evidence: assembles the expected package from one recorded trial", async () => {
  const s = await scenario();
  await recordTrial(s.runsDir, "m1-trial-001");

  const pkg = await assembleEvidencePackage({
    runRoot: join(s.runsDir, "proposal-001"),
    runsDir: s.runsDir,
    trialIds: ["m1-trial-001"],
    parentGenomeDir: s.parent,
    parentGenomeId: "evocfd:m1-baseline",
    parentSnapshot: SNAPSHOT,
  });

  const expected = join(s.runsDir, "proposal-001", EVIDENCE_DIR);
  assert.equal(pkg.dir, expected);
  assert.equal(pkg.trials.length, 1);

  // The primary evidence is copied verbatim, not summarized.
  const events = await readFile(join(expected, "evidence", "m1-trial-001", "episode", "events.jsonl"), "utf8");
  assert.ok(events.includes("agent_start"));
  // The task the agent was given.
  assert.ok((await readFile(join(expected, "evidence", "m1-trial-001", "task", "TASK.md"), "utf8")).includes("Do the thing"));
  // The verdict, and the manifest that says what the trial was.
  assert.ok((await readFile(join(expected, "evidence", "m1-trial-001", "evaluation", "result.json"), "utf8")).includes("pass"));
  assert.ok((await readFile(join(expected, "evidence", "m1-trial-001", "trial-manifest.json"), "utf8")).includes("control-plane-001"));
  // The harness the proposer is asked to improve, and its snapshot.
  assert.ok((await readFile(join(expected, "parent", "genome", "genome.json"), "utf8")).includes("evocfd:m1-baseline"));
  assert.ok((await readFile(join(expected, "parent", "harness-snapshot.json"), "utf8")).includes("0.84.3"));

  await rm(s.root, { recursive: true, force: true });
});

test("evidence: the evaluator package is never part of the package", async () => {
  const s = await scenario();
  await recordTrial(s.runsDir, "m1-trial-001", { withEvaluator: true });

  const pkg = await assembleEvidencePackage({
    runRoot: join(s.runsDir, "proposal-001"),
    runsDir: s.runsDir,
    trialIds: ["m1-trial-001"],
    parentGenomeDir: s.parent,
    parentGenomeId: "evocfd:m1-baseline",
    parentSnapshot: SNAPSHOT,
  });

  const manifest = JSON.parse(
    await readFile(join(pkg.dir, EVIDENCE_MANIFEST), "utf8"),
  ) as { contents: string[] };
  for (const file of manifest.contents) {
    assert.ok(!file.includes("evaluator"), `evaluator leaked into the package: ${file}`);
    // The final workspace is summarized by the verdict, not shipped.
    assert.ok(!file.includes("workspace"), `workspace leaked into the package: ${file}`);
  }
  assert.ok(manifest.contents.length > 0);

  await rm(s.root, { recursive: true, force: true });
});

test("evidence: the digest is recorded, read back, and stable", async () => {
  const s = await scenario();
  await recordTrial(s.runsDir, "m1-trial-001");
  const runRoot = join(s.runsDir, "proposal-001");

  const first = await assembleEvidencePackage({
    runRoot,
    runsDir: s.runsDir,
    trialIds: ["m1-trial-001"],
    parentGenomeDir: s.parent,
    parentGenomeId: "evocfd:m1-baseline",
    parentSnapshot: SNAPSHOT,
  });
  assert.equal(await readEvidenceDigest(runRoot), first.digest);
  // The digest covers the package as the proposer sees it, which excludes the
  // manifest that records it — a file cannot contain its own hash.
  assert.equal(first.digest, (await digestTree(first.dir, [EVIDENCE_MANIFEST])).digest);

  // Reassembling the same inputs yields the same digest, so a proposal run can
  // be reproduced and a divergence would mean an input changed.
  const second = await assembleEvidencePackage({
    runRoot,
    runsDir: s.runsDir,
    trialIds: ["m1-trial-001"],
    parentGenomeDir: s.parent,
    parentGenomeId: "evocfd:m1-baseline",
    parentSnapshot: SNAPSHOT,
  });
  assert.equal(second.digest, first.digest);

  await rm(s.root, { recursive: true, force: true });
});

test("evidence: a trial with no verdict is marked, not silent", async () => {
  const s = await scenario();
  await recordTrial(s.runsDir, "m1-trial-001");
  await rm(join(s.runsDir, "m1-trial-001", "private", "result.json"), { force: true });

  const pkg = await assembleEvidencePackage({
    runRoot: join(s.runsDir, "proposal-001"),
    runsDir: s.runsDir,
    trialIds: ["m1-trial-001"],
    parentGenomeDir: s.parent,
    parentGenomeId: "evocfd:m1-baseline",
    parentSnapshot: SNAPSHOT,
  });
  const result = JSON.parse(
    await readFile(join(pkg.dir, "evidence", "m1-trial-001", "evaluation", "result.json"), "utf8"),
  ) as { verdict: string };
  assert.equal(result.verdict, "not_recorded");

  await rm(s.root, { recursive: true, force: true });
});

test("evidence: refuses an unrecorded trial rather than packaging silence", async () => {
  const s = await scenario();
  await assert.rejects(
    () =>
      assembleEvidencePackage({
        runRoot: join(s.runsDir, "proposal-001"),
        runsDir: s.runsDir,
        trialIds: ["never-ran"],
        parentGenomeDir: s.parent,
        parentGenomeId: "evocfd:m1-baseline",
        parentSnapshot: SNAPSHOT,
      }),
    /is not recorded/,
  );
  // And a failed assembly leaves no package behind.
  const { readdir } = await import("node:fs/promises");
  assert.deepEqual(await readdir(join(s.runsDir, "proposal-001", "private")), []);
  await rm(s.root, { recursive: true, force: true });
});

test("evidence: refuses a proposal with no trials", async () => {
  const s = await scenario();
  await assert.rejects(
    () =>
      assembleEvidencePackage({
        runRoot: join(s.runsDir, "proposal-001"),
        runsDir: s.runsDir,
        trialIds: [],
        parentGenomeDir: s.parent,
        parentGenomeId: "evocfd:m1-baseline",
        parentSnapshot: SNAPSHOT,
      }),
    /at least one recorded trial/,
  );
  await rm(s.root, { recursive: true, force: true });
});

test("evidence: readEvidenceDigest is null when no package exists", async () => {
  const s = await scenario();
  assert.equal(await readEvidenceDigest(join(s.runsDir, "proposal-001")), null);
  await rm(s.root, { recursive: true, force: true });
});

test("evidence: multiple trials are all present, in order", async () => {
  const s = await scenario();
  await recordTrial(s.runsDir, "m1-trial-001");
  await recordTrial(s.runsDir, "m1-trial-002");

  const pkg = await assembleEvidencePackage({
    runRoot: join(s.runsDir, "proposal-001"),
    runsDir: s.runsDir,
    trialIds: ["m1-trial-001", "m1-trial-002"],
    parentGenomeDir: s.parent,
    parentGenomeId: "evocfd:m1-baseline",
    parentSnapshot: SNAPSHOT,
  });
  const manifest = JSON.parse(await readFile(join(pkg.dir, EVIDENCE_MANIFEST), "utf8")) as {
    trials: string[];
  };
  assert.deepEqual(manifest.trials, ["m1-trial-001", "m1-trial-002"]);

  await rm(s.root, { recursive: true, force: true });
});

test("evidence: the proposer's output directory is not part of the evidence", async () => {
  const s = await scenario();
  await recordTrial(s.runsDir, "m1-trial-001");
  const runRoot = join(s.runsDir, "proposal-001");
  await mkdir(join(runRoot, PROPOSER_OUTPUT_DIR), { recursive: true });
  await writeFile(join(runRoot, PROPOSER_OUTPUT_DIR, "proposal.json"), "{}\n");

  const pkg = await assembleEvidencePackage({
    runRoot,
    runsDir: s.runsDir,
    trialIds: ["m1-trial-001"],
    parentGenomeDir: s.parent,
    parentGenomeId: "evocfd:m1-baseline",
    parentSnapshot: SNAPSHOT,
  });
  // The output directory survives (it is the proposer's, not assembly's) but is
  // not digested as evidence.
  const manifest = JSON.parse(await readFile(join(pkg.dir, EVIDENCE_MANIFEST), "utf8")) as {
    contents: string[];
  };
  assert.ok(!manifest.contents.some((file) => file.includes("output")));

  await rm(s.root, { recursive: true, force: true });
});
