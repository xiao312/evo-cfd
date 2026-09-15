/**
 * Fixture loading and validation tests.
 *
 * Validation is what makes a fixture relocatable and safe to rerun, so it is
 * tested as a contract rather than as an error path: a fixture that cannot be
 * understood must fail at load, listing every problem, before anything is
 * copied anywhere.
 *
 * Run with: node --experimental-strip-types --test test/*.test.ts
 */
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FIXTURE_SCHEMA_VERSIONS,
  FixtureValidationError,
  loadFixture,
  loadFixtureById,
  resolveWithin,
} from "../src/fixtures.ts";

const REPO_ROOT = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const REAL_FIXTURE = join(REPO_ROOT, "fixtures", "control-plane-001");

/** A complete, valid fixture definition. Callers break one field at a time. */
function goodDefinition(overrides: object = {}) {
  return {
    fixture_id: "probe",
    version: 1,
    task: { prompt: "TASK.md" },
    workspace: { source: "workspace" },
    evaluation: { source: "evaluator" },
    trial: { network_profile: "llm-only", max_agent_turns: 5, max_wall_seconds: 60 },
    ...overrides,
  };
}

/**
 * Build a fixture in `dir`. `files` maps a relative path to content; the
 * standard layout is created unless `files` says otherwise.
 */
async function writeFixture(
  dir: string,
  definition: object,
  files: Record<string, string> = {},
): Promise<void> {
  await mkdir(join(dir, "workspace"), { recursive: true });
  await mkdir(join(dir, "evaluator"), { recursive: true });
  const defaults: Record<string, string> = {
    "fixture.json": JSON.stringify(definition),
    "TASK.md": "probe task\n",
    "workspace/app.js": "console.log('hello');\n",
    "evaluator/check.mjs": "process.exit(0);\n",
  };
  for (const [path, content] of Object.entries({ ...defaults, ...files })) {
    const target = join(dir, ...path.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}

let staging: string;

test.before(async () => {
  staging = await mkdtemp(join(tmpdir(), "evocfd-fixtures-"));
});

test.after(async () => {
  await rm(staging, { recursive: true, force: true });
});

test("the shipped fixture loads and resolves every source", async () => {
  const fixture = await loadFixture(REAL_FIXTURE);
  assert.equal(fixture.id, "control-plane-001");
  assert.equal(fixture.version, FIXTURE_SCHEMA_VERSIONS[0]);
  assert.equal(fixture.definition.trial.network_profile, "llm-only");
  assert.equal(fixture.promptPath, join(REAL_FIXTURE, "TASK.md"));
  assert.equal(fixture.workspaceSource, join(REAL_FIXTURE, "workspace"));
  assert.equal(fixture.evaluationSource, join(REAL_FIXTURE, "evaluator"));
});

test("a well-formed fixture loads", async () => {
  const dir = join(staging, "well-formed");
  await writeFixture(dir, goodDefinition({ fixture_id: "well-formed" }));
  const fixture = await loadFixture(dir);
  assert.equal(fixture.id, "well-formed");
  assert.deepEqual(fixture.definition.task, { prompt: "TASK.md" });
});

test("a fixture whose id disagrees with its directory is rejected", async () => {
  const dir = join(staging, "renamed");
  await writeFixture(dir, goodDefinition({ fixture_id: "something-else" }));
  await assert.rejects(
    () => loadFixture(dir),
    (error: unknown) =>
      error instanceof FixtureValidationError &&
      error.problems.some((p) => p.includes("must match the containing directory")),
  );
});

test("an unknown schema version is rejected, listing the known ones", async () => {
  const dir = join(staging, "bad-version");
  await writeFixture(dir, goodDefinition({ fixture_id: "bad-version", version: 99 }));
  await assert.rejects(
    () => loadFixture(dir),
    (error: unknown) =>
      error instanceof FixtureValidationError &&
      error.problems.some((p) => p.includes("version") && p.includes("not supported")),
  );
});

test("a missing version is rejected as unknown", async () => {
  const dir = join(staging, "noversion");
  const def = goodDefinition();
  delete (def as { version?: number }).version;
  await writeFixture(dir, def);
  await assert.rejects(() => loadFixture(dir), FixtureValidationError);
});

test("every required field is checked at once", async () => {
  const dir = join(staging, "broken");
  await writeFixture(dir, {
    fixture_id: "broken",
    task: {},
    workspace: {},
    evaluation: {},
    trial: {},
  });
  await assert.rejects(
    () => loadFixture(dir),
    (error: unknown) => {
      if (!(error instanceof FixtureValidationError)) return false;
      // A single load reports all five missing fields, not just the first.
      const text = error.problems.join(" ");
      return (
        text.includes("task.prompt") &&
        text.includes("workspace.source") &&
        text.includes("evaluation.source") &&
        text.includes("network_profile") &&
        text.includes("max_agent_turns") &&
        text.includes("max_wall_seconds")
      );
    },
  );
});

test("a network profile outside the allowed set is rejected", async () => {
  const dir = join(staging, "bad-profile");
  await writeFixture(
    dir,
    goodDefinition({
      fixture_id: "bad-profile",
      trial: { network_profile: "open-internet", max_agent_turns: 5, max_wall_seconds: 60 },
    }),
  );
  await assert.rejects(
    () => loadFixture(dir),
    (error: unknown) =>
      error instanceof FixtureValidationError && error.problems.some((p) => p.includes("network_profile")),
  );
});

test("non-positive limits are rejected", async () => {
  const dir = join(staging, "zero-turns");
  await writeFixture(
    dir,
    goodDefinition({ trial: { network_profile: "offline", max_agent_turns: 0, max_wall_seconds: 60 } }),
  );
  await assert.rejects(
    () => loadFixture(dir),
    (error: unknown) =>
      error instanceof FixtureValidationError && error.problems.some((p) => p.includes("max_agent_turns")),
  );

  const dir2 = join(staging, "negative-wall");
  await writeFixture(
    dir2,
    goodDefinition({ trial: { network_profile: "offline", max_agent_turns: 5, max_wall_seconds: -1 } }),
  );
  await assert.rejects(
    () => loadFixture(dir2),
    (error: unknown) =>
      error instanceof FixtureValidationError && error.problems.some((p) => p.includes("max_wall_seconds")),
  );
});

test("unreachable fixture.json is a validation error, not an fs exception", async () => {
  const dir = join(staging, "empty");
  await mkdir(dir, { recursive: true });
  await assert.rejects(
    () => loadFixture(dir),
    (error: unknown) => error instanceof FixtureValidationError && error.code === "EFIXTUREINVALID",
  );
});

test("malformed fixture.json is reported as JSON, not as a crash", async () => {
  const dir = join(staging, "badjson");
  await writeFixture(dir, goodDefinition(), { "fixture.json": "{ not json " });
  await assert.rejects(
    () => loadFixture(dir),
    (error: unknown) => error instanceof FixtureValidationError && error.problems[0].includes("not valid JSON"),
  );
});

test("a source that names a missing file is rejected", async () => {
  const dir = join(staging, "probe");
  await writeFixture(dir, goodDefinition({ task: { prompt: "MISSING.md" } }));
  await assert.rejects(
    () => loadFixture(dir),
    (error: unknown) => error instanceof FixtureValidationError && error.problems.some((p) => p.includes("MISSING.md")),
  );
});

test("a source that names a file where a directory is expected is rejected", async () => {
  const dir = join(staging, "probe");
  await writeFixture(dir, goodDefinition({ workspace: { source: "TASK.md" } }));
  await assert.rejects(
    () => loadFixture(dir),
    (error: unknown) => error instanceof FixtureValidationError && error.problems.some((p) => p.includes("not a directory")),
  );
});

test("an absolute source path is rejected", async () => {
  const dir = join(staging, "absolute-path");
  const absolute = join(dir, "TASK.md");
  await writeFixture(dir, goodDefinition({ fixture_id: "absolute-path", task: { prompt: absolute } }));
  await assert.rejects(
    () => loadFixture(dir),
    (error: unknown) => error instanceof FixtureValidationError && error.problems.some((p) => p.includes("must be relative")),
  );
});

test("a source that escapes the fixture directory is rejected", async () => {
  const dir = join(staging, "escape");
  await writeFixture(dir, goodDefinition({ fixture_id: "escape", evaluation: { source: "../outside" } }));
  await assert.rejects(
    () => loadFixture(dir),
    (error: unknown) =>
      error instanceof FixtureValidationError && error.problems.some((p) => p.includes("escapes the fixture")),
  );
});

test("a traversal that resolves back inside is allowed", async () => {
  // resolve(root, "workspace/../TASK.md") is still inside the fixture.
  const inside = resolveWithin(join(staging, "traversal-ok"), "workspace/../TASK.md");
  assert.equal(inside, join(staging, "traversal-ok", "TASK.md"));
});

test("loadFixtureById resolves a fixture by id", async () => {
  const fixture = await loadFixtureById(join(REPO_ROOT, "fixtures"), "control-plane-001");
  assert.equal(fixture.id, "control-plane-001");
});

test("loadFixtureById refuses an id that is not a flat identifier", async () => {
  const root = join(REPO_ROOT, "fixtures");
  for (const id of ["../RSI-Harness", "sub/dir", ".hidden", "has spaces"]) {
    await assert.rejects(
      () => loadFixtureById(root, id),
      (error: unknown) =>
        error instanceof FixtureValidationError && error.problems.some((p) => p.includes("flat identifier")),
    );
  }
});

test("a fixture_id containing a path separator is rejected", async () => {
  const dir = join(staging, "path-separator");
  await writeFixture(dir, goodDefinition({ fixture_id: "a/b" }));
  await assert.rejects(
    () => loadFixture(dir),
    (error: unknown) =>
      error instanceof FixtureValidationError && error.problems.some((p) => p.includes("flat identifier")),
  );
});

test("a top-level JSON document that is not an object is rejected", async () => {
  const dir = join(staging, "not-an-object");
  await writeFixture(dir, goodDefinition(), { "fixture.json": "[1, 2, 3]" });
  await assert.rejects(
    () => loadFixture(dir),
    (error: unknown) =>
      error instanceof FixtureValidationError && error.problems[0].includes("JSON object at the top level"),
  );
});

test("a symbolic link in the workspace is rejected", async (t: TestContext) => {
  const dir = join(staging, "symlinked");
  await writeFixture(dir, goodDefinition({ fixture_id: "symlinked" }));
  // A link inside the workspace points outside the fixture. `stat` would follow
  // it and the reachable content would not match any recorded digest.
  await writeFile(join(staging, "outside-secret.txt"), "not part of the fixture\n");
  if (!(await trySymlink(t, join(staging, "outside-secret.txt"), join(dir, "workspace", "leak.txt")))) return;
  await assert.rejects(
    () => loadFixture(dir),
    (error: unknown) =>
      error instanceof FixtureValidationError &&
      error.problems.some((p) => p.includes("leak.txt") && p.includes("symbolic link")),
  );
});

test("a symlinked directory in the evaluation package is rejected", async (t: TestContext) => {
  const dir = join(staging, "symlinked-evaluator");
  await mkdir(join(staging, "outside-evaluator"), { recursive: true });
  await writeFile(join(staging, "outside-evaluator", "check.mjs"), "process.exit(0);\n");
  await writeFixture(dir, goodDefinition({ fixture_id: "symlinked-evaluator" }));
  await rm(join(dir, "evaluator"), { recursive: true, force: true });
  if (!(await trySymlink(t, join(staging, "outside-evaluator"), join(dir, "evaluator")))) return;
  await assert.rejects(
    () => loadFixture(dir),
    (error: unknown) => error instanceof FixtureValidationError && error.problems.some((p) => p.includes("symbolic link")),
  );
});

test("a symlinked prompt file is rejected", async (t: TestContext) => {
  const dir = join(staging, "symlinked-prompt");
  await writeFixture(dir, goodDefinition({ fixture_id: "symlinked-prompt" }));
  await rm(join(dir, "TASK.md"));
  if (!(await trySymlink(t, join(dir, "workspace", "README.md"), join(dir, "TASK.md")))) return;
  await assert.rejects(
    () => loadFixture(dir),
    (error: unknown) =>
      error instanceof FixtureValidationError && error.problems.some((p) => p.includes("symbolic link")),
  );
});

/** Create a link, or skip the test on volumes that cannot create one. */
async function trySymlink(t: TestContext, target: string, path: string): Promise<boolean> {
  try {
    await symlink(target, path);
    return true;
  } catch (error) {
    t.skip(`symbolic links are not supported on this volume (${(error as NodeJS.ErrnoException).code})`);
    return false;
  }
}
