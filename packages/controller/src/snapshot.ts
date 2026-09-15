/**
 * Trial materialization, reset, and identity.
 *
 * Materialization turns a fixture into a runnable trial: an agent-visible
 * workspace, a private evaluation package, and manifests that record exactly
 * what the trial is. Reset restores the agent view to its initial state and
 * proves it by digest.
 *
 * Properties that are load-bearing here, and tested as such:
 *
 *   Identity is independent of location. Digests are computed over content and
 *   relative names only. The absolute path of the fixture or the run directory
 *   never enters a digest or a manifest, so the same fixture materialized into
 *   two different run roots yields the same task identity.
 *
 *   Identity is independent of secrets. It is built only from explicitly
 *   passed, non-secret fields. Process environment is not an input, so a
 *   credential set in the shell cannot leak into a manifest by accident.
 *
 *   Identity covers what judges the task. The evaluation package has its own
 *   digest and enters trial identity, because changing the evaluator changes
 *   what "success" means. Until harness and model identity exist, what this
 *   module calls a trial identity is really a fixture-execution identity; do
 *   not mistake it for the final trial identifier.
 *
 *   Reset is exact and non-destructive. The replacement agent view is built
 *   beside the old one and verified against the recorded baseline *before*
 *   anything is replaced, so a fixture that has drifted is detected with the
 *   previous state still intact.
 *
 *   Materialization is atomic. A trial is built in a staging directory and
 *   renamed into place only once every digest and manifest is written, so a
 *   crash mid-copy cannot leave a half-built trial that later runs refuse to
 *   overwrite.
 *
 * The `agent` and `private` directories are a structural classification for
 * now, not an enforced boundary. The agent process runs in the same container
 * as the evaluator, and `cwd` is not a sandbox: an agent with file tools may
 * read outside its workspace. Enforcing that is a separate, later concern.
 */
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { LoadedFixture, NetworkProfile } from "./fixtures.ts";

/** Where a trial lives. Every path is derived from `root`, nothing is global. */
export interface TrialLayout {
  /** Absolute trial directory, e.g. runs/trial-001. */
  root: string;
  /** Agent-visible: the prompt file and the workspace it may change. */
  agent: string;
  agentWorkspace: string;
  /** Agent-private: the evaluation package and anything else it must not see. */
  privateDir: string;
  evaluator: string;
  /** Recorded identity; written once at materialization. */
  manifests: string;
}

export interface TrialEnvironment {
  /**
   * Opaque environment identity from the egress package — profile, upstream,
   * service versions, container. Optional because materialization may run
   * before the egress services are characterized; the trial identity still
   * carries the fixture's own network profile either way.
   */
  readonly environment_identity?: string;
  /** Credential reference by name, e.g. `gateway-token:default`. Never a value. */
  readonly credential_ref?: string;
}

export interface MaterializedTrial {
  trialId: string;
  fixtureId: string;
  layout: TrialLayout;
  /** Digest over every agent-visible task input: the prompt plus the workspace. */
  taskDigest: string;
  /** Digest over the agent workspace alone; verified on every reset. */
  workspaceDigest: string;
  /** Digest over the evaluation package; enters trial identity and reset checks. */
  evaluatorDigest: string;
  /** Digest over the trial contract: fixture, task, evaluator, limits, environment. */
  trialIdentity: string;
  readonly manifests: Record<ManifestName, string>;
}

export type ManifestName = "fixture" | "taskIdentity" | "environmentIdentity" | "trial";

export interface TreeDigest {
  digest: string;
  files: string[];
  directories: string[];
}

export class TrialAlreadyExistsError extends Error {
  readonly code = "ETRIALEXISTS";
}
export class ResetDriftError extends Error {
  readonly code = "ERESETDRIFT";
}

/**
 * A trial id names a directory and nothing more: it is a flat identifier, never
 * a path, so it cannot be used to escape the runs root.
 */
const TRIAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function trialLayout(runsDir: string, trialId: string): TrialLayout {
  return layoutFor(resolve(runsDir, trialId));
}

function layoutFor(root: string): TrialLayout {
  return {
    root,
    agent: join(root, "agent"),
    agentWorkspace: join(root, "agent", "workspace"),
    privateDir: join(root, "private"),
    evaluator: join(root, "private", "evaluator"),
    manifests: join(root, "manifests"),
  };
}

/** A short form for display and log lines; never the recorded identifier. */
export function displayIdentity(identity: string): string {
  return identity.slice(0, 16);
}

/**
 * Digest of the trial contract. Changes to the task inputs, the evaluator, the
 * limits, the network profile, or the environment all change it; the paths of
 * the fixture and the run directory never do.
 *
 * The recorded form is the full digest. Shorten only for display.
 */
export function trialIdentity(input: {
  fixtureId: string;
  fixtureVersion: number;
  taskDigest: string;
  evaluatorDigest: string;
  networkProfile: NetworkProfile;
  maxAgentTurns: number;
  maxWallSeconds: number;
  environmentIdentity?: string;
}): string {
  const material = [
    "evocfd-trial-identity/v1",
    `fixture=${input.fixtureId}@${input.fixtureVersion}`,
    `task=${input.taskDigest}`,
    `evaluator=${input.evaluatorDigest}`,
    `profile=${input.networkProfile}`,
    `turns=${input.maxAgentTurns}`,
    `wall=${input.maxWallSeconds}`,
    `environment=${input.environmentIdentity ?? "uncharacterized"}`,
  ].join("\n");
  return createHash("sha256").update(material).digest("hex");
}

/**
 * Digest a directory tree over content and relative names only.
 *
 * Files are hashed individually, then the sequence of (name, hash) pairs is
 * hashed in sorted order, so the result does not depend on directory
 * enumeration order or on where the tree happens to be. Directory names are
 * included as observable state: an agent can see that an empty directory
 * exists, so two workspaces differing only by one should not share an
 * identity.
 *
 * Symbolic links are neither followed nor hashed — `loadFixture` refuses them,
 * and a link would make the digest depend on something outside the tree.
 */
export async function digestTree(root: string): Promise<TreeDigest> {
  const files: string[] = [];
  const directories: string[] = [];
  await walk(root, "", {
    onFile: (rel) => files.push(rel),
    onDirectory: (rel) => directories.push(rel),
  });
  files.sort();
  directories.sort();

  const hash = createHash("sha256");
  for (const rel of directories) {
    hash.update(`D:${rel}`, "utf8");
    hash.update(SEP);
  }
  for (const rel of files) {
    const content = await readFile(join(root, ...rel.split("/")));
    hash.update(`F:${rel}`, "utf8");
    hash.update(SEP);
    hash.update(createHash("sha256").update(content).digest("hex"), "utf8");
    hash.update(SEP);
  }
  return { digest: hash.digest("hex"), files, directories };
}

interface WalkVisitor {
  onFile: (rel: string) => void;
  onDirectory: (rel: string) => void;
}

async function walk(root: string, relDir: string, visitor: WalkVisitor): Promise<void> {
  const dir = relDir === "" ? root : join(root, ...relDir.split("/"));
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = relDir === "" ? entry.name : `${relDir}/${entry.name}`;
    if (entry.isDirectory()) {
      visitor.onDirectory(rel);
      await walk(root, rel, visitor);
    } else if (entry.isFile()) {
      visitor.onFile(rel);
    }
  }
}

/**
 * Materialize a pristine trial from a fixture.
 *
 * The source fixture is only ever read. Everything is built in a staging
 * directory and renamed into place only once every digest and manifest is
 * written, so a failure halfway through leaves no partial trial behind.
 */
export async function materializeFixture(input: {
  fixture: LoadedFixture;
  trialId: string;
  runsDir: string;
  environment?: TrialEnvironment;
}): Promise<MaterializedTrial> {
  const { fixture } = input;
  const def = fixture.definition;
  const finalRoot = resolve(input.runsDir, input.trialId);

  if (!TRIAL_ID_PATTERN.test(input.trialId)) {
    throw new Error(`trial id ${JSON.stringify(input.trialId)} is not a plain directory name`);
  }
  if (await pathExists(finalRoot)) {
    throw new TrialAlreadyExistsError(`trial ${input.trialId} already exists at ${finalRoot}`);
  }
  await mkdir(input.runsDir, { recursive: true });

  // Staging keeps the final path clean until the trial is complete.
  const staging = await mkdtemp(join(input.runsDir, ".materialize-"));
  try {
    const layout = layoutFor(staging);
    await mkdir(layout.agentWorkspace, { recursive: true });
    await mkdir(layout.evaluator, { recursive: true });
    await mkdir(layout.manifests, { recursive: true });

    // Agent view: the workspace tree, and the prompt beside it — never inside
    // it, so the agent cannot delete or rewrite the prompt it is scored on.
    await cp(fixture.workspaceSource, layout.agentWorkspace, { recursive: true });
    await cp(fixture.promptPath, join(layout.agent, "TASK.md"));

    // Private view: the evaluation package, copied outside the agent tree.
    await cp(fixture.evaluationSource, layout.evaluator, { recursive: true });

    const task = await digestTree(layout.agent);
    const workspace = await digestTree(layout.agentWorkspace);
    const evaluator = await digestTree(layout.evaluator);
    const identity = trialIdentity({
      fixtureId: fixture.id,
      fixtureVersion: fixture.version,
      taskDigest: task.digest,
      evaluatorDigest: evaluator.digest,
      networkProfile: def.trial.network_profile,
      maxAgentTurns: def.trial.max_agent_turns,
      maxWallSeconds: def.trial.max_wall_seconds,
      environmentIdentity: input.environment?.environment_identity,
    });

    const manifests = {
      fixture: join(layout.manifests, "fixture.json"),
      taskIdentity: join(layout.manifests, "task-identity.json"),
      environmentIdentity: join(layout.manifests, "environment-identity.json"),
      trial: join(layout.manifests, "trial.json"),
    };

    const trialManifest = {
      trial_id: input.trialId,
      fixture_id: fixture.id,
      fixture_version: fixture.version,
      task_identity: task.digest,
      workspace_digest: workspace.digest,
      evaluator_digest: evaluator.digest,
      trial_identity: identity,
      trial: def.trial,
      environment: {
        environment_identity: input.environment?.environment_identity ?? null,
        credential_ref: input.environment?.credential_ref ?? null,
      },
      // Absolute paths are operational, not identity. They are recorded so a run
      // can be located, and excluded from every digest above.
      layout: {
        agent: "agent",
        workspace: "agent/workspace",
        evaluator: "private/evaluator",
        manifests: "manifests",
      },
    };

    await writeFile(manifests.fixture, JSON.stringify({ ...def, loaded_from: fixture.id }, null, 2));
    await writeFile(
      manifests.taskIdentity,
      JSON.stringify(
        {
          task_identity: task.digest,
          algorithm: "sha256-over-sorted-names-and-content",
          files: task.files,
          directories: task.directories,
        },
        null,
        2,
      ),
    );
    await writeFile(
      manifests.environmentIdentity,
      JSON.stringify(
        {
          environment_identity: input.environment?.environment_identity ?? null,
          network_profile: def.trial.network_profile,
          upstream: null,
          credential_ref: input.environment?.credential_ref ?? null,
          note: "environment identity is computed by the egress package at run time; secrets are never recorded",
        },
        null,
        2,
      ),
    );
    await writeFile(manifests.trial, JSON.stringify(trialManifest, null, 2));

    // The trial is complete; take its final place. If something created the
    // final path in the meantime, the staged tree is discarded rather than
    // clobbering a trial that may already have history.
    if (await pathExists(finalRoot)) {
      throw new TrialAlreadyExistsError(`trial ${input.trialId} already exists at ${finalRoot}`);
    }
    await rename(staging, finalRoot);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }

  return {
    trialId: input.trialId,
    fixtureId: fixture.id,
    layout: layoutFor(finalRoot),
    // Reported from the tree that was actually installed, not from staging.
    taskDigest: await digestOf(join(finalRoot, "agent")),
    workspaceDigest: await digestOf(join(finalRoot, "agent", "workspace")),
    evaluatorDigest: await digestOf(join(finalRoot, "private", "evaluator")),
    trialIdentity: await recordedTrialIdentity(finalRoot),
    manifests: manifestPaths(finalRoot),
  };
}

/**
 * Reset the agent view to the exact initial state.
 *
 * The replacement is built beside the existing one, verified against the
 * digests recorded at materialization, and only then swapped in. A mismatch
 * means the fixture itself drifted, or that the trial's private state was
 * tampered with — either way the baseline is no longer what the trial claims
 * to be, and the previous agent state is left intact while that is reported.
 *
 * The private side is not rebuilt, but it is re-checked: a changed evaluator
 * means success no longer means what the trial records.
 */
export async function resetTrial(input: {
  fixture: LoadedFixture;
  layout: TrialLayout;
  expected?: Partial<Pick<MaterializedTrial, "taskDigest" | "workspaceDigest" | "evaluatorDigest">>;
}): Promise<{ taskDigest: string; workspaceDigest: string }> {
  const { fixture, layout } = input;
  const expected = input.expected ?? (await readTrialManifest(layout)).recorded;
  if (
    expected.taskDigest === undefined &&
    expected.workspaceDigest === undefined &&
    expected.evaluatorDigest === undefined
  ) {
    throw new ResetDriftError(
      `${layout.root} has no recorded baseline to reset against; was it materialized?`,
    );
  }

  // Check the private side before touching anything the agent may have changed.
  const evaluator = await digestTree(layout.evaluator);
  const drift: string[] = [];
  if (expected.evaluatorDigest && expected.evaluatorDigest !== evaluator.digest) {
    drift.push(`evaluator digest ${expected.evaluatorDigest} -> ${evaluator.digest}`);
  }

  // Build the replacement view in a sibling, then verify it in place.
  const staging = await mkdtemp(join(dirname(layout.root), ".reset-"));
  let built: { task: string; workspace: string };
  try {
    const stagingLayout = layoutFor(staging);
    await mkdir(stagingLayout.agentWorkspace, { recursive: true });
    await cp(fixture.workspaceSource, stagingLayout.agentWorkspace, { recursive: true });
    await cp(fixture.promptPath, join(stagingLayout.agent, "TASK.md"));
    built = {
      task: (await digestTree(stagingLayout.agent)).digest,
      workspace: (await digestTree(stagingLayout.agentWorkspace)).digest,
    };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }

  if (expected.taskDigest && expected.taskDigest !== built.task) {
    drift.push(`task digest ${expected.taskDigest} -> ${built.task}`);
  }
  if (expected.workspaceDigest && expected.workspaceDigest !== built.workspace) {
    drift.push(`workspace digest ${expected.workspaceDigest} -> ${built.workspace}`);
  }
  if (drift.length > 0) {
    // The old agent view is deliberately left in place: drift is a finding,
    // not something to destroy while reporting it.
    await rm(staging, { recursive: true, force: true });
    throw new ResetDriftError(`reset of ${layout.root} did not reproduce the initial state: ${drift.join("; ")}`);
  }

  // Swap: move the old view aside, install the new one, then delete the old.
  // Keeping a backup until the new one is in place avoids a window in which
  // the trial has no agent view at all.
  const previous = `${layout.agent}.prev`;
  await rm(previous, { recursive: true, force: true });
  if (await pathExists(layout.agent)) {
    await rename(layout.agent, previous);
  }
  try {
    await rename(join(staging, "agent"), layout.agent);
  } catch (error) {
    if (await pathExists(previous)) {
      await rename(previous, layout.agent);
    }
    throw error;
  }
  await rm(previous, { recursive: true, force: true });

  return { taskDigest: built.task, workspaceDigest: built.workspace };
}

/** Paths of the four manifests of a trial at `root`. */
function manifestPaths(root: string): Record<ManifestName, string> {
  const manifests = join(root, "manifests");
  return {
    fixture: join(manifests, "fixture.json"),
    taskIdentity: join(manifests, "task-identity.json"),
    environmentIdentity: join(manifests, "environment-identity.json"),
    trial: join(manifests, "trial.json"),
  };
}

async function digestOf(path: string): Promise<string> {
  return (await digestTree(path)).digest;
}

/** The trial identity a trial recorded for itself; the authoritative value. */
async function recordedTrialIdentity(root: string): Promise<string> {
  const raw = JSON.parse(await readFile(join(root, "manifests", "trial.json"), "utf8")) as {
    trial_identity?: string;
  };
  if (typeof raw.trial_identity !== "string" || raw.trial_identity.length === 0) {
    throw new Error(`trial at ${root} was materialized without recording a trial identity`);
  }
  return raw.trial_identity;
}

/** Read the digests a trial recorded about itself, for verification on reset. */
async function readTrialManifest(layout: TrialLayout): Promise<{
  recorded: Partial<Pick<MaterializedTrial, "taskDigest" | "workspaceDigest" | "evaluatorDigest">>;
}> {
  try {
    const raw = JSON.parse(await readFile(join(layout.manifests, "trial.json"), "utf8")) as {
      task_identity?: string;
      workspace_digest?: string;
      evaluator_digest?: string;
    };
    return {
      recorded: {
        taskDigest: raw.task_identity,
        workspaceDigest: raw.workspace_digest,
        evaluatorDigest: raw.evaluator_digest,
      },
    };
  } catch {
    // No readable manifest means there is no recorded baseline to reset against.
    return { recorded: {} };
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

/** A byte that separates fields in digest material; never a valid file byte. */
const SEP = Buffer.from([0]);
