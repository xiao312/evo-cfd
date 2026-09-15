/**
 * Harness identity and candidate representation.
 *
 * The harness is what this programme varies, so it has to be identifiable
 * rather than implicit. A trial record that says nothing about which agent loop
 * produced the work cannot support a parent/candidate comparison, and a
 * candidate that cannot be identified cannot be attributed to the evidence that
 * motivated it.
 *
 * A harness is more than `genome.json`. It is, in full:
 *
 *   the Genome bundle — `genome.json` plus every component, contract, skill and
 *   extension file the manifest reaches, since the bundle is a self-contained
 *   directory by RSI-Harness's own rule and a component is free to live in it;
 *
 *   the agent configuration — provider, model and reasoning level, because
 *   these are declared by the harness and not by the task;
 *
 *   the runtime the Genome is driven through — the RSI-Harness revision and the
 *   Pi version it vendors, since both can change what a Genome does;
 *
 *   the ambient context the agent is given — which for every EvoCFD harness is
 *   *none*, because `--no-context-files` is part of the contract. A harness that
 *   wants to teach the agent something does so through the Genome, where the
 *   teaching is digested, rather than by leaving a file in the workspace where
 *   it is not.
 *
 * Properties that are load-bearing here, and tested as such:
 *
 *   Identity is content, not location. The digest covers relative names and
 *   file contents only, so the same bundle in two checkout paths is the same
 *   harness.
 *
 *   Identity is secret-free. The agent configuration is digested from the
 *   repository copy, which carries no credential; the runtime copy that holds
 *   the gateway token is never an input.
 *
 *   A candidate records its parent, not just its change. The chain has to be
 *   walkable from a candidate back to the seed, otherwise "this improved on
 *   that" is an assertion with no evidence behind it.
 *
 *   The record is not part of what it records. `candidate.json` is excluded
 *   from the candidate's own digest, because a file that contains its own
 *   identity cannot be written down without changing it.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { digestTree } from "./snapshot.ts";

/** A candidate record is written beside the Genome it describes. */
const CANDIDATE_FILE = "candidate.json";

/**
 * The parts of a harness that a lineage walk does not vary. A candidate changes
 * its Genome; it does not get to change which agent configuration or runtime it
 * is judged against, so those are supplied once for the whole chain.
 */
export interface HarnessBase {
  agentConfigDir: string;
  rsihRevision: string | null;
  piVersion: string | null;
}

/**
 * Where a harness snapshot reads from. Every path is a repository path; none of
 * them is a runtime path, so a snapshot never crosses the credential boundary.
 */
export interface HarnessSources extends HarnessBase {
  /**
   * Genome bundle directory: `genome.json` plus its components, contracts,
   * skills and extensions. A single-file v2 Genome is refused, because a bundle
   * that reaches outside its own directory is not a thing that can be recorded.
   */
  genomeDir: string;
}

export interface HarnessSnapshot {
  /** Genome id as declared in the bundle, e.g. `evocfd:m1-baseline`. */
  genome_id: string;
  /** Digest over the whole bundle, names and contents. */
  genome_digest: string;
  /** Digest over the agent configuration seed. */
  agent_config_digest: string;
  rsih_revision: string | null;
  pi_version: string | null;
  /**
   * Ambient context files the harness declares. Always empty: an EvoCFD harness
   * reaches the agent through its Genome only, and `--no-context-files` is what
   * makes that true. Recorded so a harness that silently gained an `AGENTS.md`
   * could not hide it.
   */
  context_files: string[];
}

export class HarnessError extends Error {
  readonly code = "EHARNESS";
}

/**
 * Read a Genome bundle and the agent configuration into a snapshot.
 *
 * The bundle is digested as a tree, which already covers every component,
 * contract, skill and extension file in it. A candidate record is excluded,
 * because it describes the bundle rather than being part of it.
 */
export async function buildHarnessSnapshot(sources: HarnessSources): Promise<HarnessSnapshot> {
  const entry = join(sources.genomeDir, "genome.json");
  let genome: { genome_id?: unknown };
  try {
    genome = JSON.parse(await readFile(entry, "utf8"));
  } catch (error) {
    throw new HarnessError(
      `no readable Genome bundle at ${sources.genomeDir}: ${(error as Error).message}`,
    );
  }
  if (typeof genome.genome_id !== "string" || genome.genome_id.length === 0) {
    throw new HarnessError(`Genome bundle at ${sources.genomeDir} declares no genome_id`);
  }

  const [genomeTree, configTree] = await Promise.all([
    digestTree(sources.genomeDir, [CANDIDATE_FILE]),
    digestTree(sources.agentConfigDir),
  ]);

  return {
    genome_id: genome.genome_id,
    genome_digest: genomeTree.digest,
    agent_config_digest: configTree.digest,
    rsih_revision: sources.rsihRevision,
    pi_version: sources.piVersion,
    context_files: [],
  };
}

/**
 * The identity of a harness: a digest over the snapshot's canonical form.
 *
 * Fields are emitted in a fixed order with a version tag, so the identity is
 * stable across runs and so a change to any load-bearing field changes it.
 * The tag is bumped whenever the composed identity gains a field, so an old
 * record can never be confused with a new one.
 */
export function harnessIdentity(snapshot: HarnessSnapshot): string {
  const material = [
    "evocfd-harness-identity/v1",
    `genome=${snapshot.genome_id}@${snapshot.genome_digest}`,
    `agent_config=${snapshot.agent_config_digest}`,
    `rsih=${snapshot.rsih_revision ?? "unknown"}`,
    `pi=${snapshot.pi_version ?? "unknown"}`,
    `context=${snapshot.context_files.length === 0 ? "none" : snapshot.context_files.join(",")}`,
  ].join("\n");
  return createHash("sha256").update(material).digest("hex");
}

/** A short form for display and log lines; never the recorded identifier. */
export function displayHarnessIdentity(identity: string): string {
  return identity.slice(0, 16);
}

/**
 * A bounded change to a harness.
 *
 * Only skill changes are representable, on purpose. A skill is file-based
 * knowledge that loads on demand, so changing one is the least invasive thing a
 * harness can do and the least likely to be an improvement for reasons that have
 * nothing to do with the harness — it cannot touch the model, the tools, the
 * provider, or the evaluator. Widening this set is a decision to make with
 * evidence, not a convenience to add here.
 */
export interface CandidateChange {
  kind: "skill_upsert" | "skill_modify";
  /** The skill the change applies to, by name. */
  skill: string;
  /**
   * Why the change was proposed, in the proposer's own words. Recorded for
   * review and never executed: a rationale is not an instruction.
   */
  rationale: string;
  /** Episode whose evidence motivated the change. */
  proposer_episode: string;
}

export type CandidateStatus = "proposed" | "activated" | "rejected";

/**
 * What a candidate is, written beside the Genome it describes.
 *
 * The record links a candidate to its parent by *identity*, not by name. A name
 * can be reused; an identity cannot, because it is a digest over the bundle's
 * actual contents. Two candidates with the same parent identity and the same
 * change are the same candidate, and the generation step is responsible for
 * noticing that rather than the comparison step.
 */
export interface CandidateRecord {
  candidate_genome_id: string;
  parent_genome_id: string;
  parent_harness_identity: string;
  candidate_harness_identity: string;
  change: CandidateChange;
  /**
   * `proposed` until a trial has actually run under the candidate and been
   * judged. Writing a candidate is not the same as trusting it.
   */
  status: CandidateStatus;
  created_at: string;
}

export class CandidateExistsError extends Error {
  readonly code = "ECANDIDATEEXISTS";
}
export class CandidateMissingError extends Error {
  readonly code = "ECANDIDATEMISSING";
}

/**
 * Write a candidate record beside its Genome bundle.
 *
 * The identity is computed from the snapshot the caller built from the bundle as
 * it is, so a record cannot claim an identity its bundle does not have. The
 * write is staged: the record is built beside the destination and renamed into
 * place, so a candidate is either complete or absent, never half-described.
 */
export async function recordCandidate(input: {
  genomeDir: string;
  record: Omit<CandidateRecord, "candidate_harness_identity" | "created_at">;
  candidateSnapshot: HarnessSnapshot;
  now?: () => Date;
}): Promise<CandidateRecord> {
  const target = join(input.genomeDir, CANDIDATE_FILE);
  if (await pathExists(target)) {
    throw new CandidateExistsError(`a candidate record already exists at ${target}`);
  }

  const record: CandidateRecord = {
    ...input.record,
    candidate_harness_identity: harnessIdentity(input.candidateSnapshot),
    created_at: (input.now ?? (() => new Date()))().toISOString(),
  };

  await mkdir(input.genomeDir, { recursive: true });
  const staging = join(input.genomeDir, `.${CANDIDATE_FILE}.tmp`);
  try {
    await writeFile(staging, JSON.stringify(record, null, 2) + "\n");
    await rename(staging, target);
  } catch (error) {
    await rm(staging, { force: true });
    throw error;
  }
  return record;
}

/**
 * Read the candidate record of a Genome bundle.
 *
 * A bundle without one is a seed or a parent, not a candidate; that is reported
 * rather than treated as an empty candidate.
 */
export async function readCandidate(genomeDir: string): Promise<CandidateRecord> {
  let raw: string;
  try {
    raw = await readFile(join(genomeDir, CANDIDATE_FILE), "utf8");
  } catch {
    throw new CandidateMissingError(`no candidate record in the Genome bundle at ${genomeDir}`);
  }
  return parseCandidateRecord(raw, genomeDir);
}

function parseCandidateRecord(raw: string, genomeDir: string): CandidateRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CandidateMissingError(`candidate record at ${genomeDir} is not valid JSON`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new CandidateMissingError(`candidate record at ${genomeDir} is not an object`);
  }
  const record = parsed as Partial<CandidateRecord>;
  const required: (keyof CandidateRecord)[] = [
    "candidate_genome_id",
    "parent_genome_id",
    "parent_harness_identity",
    "candidate_harness_identity",
  ];
  for (const key of required) {
    if (typeof record[key] !== "string" || (record[key] as string).length === 0) {
      throw new CandidateMissingError(`candidate record at ${genomeDir} has no ${key}`);
    }
  }
  if (typeof record.change !== "object" || record.change === null) {
    throw new CandidateMissingError(`candidate record at ${genomeDir} has no change`);
  }
  const change = record.change as Partial<CandidateChange>;
  if (
    (change.kind !== "skill_upsert" && change.kind !== "skill_modify") ||
    typeof change.skill !== "string" ||
    typeof change.rationale !== "string" ||
    typeof change.proposer_episode !== "string"
  ) {
    throw new CandidateMissingError(`candidate record at ${genomeDir} has a malformed change`);
  }
  if (record.status !== "proposed" && record.status !== "activated" && record.status !== "rejected") {
    throw new CandidateMissingError(`candidate record at ${genomeDir} has an unknown status`);
  }
  return {
    candidate_genome_id: record.candidate_genome_id,
    parent_genome_id: record.parent_genome_id,
    parent_harness_identity: record.parent_harness_identity,
    candidate_harness_identity: record.candidate_harness_identity,
    change,
    status: record.status,
    created_at: record.created_at ?? "",
  };
}

/**
 * The chain from a candidate back to its seed, oldest first.
 *
 * Each link is a harness identity plus the change that produced the next
 * candidate from it. The walk ends at a Genome with no candidate record — the
 * seed — or reports a parent that cannot be found, which is a lineage break:
 * a candidate whose ancestry is missing cannot be compared to anything, and
 * saying so is more useful than returning a truncated chain silently.
 */
export interface LineageLink {
  genome_id: string;
  harness_identity: string;
  /** Change that produced the *next* link in the chain; absent for the seed. */
  change?: CandidateChange;
}

export class LineageBreakError extends Error {
  readonly code = "ELINEAGEBREAK";
}

export async function candidateLineage(input: HarnessBase & {
  genomesRoot: string;
  genomeId: string;
  /** Resolve a Genome id to its bundle directory. */
  resolve?: (genomesRoot: string, genomeId: string) => Promise<string | null>;
}): Promise<LineageLink[]> {
  const resolve = input.resolve ?? defaultResolveGenomeDir;
  const chain: LineageLink[] = [];
  // The change read from a candidate's record describes how that candidate was
  // produced *from its parent*, so it belongs on the parent's link — the link
  // that produced the next one — not on the candidate's own.
  let pendingChange: CandidateChange | undefined;
  let current = input.genomeId;
  const seen = new Set<string>();

  for (;;) {
    if (seen.has(current)) {
      throw new LineageBreakError(`Genome ancestry is cyclic at ${current}`);
    }
    seen.add(current);

    const dir = await resolve(input.genomesRoot, current);
    if (dir === null) {
      throw new LineageBreakError(
        `the ancestor ${current} of ${input.genomeId} is not present under ${input.genomesRoot}`,
      );
    }
    const snapshot = await buildHarnessSnapshot({
      genomeDir: dir,
      agentConfigDir: input.agentConfigDir,
      rsihRevision: input.rsihRevision,
      piVersion: input.piVersion,
    });
    const link: LineageLink = {
      genome_id: current,
      harness_identity: harnessIdentity(snapshot),
    };
    if (pendingChange) link.change = pendingChange;
    chain.unshift(link);

    let candidate: CandidateRecord;
    try {
      candidate = await readCandidate(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ECANDIDATEMISSING") {
        return chain; // a seed: no candidate record, nothing above it
      }
      throw error;
    }
    pendingChange = candidate.change;
    current = candidate.parent_genome_id;
  }
}

/**
 * Find a Genome bundle by its declared id.
 *
 * Bundles live one level under the root, each in its own directory; the id is
 * what `genome.json` declares, not the directory name, so a bundle can be moved
 * or renamed without breaking a lineage.
 */
export async function defaultResolveGenomeDir(
  genomesRoot: string,
  genomeId: string,
): Promise<string | null> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(genomesRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(genomesRoot, entry.name);
    try {
      const genome = JSON.parse(await readFile(join(dir, "genome.json"), "utf8"));
      if (genome.genome_id === genomeId) return dir;
    } catch {
      // Not a Genome bundle; keep looking.
    }
  }
  return null;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}
