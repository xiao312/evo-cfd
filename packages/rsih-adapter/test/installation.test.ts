import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  resolveInstallation,
  InstallationNotFoundError,
  InvalidInstallationError,
  defaultInstallationRoot,
} from "../src/index.ts";

/** Build a fake RSI-Harness checkout in a fresh temporary directory. */
async function makeFakeRsih(
  options: { name?: string; withCli?: boolean; withGit?: boolean; deps?: boolean } = {},
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "evocfd-rsih-"));
  const pkg: Record<string, unknown> = { name: options.name ?? "rsih", version: "0.1.0" };
  if (options.deps) {
    pkg.dependencies = { "@earendil-works/pi-coding-agent": "0.84.3" };
  }
  await writeFile(join(root, "package.json"), JSON.stringify(pkg));
  if (options.withCli ?? true) {
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "cli.ts"), "// fake entrypoint\n");
  }
  if (options.withGit) {
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: "EvoCFD Test",
      GIT_AUTHOR_EMAIL: "test@evocfd.invalid",
      GIT_COMMITTER_NAME: "EvoCFD Test",
      GIT_COMMITTER_EMAIL: "test@evocfd.invalid",
    };
    execFileSync("git", ["init", "-q"], { cwd: root, env });
    execFileSync("git", ["add", "-A"], { cwd: root, env });
    execFileSync("git", ["commit", "-q", "-m", "fake"], { cwd: root, env });
  }
  return root;
}

test("resolves a valid default checkout", async () => {
  const root = await makeFakeRsih({ withGit: true, deps: true });
  const installation = resolveInstallation({ defaultRoot: root });
  assert.equal(installation.root, root);
  assert.equal(installation.source, "default");
  assert.match(installation.revision ?? "", /^[0-9a-f]{40}$/);
  assert.equal(installation.piVersion, "0.84.3");
  await rm(root, { recursive: true, force: true });
});

test("RSIH_ROOT takes precedence over the default location", async () => {
  const override = await makeFakeRsih();
  const installation = resolveInstallation({
    rsihRoot: override,
    defaultRoot: "/nonexistent-default",
  });
  assert.equal(installation.source, "RSIH_ROOT");
  assert.equal(installation.root, override);
  await rm(override, { recursive: true, force: true });
});

test("falls back to the default location when RSIH_ROOT is unset", async () => {
  const root = await makeFakeRsih();
  assert.equal(resolveInstallation({ defaultRoot: root }).root, root);
  await rm(root, { recursive: true, force: true });
});

test("rejects a relative RSIH_ROOT", () => {
  assert.throws(
    () => resolveInstallation({ rsihRoot: "relative/rsih", defaultRoot: "/nonexistent" }),
    (error: Error) =>
      error instanceof InstallationNotFoundError && /absolute path/.test(error.message),
  );
});

test("reports a missing checkout with an actionable message", () => {
  assert.throws(
    () => resolveInstallation({ defaultRoot: join(tmpdir(), "evocfd-does-not-exist") }),
    (error: Error) =>
      error instanceof InstallationNotFoundError && /No RSI-Harness checkout found/.test(error.message),
  );
});

test("rejects a directory whose package.json is not RSI-Harness", async () => {
  const root = await makeFakeRsih({ name: "something-else" });
  assert.throws(
    () => resolveInstallation({ defaultRoot: root }),
    (error: Error) =>
      error instanceof InvalidInstallationError &&
      /expected "rsih"/.test(error.message) &&
      error.problems.length === 1,
  );
  await rm(root, { recursive: true, force: true });
});

test("rejects a checkout missing its entrypoint", async () => {
  const root = await makeFakeRsih({ withCli: false });
  assert.throws(
    () => resolveInstallation({ defaultRoot: root }),
    (error: Error) =>
      error instanceof InvalidInstallationError && /missing expected file: src\/cli.ts/.test(error.message),
  );
  await rm(root, { recursive: true, force: true });
});

test("rejects a checkout with malformed package.json", async () => {
  const root = await mkdtemp(join(tmpdir(), "evocfd-rsih-"));
  await writeFile(join(root, "package.json"), "{ this is not json");
  assert.throws(
    () => resolveInstallation({ defaultRoot: root }),
    (error: Error) =>
      error instanceof InvalidInstallationError && /not valid JSON/.test(error.message),
  );
  await rm(root, { recursive: true, force: true });
});

test("a checkout without git metadata resolves with a null revision", async () => {
  const root = await makeFakeRsih();
  const installation = resolveInstallation({ defaultRoot: root });
  assert.equal(installation.revision, null);
  await rm(root, { recursive: true, force: true });
});

test("piVersion is null when RSI-Harness declares no Pi dependency", async () => {
  const root = await makeFakeRsih();
  assert.equal(resolveInstallation({ defaultRoot: root }).piVersion, null);
  await rm(root, { recursive: true, force: true });
});

test("defaultInstallationRoot points at third_party under this repo", () => {
  // The adapter lives in packages/rsih-adapter/src; the default checkout is
  // <repo>/third_party/RSI-Harness.
  assert.match(defaultInstallationRoot(), /third_party[\\/]+RSI-Harness$/);
});
