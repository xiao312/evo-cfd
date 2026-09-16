/**
 * The evidence package a proposer is allowed to see.
 *
 * A proposer decides whether a harness should change, so it has to see what the
 * harness did. It does not get to see how it is judged. This module is the
 * difference: the evaluation *result* is copied in, the evaluation *package*
 * never is, and the same applies to held-out fixtures, other candidates and
 * anything else a later comparison would be contaminated by.
 *
 * The package is a directory, not an API: it is assembled, digested, mounted
 * read-only into the proposer's container, and the digest is recorded on the
 * proposal run. A proposer that saw a different package made a different
 * proposal, and the record has to be able to say which one.
 *
 * Evidence is drawn only from recorded trial artifacts. Nothing is read from a
 * live run, and nothing the evaluator ships is reachable, so the boundary does
 * not depend on the proposer's good behaviour.
 */
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { digestTree } from "./snapshot.ts";
import type { HarnessSnapshot } from "./harness.ts";

/** Where the assembled package lives within a proposal run. */
export const EVIDENCE_DIR = "private/proposal-input";
export const EVIDENCE_MANIFEST = "proposal-input-manifest.json";
/** Where the proposer writes; the only writable path it is given. */
export const PROPOSER_OUTPUT_DIR = "private/output";

export class EvidenceError extends Error {
  readonly code = "EEVIDENCE";
}

/**
 * What the proposer sees of the harness it is asked to improve, and of the run
 * it is asked to improve from. The Genome bundle is copied whole because a
 * proposer that cannot read the existing instructions cannot tell what it
 * would be duplicating.
 */
export interface EvidencePackage {
  /** Absolute directory the package was assembled into. */
  dir: string;
  /** Digest over the whole package, recorded on the proposal run. */
  digest: string;
  trials: string[];
  parentGenomeId: string;
}

/**
 * Assemble a read-only evidence package for a proposer.
 *
 * Every input is an already-recorded artifact: a trial that was materialized,
 * an episode that ran, a verdict that was written. The proposer never reaches
 * behind those records — not into the evaluator package, not into the fixtures
 * directory, not into other proposal runs.
 */
export async function assembleEvidencePackage(input: {
  /** Proposal run root, e.g. runs/proposal-001. */
  runRoot: string;
  runsDir: string;
  trialIds: string[];
  parentGenomeDir: string;
  parentGenomeId: string;
  parentSnapshot: HarnessSnapshot;
  now?: () => Date;
}): Promise<EvidencePackage> {
  if (input.trialIds.length === 0) {
    throw new EvidenceError("a proposal requires at least one recorded trial as evidence");
  }

  const pkgDir = join(input.runRoot, EVIDENCE_DIR);
  // A half-assembled package would be a package the proposer could read
  // incompletely, so assembly writes into a staging directory and renames.
  const staging = join(input.runRoot, `${EVIDENCE_DIR}.tmp`);
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });

  try {
    const evidenceRoot = join(staging, "evidence");
    await mkdir(evidenceRoot, { recursive: true });
    for (const trialId of input.trialIds) {
      await copyTrialEvidence({
        runsDir: input.runsDir,
        trialId,
        destination: join(evidenceRoot, trialId),
      });
    }
    await cp(input.parentGenomeDir, join(staging, "parent", "genome"), { recursive: true });
    await mkdir(join(staging, "parent"), { recursive: true });
    await writeFile(
      join(staging, "parent", "harness-snapshot.json"),
      JSON.stringify(input.parentSnapshot, null, 2) + "\n",
    );

    // The digest covers the package as the proposer will see it, so it is
    // computed before the manifest is written; the manifest is what records
    // the digest, and it is not part of the package the proposer reasons from.
    const tree = await digestTree(staging);
    await writeFile(
      join(staging, EVIDENCE_MANIFEST),
      JSON.stringify(
        {
          schema_version: 1,
          assembled_at: (input.now ?? (() => new Date()))().toISOString(),
          trials: input.trialIds,
          parent_genome_id: input.parentGenomeId,
          digest: tree.digest,
          contents: tree.files,
        },
        null,
        2,
      ) + "\n",
    );

    await rm(pkgDir, { recursive: true, force: true });
    await mkdir(join(input.runRoot, "private"), { recursive: true });
    await rename(staging, pkgDir);

    return {
      dir: pkgDir,
      digest: tree.digest,
      trials: [...input.trialIds],
      parentGenomeId: input.parentGenomeId,
    };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Copy the recorded evidence of one trial, and nothing else.
 *
 * The trial directory holds the agent's prompt and workspace, the manifests,
 * and the private directory that contains the episode evidence, the result and
 * the evaluator package. Only the recorded evidence is interesting to a
 * proposer, and the evaluator package is the one thing it must not have, so the
 * copy is selective rather than wholesale.
 */
async function copyTrialEvidence(input: {
  runsDir: string;
  trialId: string;
  destination: string;
}): Promise<void> {
  const trialRoot = resolve(input.runsDir, input.trialId);
  if (!(await pathExists(trialRoot))) {
    throw new EvidenceError(`trial ${input.trialId} is not recorded under ${input.runsDir}`);
  }
  const privateDir = join(trialRoot, "private");
  if (!(await pathExists(privateDir))) {
    throw new EvidenceError(`trial ${input.trialId} has no recorded evidence`);
  }

  await mkdir(input.destination, { recursive: true });

  // The manifest record: what the trial was, and what it was judged against.
  const trialManifest = join(trialRoot, "manifests", "trial.json");
  if (await pathExists(trialManifest)) {
    await cp(trialManifest, join(input.destination, "trial-manifest.json"));
  }

  // The task as the agent saw it. The workspace is deliberately not copied:
  // the final workspace is summarized by the verdict, and shipping the whole
  // diff invites a proposer to reason about one task's files rather than about
  // the harness.
  const taskFile = join(trialRoot, "agent", "TASK.md");
  if (await pathExists(taskFile)) {
    await mkdir(join(input.destination, "task"), { recursive: true });
    await cp(taskFile, join(input.destination, "task", "TASK.md"));
  }

  // The episode: the raw event stream and its recorded result. This is the
  // primary evidence, copied verbatim rather than summarized.
  const episodesDir = join(privateDir, "episodes");
  if (await pathExists(episodesDir)) {
    await cp(episodesDir, join(input.destination, "episode"), { recursive: true });
  }

  // The verdict, copied as `evaluation/` so a proposer reads the criteria that
  // passed and failed. The evaluator that produced it is never part of the
  // package. A trial with no verdict is still evidence, but it must not be
  // mistaken for one.
  const resultFile = join(privateDir, "result.json");
  if (await pathExists(resultFile)) {
    await mkdir(join(input.destination, "evaluation"), { recursive: true });
    await cp(resultFile, join(input.destination, "evaluation", "result.json"));
  } else {
    await mkdir(join(input.destination, "evaluation"), { recursive: true });
    await writeFile(
      join(input.destination, "evaluation", "result.json"),
      JSON.stringify({ trial_id: input.trialId, verdict: "not_recorded" }, null, 2) + "\n",
    );
  }
}

/** Read an assembled evidence package's recorded digest. */
export async function readEvidenceDigest(runRoot: string): Promise<string | null> {
  try {
    const raw = JSON.parse(
      await readFile(join(runRoot, EVIDENCE_DIR, EVIDENCE_MANIFEST), "utf8"),
    ) as { digest?: unknown };
    return typeof raw.digest === "string" ? raw.digest : null;
  } catch {
    return null;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

// `readdir` is re-exported for tests that need to inspect a package's layout
// without depending on its internals.
export { readdir as _evidenceReadDir };
