/**
 * Fixture definition: loading and validation.
 *
 * A fixture is an executable environment, not a prompt. It bundles the task
 * text the agent sees, the workspace the agent may change, the evaluation
 * package the agent must not see, and the trial limits — including the network
 * profile, because information access is part of the environment a trial runs
 * in, not a label on its metadata.
 *
 * Validation happens here rather than at use time, so a malformed fixture
 * fails at load with every problem listed at once instead of failing halfway
 * through materialization with a half-built trial directory.
 *
 * Paths inside a fixture are relative to the fixture directory and are
 * validated to stay there. This is not a security boundary — the agent runs in
 * the same container as the evaluator for now — but it is what makes a fixture
 * relocatable: no manifest or identity may depend on where the fixture happens
 * to sit on disk.
 *
 * Fixture inputs are plain files and directories only. A symbolic link would
 * make the content an agent can reach differ from the content a digest was
 * computed over, which is exactly the invariant identity exists to hold.
 */
import { basename, isAbsolute, relative, resolve } from "node:path";
import { lstat, readdir, readFile, stat } from "node:fs/promises";

/** Schema versions this implementation understands. */
export const FIXTURE_SCHEMA_VERSIONS = [1] as const;
export type FixtureSchemaVersion = (typeof FIXTURE_SCHEMA_VERSIONS)[number];

export type NetworkProfile = "offline" | "llm-only" | "llm+web";

export const NETWORK_PROFILES: readonly NetworkProfile[] = ["offline", "llm-only", "llm+web"];

/**
 * A fixture id names a directory, and nothing more. It is a flat identifier,
 * never a path: allowing a slash or a `..` here would let a fixture id escape
 * the fixtures root, and fixture ids do not need to be hierarchical.
 */
export const FIXTURE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * The on-disk shape of `fixture.json`. Deliberately small: task, workspace,
 * evaluation, and trial settings. Anything an agent must not see belongs under
 * `evaluation`, never under `workspace`.
 */
export interface FixtureDefinition {
  fixture_id: string;
  version: FixtureSchemaVersion;
  task: { prompt: string };
  workspace: { source: string };
  evaluation: { source: string };
  trial: {
    network_profile: NetworkProfile;
    max_agent_turns: number;
    max_wall_seconds: number;
  };
}

/** A fixture that has been loaded and validated, with its location resolved. */
export interface LoadedFixture {
  /** Value of `fixture_id`; also the name of the containing directory. */
  id: string;
  /** Absolute directory the fixture was loaded from. Never recorded as identity. */
  dir: string;
  version: FixtureSchemaVersion;
  definition: FixtureDefinition;
  /** Absolute path of the prompt file the agent will be shown. */
  promptPath: string;
  /** Absolute path of the directory copied into the agent workspace. */
  workspaceSource: string;
  /** Absolute path of the evaluation package; never copied into the agent view. */
  evaluationSource: string;
}

export class FixtureValidationError extends Error {
  readonly code = "EFIXTUREINVALID";
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`invalid fixture: ${problems.join("; ")}`);
    this.name = "FixtureValidationError";
    this.problems = problems;
  }
}

/**
 * Resolve a path relative to a root and confirm it stays inside it. Rejects
 * absolute paths and any traversal that escapes the root, so `../../secret`
 * can never name a file outside the fixture no matter how it is written.
 */
export function resolveWithin(root: string, path: string): string {
  if (isAbsolute(path)) {
    throw new FixtureValidationError([`${JSON.stringify(path)} must be relative to the fixture directory`]);
  }
  const resolved = resolve(root, path);
  const rel = relative(root, resolved);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new FixtureValidationError([`${JSON.stringify(path)} escapes the fixture directory`]);
  }
  return resolved;
}

/** True if `path` exists and is a file or directory. A missing fixture input
 * is a validation problem, not an exception at copy time. */
async function existsAs(path: string, kind: "file" | "directory"): Promise<boolean> {
  try {
    const stats = await stat(path);
    return kind === "file" ? stats.isFile() : stats.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Walk a tree and reject any symbolic link found.
 *
 * Containment is checked lexically in `resolveWithin` and existence is checked
 * with `stat`, which follows links; without this pass a fixture could name
 * `workspace/data -> /somewhere/else` and the reachable content would not
 * match the recorded digest. Refusing links outright is more honest than
 * trying to define what a link ought to mean across filesystems.
 */
async function assertNoSymlinks(root: string, problems: string[], relDir = ""): Promise<void> {
  if (relDir === "") {
    // The root itself is never listed as an entry by readdir, and stat would
    // follow it, so check the link in place. A source that is not a directory
    // at all is reported by the existence checks, not here.
    try {
      const stats = await lstat(root);
      if (stats.isSymbolicLink()) {
        problems.push(
          `${basename(root)} is a symbolic link; fixture inputs must be plain files and directories`,
        );
        return;
      }
      if (!stats.isDirectory()) return;
    } catch {
      return;
    }
  }
  const dir = relDir === "" ? root : resolve(root, ...relDir.split("/"));
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = relDir === "" ? entry.name : `${relDir}/${entry.name}`;
    if (entry.isSymbolicLink()) {
      problems.push(`${rel} is a symbolic link; fixture inputs must be plain files and directories`);
    } else if (entry.isDirectory()) {
      await assertNoSymlinks(root, problems, rel);
    }
  }
}

/**
 * Load and validate a fixture from its directory.
 *
 * Every problem found is collected and reported together, so fixing a fixture
 * is one round trip rather than one per error.
 */
export async function loadFixture(dir: string): Promise<LoadedFixture> {
  const problems: string[] = [];
  let raw: string;
  try {
    raw = await readFile(resolve(dir, "fixture.json"), "utf8");
  } catch (error) {
    throw new FixtureValidationError([
      `cannot read fixture.json in ${dir}: ${(error as NodeJS.ErrnoException).message}`,
    ]);
  }

  let definition: unknown;
  try {
    definition = JSON.parse(raw);
  } catch (error) {
    throw new FixtureValidationError([
      `fixture.json is not valid JSON: ${(error as Error).message}`,
    ]);
  }
  // A JSON document that is not an object — an array, a string, a number —
  // parses fine and then fails every field check with confusing errors.
  if (typeof definition !== "object" || definition === null || Array.isArray(definition)) {
    throw new FixtureValidationError(["fixture.json must be a JSON object at the top level"]);
  }

  const d = definition as Partial<FixtureDefinition>;
  if (typeof d.fixture_id !== "string" || d.fixture_id.length === 0) {
    problems.push("fixture_id is required and must be a non-empty string");
  } else if (!FIXTURE_ID_PATTERN.test(d.fixture_id)) {
    problems.push(`fixture_id ${JSON.stringify(d.fixture_id)} must be a flat identifier matching ${FIXTURE_ID_PATTERN}`);
  } else if (d.fixture_id !== basename(resolve(dir))) {
    problems.push(
      `fixture_id ${JSON.stringify(d.fixture_id)} must match the containing directory name ${JSON.stringify(
        basename(resolve(dir)),
      )}`,
    );
  }
  if (!FIXTURE_SCHEMA_VERSIONS.includes(d.version as FixtureSchemaVersion)) {
    problems.push(
      `version ${JSON.stringify(d.version)} is not supported; known versions are ${FIXTURE_SCHEMA_VERSIONS.join(
        ", ",
      )}`,
    );
  }
  if (typeof d.task?.prompt !== "string" || d.task.prompt.length === 0) {
    problems.push("task.prompt is required and must be a non-empty relative path");
  }
  if (typeof d.workspace?.source !== "string" || d.workspace.source.length === 0) {
    problems.push("workspace.source is required and must be a non-empty relative path");
  }
  if (typeof d.evaluation?.source !== "string" || d.evaluation.source.length === 0) {
    problems.push("evaluation.source is required and must be a non-empty relative path");
  }
  if (!NETWORK_PROFILES.includes(d.trial?.network_profile as NetworkProfile)) {
    problems.push(
      `trial.network_profile ${JSON.stringify(
        d.trial?.network_profile,
      )} is not one of ${NETWORK_PROFILES.join(", ")}`,
    );
  }
  if (!Number.isInteger(d.trial?.max_agent_turns) || (d.trial?.max_agent_turns ?? 0) <= 0) {
    problems.push("trial.max_agent_turns is required and must be a positive integer");
  }
  if (!Number.isInteger(d.trial?.max_wall_seconds) || (d.trial?.max_wall_seconds ?? 0) <= 0) {
    problems.push("trial.max_wall_seconds is required and must be a positive integer");
  }
  if (problems.length > 0) throw new FixtureValidationError(problems);

  const def = d as FixtureDefinition;
  const promptPath = resolveWithin(dir, def.task.prompt);
  const workspaceSource = resolveWithin(dir, def.workspace.source);
  const evaluationSource = resolveWithin(dir, def.evaluation.source);

  if (!(await existsAs(promptPath, "file"))) problems.push(`task.prompt ${JSON.stringify(def.task.prompt)} is not a file`);
  if (!(await existsAs(workspaceSource, "directory"))) {
    problems.push(`workspace.source ${JSON.stringify(def.workspace.source)} is not a directory`);
  }
  if (!(await existsAs(evaluationSource, "directory"))) {
    problems.push(`evaluation.source ${JSON.stringify(def.evaluation.source)} is not a directory`);
  }
  // The prompt is a single file, so a link in that position is checked directly.
  if (await isSymlink(promptPath)) {
    problems.push(`task.prompt ${JSON.stringify(def.task.prompt)} is a symbolic link`);
  }
  await assertNoSymlinks(workspaceSource, problems);
  await assertNoSymlinks(evaluationSource, problems);
  if (problems.length > 0) throw new FixtureValidationError(problems);

  return {
    id: def.fixture_id,
    dir: resolve(dir),
    version: def.version,
    definition: def,
    promptPath,
    workspaceSource,
    evaluationSource,
  };
}

async function isSymlink(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Load `fixtures/<id>/`. The id is a flat identifier, never a path. */
export async function loadFixtureById(fixturesRoot: string, id: string): Promise<LoadedFixture> {
  if (!FIXTURE_ID_PATTERN.test(id)) {
    throw new FixtureValidationError([
      `fixture id ${JSON.stringify(id)} must be a flat identifier matching ${FIXTURE_ID_PATTERN}`,
    ]);
  }
  return loadFixture(resolve(fixturesRoot, id));
}
