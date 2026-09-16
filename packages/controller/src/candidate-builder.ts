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
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

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
import { PROPOSAL_FILE, validateProposal, type HarnessProposal } from "./proposal.ts";

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
function allowedFiles(kind: "skill_upsert" | "skill_modify", skill: string): Set<string> {
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
   * Load a candidate bundle through the harness runtime. Defaults to
   * `rsih genome validate`, and is overridable so the construction logic can be
   * tested without a pinned checkout — and so a test can assert on the exact
   * bundle that was validated rather than only on its exit status.
   */
  validateBundle?: (genomeDir: string, genomeId: string) => Promise<void>;
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

  const stagingRoot = input.stagingRoot ?? tmpdir();
  await mkdir(stagingRoot, { recursive: true });
  const staging = await mkdtemp(join(stagingRoot, "evocfd-candidate-"));
  try {
    const candidateDir = join(staging, "genome");
    await cp(parentDir, candidateDir, { recursive: true });

    const candidateGenomeId = `${input.parentGenomeId}--${proposal.skill}`;
    const existing = await defaultResolveGenomeDir(input.context.genomesRoot, candidateGenomeId);
    if (existing !== null) {
      // An identical candidate already exists. Building a second one would
      // give the comparison step two directories for one harness, so the
      // existing record is returned and the caller decides what to do.
      try {
        const record = await readCandidate(existing);
        return { kind: "duplicate", record, genomeDir: existing };
      } catch {
        return {
          kind: "rejected",
          reason: `a Genome named ${candidateGenomeId} already exists but carries no candidate record`,
          proposal,
        };
      }
    }

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
    });

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
    await rm(staging, { recursive: true, force: true });

    return { kind: "built", record, genomeDir: published, changedFiles: changed };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    if (error instanceof CandidateBuildError) {
      return { kind: "rejected", reason: error.message, proposal };
    }
    throw error;
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
      // The component exists; the skill is added to it, replacing an entry for
      // the same source if one is there, so an upsert is idempotent.
      const configPath = resolve(input.candidateDir, skillsComponent.source ?? "");
      const registered = await readSkillsConfig(configPath);
      const skills = registered.skills.filter((entry) => entry.source !== skillEntry.source);
      skills.push(skillEntry);
      registered.writeSkills(skills);
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
  let raw: string;
  try {
    raw = await readFile(join(runRoot, "private", PROPOSAL_FILE), "utf8");
  } catch (error) {
    throw new CandidateBuildError(
      `no proposal at ${join(runRoot, "private", PROPOSAL_FILE)}: ${(error as Error).message}`,
    );
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
