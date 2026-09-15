/**
 * Trial materialization, reset, and identity.
 *
 * Materialization turns a fixture into a runnable trial: an agent-visible
 * workspace, a private evaluation package, and manifests that record exactly
 * what the trial is. Reset restores the agent view to its initial state and
 * proves it by digest.
 *
 * Three properties are load-bearing here and are tested as such:
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
 *   Reset is exact. The initial workspace digest is recorded at materialization
 *   and re-derived after every reset; a reset that cannot reproduce it fails
 *   loudly rather than silently drifting the baseline.
 *
 * The `agent` and `private` directories are a structural classification for
 * now, not an enforced boundary. The agent process runs in the same container
 * as the evaluator, and `cwd` is not a sandbox: an agent with file tools may
 * read outside its workspace. Enforcing that is a separate, later concern.
 */
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

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
  /** Digest over the evaluation package; tampering shows up at reset time. */
  evaluatorDigest: string;
  /** Digest over the trial contract: fixture, task, limits, environment. */
  trialIdentity: string;
  readonly manifests: Record<ManifestName, string>;
}

export type ManifestName = "fixture" | "taskIdentity" | "environmentIdentity" | "trial";

export class TrialAlreadyExistsError extends Error {
  readonly code = "ETRIALEXISTS";
}
export class ResetDriftError extends Error {
  readonly code = "ERESETDRIFT";
}

/** Names a directory, so it cannot be used to escape the runs root. */
const TRIAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** A byte that separates fields in digest material; never a valid file byte. */
const SEP = Buffer.from([0]);

export function trialLayout(runsDir: string, trialId: string): TrialLayout {
  const root = resolve(runsDir, trialId);
  return {
    root,
    agent: join(root, "agent"),
    agentWorkspace: join(root, "agent", "workspace"),
    privateDir: join(root, "private"),
    evaluator: join(root, "private", "evaluator"),
    manifests: join(root, "manifests"),
  };
}

/**
 * Digest a directory tree over content and relative names only.
 *
 * Files are hashed individually, then the sequence of (name, hash) pairs is
 * hashed in sorted order, so the result does not depend on directory
 * enumeration order or on where the tree happens to be. An empty directory
 * contributes nothing, so two trees differing only in empty directories share
 * a digest — acceptable, since an agent cannot read an empty directory.
 */
export async function digestTree(root: string): Promise<{ digest: string; files: string[] }> {
  const files: string[] = [];
  await walk(root, "", async (rel) => files.push(rel));
  files.sort();
  const hash = createHash("sha256");
  for (const rel of files) {
    const content = await readFile(join(root, ...rel.split("/")));
    hash.update(rel, "utf8");
    hash.update(SEP);
    hash.update(createHash("sha256").update(content).digest("hex"), "utf8");
    hash.update(SEP);
  }
  return { digest: hash.digest("hex"), files };
}

async function walk(
  root: string,
  relDir: string,
  visit: (rel: string) => Promise<void> | void,
): Promise<void> {
  const dir = relDir === "" ? root : join(root, ...relDir.split("/"));
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = relDir === "" ? entry.name : `${relDir}/${entry.name}`;
    if (entry.isDirectory()) {
      await walk(root, rel, visit);
    } else if (entry.isFile()) {
      await visit(rel);
    }
    // Symlinks are neither followed nor hashed: a fixture is plain files, and
    // a symlink would make the digest depend on something outside the tree.
  }
}

/**
 * Digest of the trial contract. Changes to the task inputs, the workspace, the
 * limits, the network profile, or the environment all change it; the paths of
 * the fixture and the run directory never do.
 */
export function trialIdentity(input: {
  fixtureId: string;
  fixtureVersion: number;
  taskDigest: string;
  networkProfile: NetworkProfile;
  maxAgentTurns: number;
  maxWallSeconds: number;
  environmentIdentity?: string;
}): string {
  const material = [
    "evocfd-trial-identity/v1",
    `fixture=${input.fixtureId}@${input.fixtureVersion}`,
    `task=${input.taskDigest}`,
    `profile=${input.networkProfile}`,
    `turns=${input.maxAgentTurns}`,
    `wall=${input.maxWallSeconds}`,
    `environment=${input.environmentIdentity ?? "uncharacterized"}`,
  ].join("\n");
  return createHash("sha256").update(material).digest("hex").slice(0, 16);
}

/**
 * Materialize a pristine trial from a fixture.
 *
 * The source fixture is only ever read. The trial directory must not already
 * exist, because a trial that is re-materialized over its own history is not a
 * pristine trial.
 */
export async function materializeFixture(input: {
  fixture: LoadedFixture;
  trialId: string;
  runsDir: string;
  environment?: TrialEnvironment;
}): Promise<MaterializedTrial> {
  if (!TRIAL_ID_PATTERN.test(input.trialId)) {
    throw new Error(`trial id ${JSON.stringify(input.trialId)} is not a plain directory name`);
  }
  const layout = trialLayout(input.runsDir, input.trialId);
  if (await pathExists(layout.root)) {
    throw new TrialAlreadyExistsError(`trial ${input.trialId} already exists at ${layout.root}`);
  }

  const { fixture } = input;
  const def = fixture.definition;

  await mkdir(layout.agentWorkspace, { recursive: true });
  await mkdir(layout.evaluator, { recursive: true });
  await mkdir(layout.manifests, { recursive: true });

  // Agent view: the workspace tree, and the prompt beside it — never inside it,
  // so the agent cannot delete or rewrite the prompt it is being scored on.
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
      { task_identity: task.digest, algorithm: "sha256-over-sorted-name-and-content", files: task.files },
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

  return {
    trialId: input.trialId,
    fixtureId: fixture.id,
    layout,
    taskDigest: task.digest,
    workspaceDigest: workspace.digest,
    evaluatorDigest: evaluator.digest,
    trialIdentity: identity,
    manifests,
  };
}

/**
 * Reset the agent view to the exact initial state.
 *
 * Everything under `agent/` is discarded and rebuilt from the fixture, then
 * the fresh digests are checked against the ones recorded at materialization.
 * A mismatch means the fixture itself changed, or that the trial's private
 * state was tampered with — either way the baseline is no longer what the
 * trial claims to be, and that must not pass silently.
 *
 * The private side is deliberately untouched: reset concerns only what the
 * agent may have changed.
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

  await rm(layout.agent, { recursive: true, force: true });
  await mkdir(layout.agentWorkspace, { recursive: true });
  await cp(fixture.workspaceSource, layout.agentWorkspace, { recursive: true });
  await cp(fixture.promptPath, join(layout.agent, "TASK.md"));

  const task = await digestTree(layout.agent);
  const workspace = await digestTree(layout.agentWorkspace);
  const evaluator = await digestTree(layout.evaluator);

  const drift: string[] = [];
  if (expected.taskDigest && expected.taskDigest !== task.digest) {
    drift.push(`task digest ${expected.taskDigest} -> ${task.digest}`);
  }
  if (expected.workspaceDigest && expected.workspaceDigest !== workspace.digest) {
    drift.push(`workspace digest ${expected.workspaceDigest} -> ${workspace.digest}`);
  }
  // The private side is not rebuilt by reset, so a mismatch here means the
  // evaluation package was altered after materialization.
  if (expected.evaluatorDigest && expected.evaluatorDigest !== evaluator.digest) {
    drift.push(`evaluator digest ${expected.evaluatorDigest} -> ${evaluator.digest}`);
  }
  if (drift.length > 0) {
    throw new ResetDriftError(`reset of ${layout.root} did not reproduce the initial state: ${drift.join("; ")}`);
  }
  return { taskDigest: task.digest, workspaceDigest: workspace.digest };
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
