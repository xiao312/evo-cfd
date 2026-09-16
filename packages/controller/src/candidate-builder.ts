/**
 * Deterministic construction of a candidate harness from a proposal.
 *
 * The proposer hypothesizes; this module builds. The separation is the whole
 * point: an agent that could turn its own proposal into a published candidate
 * could publish anything, and a candidate that was never validated against the
 * runtime that has to run it is a directory with a hash on it.
 *
 * Construction is a transaction with a fixed set of allowed effects. Given a
 * proposal and a parent bundle it either produces a candidate whose every
 * changed file is on the allowlist and whose every identity claim is verified
 * against the actual bytes, or it produces nothing at all — the staging
 * directory is removed, so a failed construction leaves no partial candidate
 * for a later run to find and half-trust.
 *
 * Identity is the load-bearing part. A candidate record asserts who its parent
 * is and who it is. Those are claims, and claims are cheap; the builder
 * recomputes both from the bundles as they actually stand and refuses to
 * publish a record whose claims do not match its recomputation. That is the
 * difference between a lineage that is asserted and one that is checked.
 */
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";

import {
  buildHarnessSnapshot,
  defaultResolveGenomeDir,
  harnessIdentity,
  readCandidate,
  type CandidateRecord,
  type HarnessBase,
  type HarnessSnapshot,
} from "./harness.ts";
import { digestFileMap, digestTree } from "./snapshot.ts";
import { EVIDENCE_DIR, PROPOSER_OUTPUT_DIR } from "./evidence.ts";
import { readJudgement as readJudgementFromEvaluator } from "./evaluate.ts";
import { PROPOSAL_FILE, validateProposal, type HarnessProposal } from "./proposal.ts";
import type { Judgement } from "./evaluate.ts";

export class CandidateBuildError extends Error {
  readonly code = "ECANDIDATEBUILD";
}

/** Where the controller's contract templates live, relative to the repo root. */
const SKILLS_CONTRACT_TEMPLATE = join("config", "genome-templates", "skills-contract.md");

/**
 * The files a skill change may touch, relative to the bundle root. `genome.json`
 * is on every allowlist because becoming a candidate means taking a new id and a
 * parent, which is a manifest change; the skill's own content file is on every
 * allowlist because that *is* the change. What is never on one: the solver, the
 * evaluator, the model, the provider, or any component other than `skills`.
 */
export function allowedFiles(kind: "skill_upsert" | "skill_modify", skill: string): Set<string> {
  const skillFile = `skills/${skill}/SKILL.md`;
  if (kind === "skill_modify") {
    return new Set(["genome.json", skillFile]);
  }
  return new Set(["genome.json", "components/skills.json", skillFile, "contracts/skills.dev.md"]);
}

/**
 * The outcome of a construction attempt. `no_change` and `duplicate` are
 * outcomes, not failures: a proposer that found nothing to change has done its
 * job, and an identical candidate already exists is the *correct* thing to
 * discover rather than a second directory for one harness.
 */
export type CandidateConstruction =
  | { kind: "no_change"; proposal: HarnessProposal }
  | { kind: "duplicate"; record: CandidateRecord; genomeDir: string }
  | { kind: "built"; record: CandidateRecord; genomeDir: string; changedFiles: string[] }
  | { kind: "rejected"; reason: string; proposal?: HarnessProposal };

/** What the builder needs: where things are, not how to run them. */
export interface CandidateBuildContext extends HarnessBase {
  repoRoot: string;
  genomesRoot: string;
  /** Where the pinned RSI-Harness checkout lives, for validation. */
  rsihDir: string;
  /**
   * Directory of the proposer's own Genome, the instrument that produced the
   * proposal. Its identity is recorded on every candidate, and it is *not* a
   * member of the lineage it reviews. Defaults to
   * `<repoRoot>/genomes/evocfd-proposer`.
   */
  proposerGenomeDir?: string;
  /**
   * Load a candidate bundle through the harness runtime. Defaults to
   * `rsih genome validate`, and is overridable so the construction logic can be
   * tested without a pinned checkout — and so a test can assert on the exact
   * bundle that was validated rather than only on its exit status.
   */
  validateBundle?: (input: {
    rsihDir: string;
    genomeDir: string;
    genomeId: string;
  }) => Promise<void>;
}

/**
 * Build a candidate from a recorded proposal, or report why none was built.
 *
 * Every step is ordered so that the expensive and the risky come after the
 * cheap and the safe: the proposal is validated before any file is touched,
 * the parent is resolved and snapshotted before anything is copied, and the
 * candidate is validated, diffed and identity-checked before it is published.
 */
export async function buildCandidate(input: {
  context: CandidateBuildContext;
  /** Proposal run root, e.g. runs/proposal-001. */
  runRoot: string;
  /** Genome id of the harness to improve, e.g. `evocfd:m1-baseline`. */
  parentGenomeId: string;
  /** Episode that produced the proposal, for the lineage record. */
  proposerEpisodeId: string;
  /** Where staged work happens; defaults to the OS temp directory. */
  stagingRoot?: string;
  now?: () => Date;
}): Promise<CandidateConstruction> {
  let proposal: HarnessProposal | undefined;
  try {
    proposal = await readProposal(input.runRoot);
  } catch (error) {
    if (error instanceof CandidateBuildError) {
      // A proposal that cannot even be parsed is a rejection the caller can
      // report, not an exception they have to catch: the builder's contract is
      // to say why nothing was built, in every case where nothing was.
      return { kind: "rejected", reason: error.message };
    }
    throw error;
  }
  if (proposal.decision === "no_change") {
    return { kind: "no_change", proposal };
  }

  const parentDir = await defaultResolveGenomeDir(input.context.genomesRoot, input.parentGenomeId);
  if (parentDir === null) {
    return {
      kind: "rejected",
      reason: `parent Genome ${input.parentGenomeId} is not present under ${input.context.genomesRoot}`,
      proposal,
    };
  }

  // The parent is snapshotted from its real bytes. The identity the record
  // claims as its parent is *this* value, never a string the proposal
  // supplied, so a lineage claim is recomputed rather than trusted.
  const parentSnapshot = await buildHarnessSnapshot({
    genomeDir: parentDir,
    agentConfigDir: input.context.agentConfigDir,
    rsihRevision: input.context.rsihRevision,
    piVersion: input.context.piVersion,
  });
  const parentIdentity = harnessIdentity(parentSnapshot);

  // The parent must be untouched by construction. Its file map is taken before
  // any copy is made and compared again before publishing, so a builder bug that
  // wrote into the parent is caught rather than silently inherited.
  const parentBefore = await digestFileMap(parentDir, ["candidate.json"]);

  // The evidence the proposal cites is verified before anything is built, so a
  // proposal resting on a claim with no support is refused at the door.
  const evidenceRoot = join(input.runRoot, EVIDENCE_DIR);
  const grounding = await groundEvidenceRefs({
    evidenceRoot,
    proposal,
  });
  if (grounding !== null) {
    return { kind: "rejected", reason: grounding, proposal };
  }

  // Staging happens on the *destination* filesystem, because `rename` across
  // filesystems fails with EXDEV and a tmpdir is not generally the same volume
  // as the Genome tree. Defaulting here rather than at the call sites means a
  // caller cannot reintroduce a cross-device move by forgetting an override.
  const stagingRoot = input.stagingRoot ?? join(input.context.genomesRoot, ".staging");
  await mkdir(stagingRoot, { recursive: true });
  const staging = await mkdtemp(join(stagingRoot, "evocfd-candidate-"));
  try {
    const candidateDir = join(staging, "genome");
    await cp(parentDir, candidateDir, { recursive: true });

    // The id carries a short digest of exactly what varies between two
    // candidates of the same skill: the parent, the kind, the skill and the
    // proposed content. Two proposals that differ in any of those get different
    // ids and can coexist; the full harness identity, not this suffix, remains
    // authoritative for equality.
    const contentDigest = candidateContentDigest(parentIdentity, proposal);
    const candidateGenomeId = `${input.parentGenomeId}--${proposal.skill}--${contentDigest}`;

    const createdComponent = await applySkillChange({
      candidateDir,
      proposal,
      repoRoot: input.context.repoRoot,
      parentGenomeId: input.parentGenomeId,
      candidateGenomeId,
    });

    // The candidate is validated by the same RSI-Harness that runs trials,
    // before any identity is computed from it. A bundle that cannot load is
    // not a candidate, whatever its digest says.
    await (input.context.validateBundle ?? validateBundleWithRsih)({
      rsihDir: input.context.rsihDir,
      genomeDir: candidateDir,
      genomeId: candidateGenomeId,
    });;

    const candidateSnapshot = await buildHarnessSnapshot({
      genomeDir: candidateDir,
      agentConfigDir: input.context.agentConfigDir,
      rsihRevision: input.context.rsihRevision,
      piVersion: input.context.piVersion,
    });
    const candidateIdentity = harnessIdentity(candidateSnapshot);

    if (candidateSnapshot.genome_id !== candidateGenomeId) {
      throw new CandidateBuildError(
        `the candidate bundle declares ${candidateSnapshot.genome_id}, expected ${candidateGenomeId}`,
      );
    }
    if (candidateIdentity === parentIdentity) {
      return {
        kind: "rejected",
        reason: "the candidate harness is identical to its parent; the proposal changed nothing",
        proposal,
      };
    }

    // A duplicate is a candidate with the *same harness identity*, not the same
    // skill name. Two proposals for one skill that propose different content
    // are different candidates and must be able to coexist — otherwise the
    // loop could never revisit a skill it had already touched. Only an exact
    // identity match is the same harness twice.
    const existing = await findCandidateByIdentity(input.context.genomesRoot, candidateIdentity);
    if (existing !== null) {
      return { kind: "duplicate", record: existing.record, genomeDir: existing.genomeDir };
    }
    // The content-derived id is unique by construction; a directory already
    // occupying it without the matching identity is a contradiction, not a
    // duplicate.
    const idConflict = await defaultResolveGenomeDir(input.context.genomesRoot, candidateGenomeId);
    if (idConflict !== null) {
      throw new CandidateBuildError(
        `a Genome at ${idConflict} occupies the id ${candidateGenomeId} but is not this candidate`,
      );
    }

    const changed = await diffBundles(parentDir, candidateDir);
    assertAllowedChanges(proposal.kind, proposal.skill, createdComponent, changed);

    // The record is written after every check, so it can only ever describe a
    // bundle that passed all of them. `candidate.json` is excluded from the
    // bundle's own digest — a file containing its own identity could not be
    // written without changing it.
    const record: CandidateRecord = {
      candidate_genome_id: candidateGenomeId,
      parent_genome_id: input.parentGenomeId,
      parent_harness_identity: parentIdentity,
      candidate_harness_identity: candidateIdentity,
      proposer_harness_identity: await proposerIdentity(input),
      change: {
        kind: proposal.kind,
        skill: proposal.skill,
        rationale: proposal.rationale,
        proposer_episode: input.proposerEpisodeId,
      },
      // A candidate is `proposed` the moment it exists. Becoming `activated` is
      // a separate act that requires trials of its own, and this function does
      // not have that evidence and must not pretend to it.
      status: "proposed",
      created_at: (input.now ?? (() => new Date()))().toISOString(),
    };
    await writeFile(join(candidateDir, "candidate.json"), JSON.stringify(record, null, 2) + "\n");

    // The parent is verified untouched as the last structural step, so even a
     // mid-construction failure leaves the lineage's base intact.
    const parentAfter = await digestFileMap(parentDir, ["candidate.json"]);
    if (parentAfter.size !== parentBefore.size) {
      throw new CandidateBuildError(
        `construction changed the parent Genome at ${parentDir}; refusing to publish a candidate built against a changed parent`,
      );
    }
    for (const [name, digest] of parentAfter) {
      if (parentBefore.get(name) !== digest) {
        throw new CandidateBuildError(
          `construction modified ${name} in the parent Genome at ${parentDir}`,
        );
      }
    }

    const published = join(input.context.genomesRoot, candidateGenomeId.replaceAll(":", "-"));
    await mkdir(input.context.genomesRoot, { recursive: true });
    await rename(candidateDir, published);

    return { kind: "built", record, genomeDir: published, changedFiles: changed };
  } catch (error) {
    if (error instanceof CandidateBuildError) {
      return { kind: "rejected", reason: error.message, proposal };
    }
    throw error;
  } finally {
    // Every path out of this block — built, duplicate, rejected, or thrown —
    // removes its staging directory, including the early returns that used to
    // leave one behind. After a successful publish the directory is already
    // empty, so this is a no-op there.
    await rm(staging, { recursive: true, force: true });
  }
}

/**
 * Apply one skill change to a staged copy of the parent bundle.
 *
 * Deterministic: the same proposal against the same parent always produces the
 * same bytes, which is what makes a digest meaningful and what makes a repeat
 * construction detectable as a duplicate rather than as a new candidate.
 *
 * Because the seed Genome carries no skills component, the first `skill_upsert`
 * from it creates the component as well as the skill — a candidate cannot
 * register a skill in a component that does not exist, and the contract the
 * component references has to be a real file or RSI-Harness will not load the
 * bundle.
 *
 * Returns the set of files the change was *expected* to touch, which the caller
 * checks against the files it actually did.
 */
async function applySkillChange(input: {
  candidateDir: string;
  proposal: Extract<HarnessProposal, { decision: "propose" }>;
  repoRoot: string;
  parentGenomeId: string;
  candidateGenomeId: string;
}): Promise<Set<string>> {
  const manifestPath = join(input.candidateDir, "genome.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    components: Array<{ id: string; source?: string; contract?: string }>;
    version?: number;
  };
  const touched = new Set<string>();

  const skillsComponent = manifest.components.find((component) => component.id === "skills");
  const skillEntry = { source: `./skills/${input.proposal.skill}`, enabled: true };
  // Bundle-relative paths are always written with `/` so they compare equal to
  // what the digest map reports on every platform.
  const skillFile = `skills/${input.proposal.skill}/SKILL.md`;
  const skillPath = join(input.candidateDir, skillFile);

  if (input.proposal.kind === "skill_modify") {
    if (skillsComponent === undefined) {
      throw new CandidateBuildError(
        `skill_modify of ${input.proposal.skill} is impossible: the parent Genome has no skills component`,
      );
    }
    const registered = await readSkillsConfig(
      resolve(input.candidateDir, skillsComponent.source ?? ""),
    );
    if (!registered.skills.some((entry) => entry.source === skillEntry.source)) {
      throw new CandidateBuildError(
        `skill_modify of ${input.proposal.skill} is impossible: the parent Genome does not register that skill`,
      );
    }
    if ((await readFile(skillPath, "utf8").catch(() => null)) === null) {
      throw new CandidateBuildError(
        `skill_modify of ${input.proposal.skill} is impossible: the parent Genome declares the skill but ships no SKILL.md`,
      );
    }
    await mkdir(dirname(skillPath), { recursive: true });
    await writeFile(skillPath, input.proposal.skill_content);
    touched.add(skillFile);
  } else {
    await mkdir(dirname(skillPath), { recursive: true });
    await writeFile(skillPath, input.proposal.skill_content);
    touched.add(skillFile);

    if (skillsComponent === undefined) {
      // The first skill has to bring the component with it. The contract is
       // copied from the controller's template rather than composed here, so
       // the policy a candidate is held to is the one the repository ships, and
       // a change to it is a visible repository change rather than a builder
       // secret.
      const contractTemplate = join(input.repoRoot, SKILLS_CONTRACT_TEMPLATE);
      const contractText = await readFile(contractTemplate, "utf8").catch(() => null);
      if (contractText === null) {
        throw new CandidateBuildError(
          `the skills contract template is missing at ${contractTemplate}; the repository setup is incomplete`,
        );
      }
      const contractFile = "contracts/skills.dev.md";
      await mkdir(join(input.candidateDir, "contracts"), { recursive: true });
      await writeFile(join(input.candidateDir, contractFile), contractText);
      touched.add(contractFile);

      const componentFile = "components/skills.json";
      await mkdir(join(input.candidateDir, "components"), { recursive: true });
      await writeFile(
        join(input.candidateDir, componentFile),
        JSON.stringify(
          {
            component_schema_version: "1",
            component_id: "skills",
            config: { skills: [skillEntry] },
          },
          null,
          2,
        ) + "\n",
      );
      touched.add(componentFile);

      manifest.components.push({
        id: "skills",
        source: `./${componentFile}`,
        contract: `./${contractFile}`,
      });
    } else {
      // The component exists. An upsert that targets a skill the parent already
      // registers is a modify wearing an upsert's label, and the two have
      // different provenance: `upsert` means the harness gained a capability it
      // never had. Refusing keeps the lineage interpretable.
      const configPath = resolve(input.candidateDir, skillsComponent.source ?? "");
      const registered = await readSkillsConfig(configPath);
      if (registered.skills.some((entry) => entry.source === skillEntry.source)) {
        throw new CandidateBuildError(
          `skill_upsert of ${input.proposal.skill} is impossible: the parent Genome already registers that skill; use skill_modify to replace it`,
        );
      }
      const skills = registered.skills.filter((entry) => entry.source !== skillEntry.source);
      skills.push(skillEntry);
      // Awaited: the candidate is snapshotted, validated and published
      // immediately after this returns, so a fire-and-forget write could land
      // after the bundle was already read — or not at all.
      await registered.writeSkills(skills);
      touched.add(relativeBundlePath(input.candidateDir, configPath));
    }
  }

  // The candidate's own identity and parentage. `parent_id` is what a lineage
  // walk follows, and `version` is bumped so a human reading the chain can
  // tell one candidate from the seed it came from.
  manifest.genome_id = input.candidateGenomeId;
  manifest.parent_id = input.parentGenomeId;
  manifest.version = (manifest.version ?? 1) + 1;
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  touched.add("genome.json");

  return touched;
}

interface SkillsConfig {
  skills: Array<{ source: string; enabled: boolean }>;
  writeSkills: (skills: Array<{ source: string; enabled: boolean }>) => Promise<void>;
}

async function readSkillsConfig(configPath: string): Promise<SkillsConfig> {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    throw new CandidateBuildError(
      `the skills component config at ${configPath} is not readable: ${(error as Error).message}`,
    );
  }
  const config = (raw.config ?? raw) as { skills?: unknown };
  if (!Array.isArray(config.skills)) {
    throw new CandidateBuildError(`the skills component config at ${configPath} has no skills array`);
  }
  return {
    skills: config.skills as Array<{ source: string; enabled: boolean }>,
    writeSkills: async (skills) => {
      config.skills = skills;
      await writeFile(configPath, JSON.stringify(raw, null, 2) + "\n");
    },
  };
}

function relativeBundlePath(bundleDir: string, absolutePath: string): string {
  return resolve(absolutePath).slice(resolve(bundleDir).length + 1).split("\\").join("/");
}

/**
 * Verify that every changed file is one the change kind permits.
 *
 * The allowlist is per kind, because a `skill_modify` that also rewrote
 * `components/skills.json` would be an unbounded change wearing a bounded
 * label. An unexpected file is a builder fault — it means the construction did
 * something the contract does not describe — so it throws rather than being
 * reported as a rejection.
 */
function assertAllowedChanges(
  kind: "skill_upsert" | "skill_modify",
  skill: string,
  expected: Set<string>,
  actual: string[],
): void {
  const allowed = allowedFiles(kind, skill);
  for (const file of actual) {
    if (!allowed.has(file)) {
      throw new CandidateBuildError(
        `construction changed ${file}, which a ${kind} change is not permitted to touch`,
      );
    }
  }
  for (const file of expected) {
    if (!actual.includes(file)) {
      throw new CandidateBuildError(
        `construction was expected to change ${file} but did not; the builder and the change disagree`,
      );
    }
  }
}

/** Relative file names that differ between two bundles, sorted and deduped. */
async function diffBundles(parentDir: string, candidateDir: string): Promise<string[]> {
  const parent = await digestFileMap(parentDir, ["candidate.json"]);
  const candidate = await digestFileMap(candidateDir, ["candidate.json"]);
  const changed: string[] = [];
  for (const [name, digest] of candidate) {
    if (parent.get(name) !== digest) changed.push(name);
  }
  for (const name of parent.keys()) {
    if (!candidate.has(name)) changed.push(name);
  }
  return [...new Set(changed)].sort();
}

/** A byte separator between hashed fields, so no two fields can concatenate ambiguously. */
const SEP = Buffer.from([0]);

/**
 * A short digest of exactly what distinguishes two candidates of the same
 * skill from the same parent: the kind, the skill name and the proposed
 * content. It names the directory; it is *not* the harness identity, which
 * covers the whole bundle and remains the authority for equality. Naming by
 * content is what lets a loop revisit a skill it already touched without the
 * second attempt being mistaken for the first.
 */
export function candidateContentDigest(
  parentIdentity: string,
  proposal: Extract<HarnessProposal, { decision: "propose" }>,
): string {
  const hash = createHash("sha256");
  hash.update(parentIdentity, "utf8");
  hash.update(SEP);
  hash.update(proposal.kind, "utf8");
  hash.update(SEP);
  hash.update(proposal.skill, "utf8");
  hash.update(SEP);
  hash.update(proposal.skill_content, "utf8");
  return hash.digest("hex").slice(0, 8);
}

/**
 * Find an existing candidate whose recorded harness identity equals the one
 * given. Duplicate means "the same harness", never "the same skill name".
 */
async function findCandidateByIdentity(
  genomesRoot: string,
  identity: string,
): Promise<{ record: CandidateRecord; genomeDir: string } | null> {
  let entries: string[];
  try {
    entries = await readdir(genomesRoot, { withFileTypes: true })
      .then((dirs) => dirs.filter((entry) => entry.isDirectory()).map((entry) => entry.name));
  } catch {
    return null;
  }
  for (const name of entries) {
    const dir = join(genomesRoot, name);
    try {
      const record = await readCandidate(dir);
      if (record.candidate_harness_identity === identity) {
        return { record, genomeDir: dir };
      }
    } catch {
      // A directory with no readable candidate record is not a candidate and
      // cannot be a duplicate of anything.
    }
  }
  return null;
}

/** What an evidence reference is allowed to point at. */
const EVIDENCE_KINDS = ["episode", "evaluation", "task", "trial-manifest"] as const;

/**
 * Verify that every evidence reference a proposal cites is a real artifact the
 * proposer was actually given.
 *
 * The proposer is told that a reference which does not resolve is a claim with
 * no support; this is where that promise is enforced by something that cannot
 * be talked out of it. A reference must be relative, must stay inside the
 * package, must exist, and must name an evidence artifact rather than the
 * package's own bookkeeping. A proposal to change the harness must rest on at
 * least one *trial* artifact: reading the parent Genome is not evidence of a
 * deficiency, so references under `parent/` do not count as support.
 *
 * Returns null when the proposal is grounded, or the reason it is not.
 */
async function groundEvidenceRefs(input: {
  evidenceRoot: string;
  proposal: HarnessProposal;
}): Promise<string | null> {
  const refs = input.proposal.evidence_refs;
  if (refs.length === 0 && input.proposal.decision === "propose") {
    return "a proposal must cite at least one evidence reference";
  }

  let trialRefs = 0;
  const citedTrials = new Set<string>();
  for (const ref of refs) {
    if (isAbsolute(ref)) {
      return `the evidence reference ${JSON.stringify(ref)} is absolute; references must be relative to the evidence package`;
    }
    if (ref.includes("..")) {
      return `the evidence reference ${JSON.stringify(ref)} escapes the evidence package`;
    }
    // Normalize away any platform separator before resolving.
    const normalized = sep === "\\" ? ref.split("\\").join("/") : ref;
    if (!normalized.startsWith("evidence/") && !normalized.startsWith("parent/")) {
      return `the evidence reference ${JSON.stringify(ref)} is not under evidence/ or parent/`;
    }
    const resolved = resolve(input.evidenceRoot, normalized);
    const relativeInside = relative(input.evidenceRoot, resolved);
    if (relativeInside.startsWith("..")) {
      return `the evidence reference ${JSON.stringify(ref)} escapes the evidence package`;
    }
    if (!(await pathExists(resolved))) {
      return `the evidence reference ${JSON.stringify(ref)} does not resolve inside the evidence package`;
    }

    if (normalized.startsWith("evidence/")) {
      const parts = normalized.slice("evidence/".length).split("/");
      const trialId = parts[0];
      const kind = parts[1];
      if (!EVIDENCE_KINDS.includes(kind as (typeof EVIDENCE_KINDS)[number])) {
        return `the evidence reference ${JSON.stringify(ref)} names ${kind}, which is not a trial artifact`;
      }
      trialRefs += 1;
      citedTrials.add(trialId);
    }
  }

  if (input.proposal.decision === "propose") {
    if (trialRefs === 0) {
      return (
        "a proposal must cite at least one trial artifact under evidence/; " +
        "references to the parent Genome describe what is being changed, not why"
      );
    }
    // A mutation must rest on trials that were actually judged. Which artifact
    // of a trial a proposal cites is arbitrary — an episode log carries the
    // behaviour, the evaluation carries the verdict — so the judgment is looked
    // up per *trial*, not per reference. "I have not looked yet" is not
    // "no change needed", and a candidate built from unjudged evidence would be
    // compared as though a verdict had said something. A task that *failed* is
    // judged evidence and counts: the criterion is whether a trustworthy
    // judgement exists, not whether it passed.
    const unjudged: string[] = [];
    for (const trialId of citedTrials) {
      const judgement = await readJudgement(
        join(input.evidenceRoot, "evidence", trialId, "evaluation", "result.json"),
      );
      if (!judgement.judged) {
        unjudged.push(`${trialId} (${judgement.reason ?? "no trustworthy judgement"})`);
      }
    }
    if (unjudged.length > 0) {
      return (
        `the proposal cites trials with no trustworthy judgement: ${unjudged.join("; ")}. ` +
        "A mutation must rest on judged evidence; an evaluation that could not obtain a verdict supports no conclusion"
      );
    }
  }
  return null;
}

/**
 * Load a Genome bundle through the pinned RSI-Harness.
 *
 * Validation is not optional and not approximated: the bundle is loaded by the
 * same code path a trial uses, so a candidate that cannot be run is refused
 * here rather than discovered mid-experiment. `rsih genome validate` exits
 * non-zero with a message on stderr when a bundle is malformed, a component
 * is missing, or a contract path does not resolve.
 */
async function validateBundleWithRsih(input: {
  rsihDir: string;
  genomeDir: string;
  genomeId: string;
}): Promise<void> {
  const cli = join(input.rsihDir, "src", "cli.ts");
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", cli, "genome", "validate", input.genomeDir],
    { encoding: "utf8", windowsHide: true },
  );
  if (result.status !== 0) {
    throw new CandidateBuildError(
      `RSI-Harness rejected the candidate Genome ${input.genomeId}: ${(result.stderr ?? "").trim()}`,
    );
  }
}

/** Read and validate the proposal file of a run. */
export async function readProposal(runRoot: string): Promise<HarnessProposal> {
  // The proposal arrives through the proposer's only writable path, which is
  // private/output on the host side; a file anywhere else would mean the
  // proposer wrote somewhere it was never given.
  const proposalPath = join(runRoot, PROPOSER_OUTPUT_DIR, PROPOSAL_FILE);
  let raw: string;
  try {
    raw = await readFile(proposalPath, "utf8");
  } catch (error) {
    throw new CandidateBuildError(`no proposal at ${proposalPath}: ${(error as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new CandidateBuildError(`the proposal file is not valid JSON: ${(error as Error).message}`);
  }
  try {
    return validateProposal(parsed);
  } catch (error) {
    throw new CandidateBuildError(`the proposal is not constructible: ${(error as Error).message}`);
  }
}

/** Read a judgement through the evaluator's own contract, never a re-approximation. */
async function readJudgement(resultPath: string): Promise<Judgement> {
  return readJudgementFromEvaluator(resultPath);
}

/**
 * The identity of the harness that produced the proposal. The proposer runs
 * under its own Genome, outside the lineage it reviews, so this is resolved
 * from the context's proposer directory rather than from the parent or the
 * candidate. A candidate is only auditable if the instrument that measured the
 * evidence is recorded with it.
 */
async function proposerIdentity(input: {
  context: CandidateBuildContext;
}): Promise<string> {
  const dir = input.context.proposerGenomeDir ?? join(input.context.repoRoot, "genomes", "evocfd-proposer");
  const snapshot = await buildHarnessSnapshot({
    genomeDir: dir,
    agentConfigDir: input.context.agentConfigDir,
    rsihRevision: input.context.rsihRevision,
    piVersion: input.context.piVersion,
  });
  return harnessIdentity(snapshot);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}
