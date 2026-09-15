#!/usr/bin/env node
/**
 * Validate the external RSI-Harness installation.
 *
 * RSI-Harness is an optional external checkout. It is deliberately not part of
 * the public EvoCFD repository (see THIRD_PARTY.md), so resolution must work
 * when it is present and fail with a clear diagnostic when it is not.
 *
 * Resolution order:
 *   1. RSIH_ROOT environment variable
 *   2. <repo>/third_party/RSI-Harness
 *
 * No code is imported from RSI-Harness. It is inspected as data only.
 *
 * Usage:
 *   node scripts/check-rsih.mjs              # validate the installation
 *   node scripts/check-rsih.mjs --run-suite  # also run RSI-Harness's own checks
 */
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultRoot = resolve(repoRoot, "third_party/RSI-Harness");
const requestedRoot = process.env.RSIH_ROOT;
const runSuite = process.argv.includes("--run-suite");

function fail(message) {
  process.stderr.write(`FAIL — ${message}\n`);
  process.stderr.write(
    `\nRSI-Harness is an optional external checkout.\n` +
      `Set RSIH_ROOT to its root, or place it at:\n  ${defaultRoot}\n` +
      `See third_party/README.md.\n`,
  );
  process.exit(1);
}

function toCanonical(path) {
  try {
    return realpathSync(path);
  } catch (error) {
    fail(`RSI-Harness root is not readable: ${path} (${error.message})`);
  }
}

// A valid RSI-Harness checkout declares itself and has its runtime entrypoint.
const checks = [
  {
    name: "package.json",
    verify: (content) => {
      const pkg = JSON.parse(content);
      return pkg.name === "rsih"
        ? null
        : `package.json name is "${pkg.name}", expected "rsih"`;
    },
  },
  { name: "src/cli.ts", verify: () => null },
];

let root;
try {
  root = requestedRoot ? toCanonical(requestedRoot) : toCanonical(defaultRoot);
} catch {
  fail(
    requestedRoot
      ? `RSIH_ROOT (${requestedRoot}) does not exist`
      : `no RSI-Harness checkout found at ${defaultRoot}. Set RSIH_ROOT or ` +
          "populate third_party/RSI-Harness.",
  );
}

let pkg;
try {
  pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
} catch (error) {
  fail(`${root} has no readable package.json: ${error.message}`);
}

const problems = [];
for (const check of checks) {
  try {
    const problem = check.verify(readFileSync(resolve(root, check.name), "utf8"));
    if (problem) problems.push(`${check.name}: ${problem}`);
  } catch {
    problems.push(`missing expected file: ${check.name}`);
  }
}
if (problems.length > 0) {
  fail(`${root} is not a valid RSI-Harness checkout — ${problems.join("; ")}`);
}

// The git revision is recorded when available but is not required: a tarball
// import or a subtree export may legitimately have no .git directory.
let revision = "unknown (no git metadata)";
try {
  const git = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", windowsHide: true });
  if (git.status === 0 && git.stdout) revision = git.stdout.trim();
} catch {
  /* non-fatal */
}

const piVersion = pkg.dependencies?.["@earendil-works/pi-coding-agent"] ?? "unknown";

process.stdout.write(
  [
    "PASS — external RSI-Harness installation valid",
    `  root:       ${root}`,
    `  revision:   ${revision}`,
    `  pi version: ${piVersion} (as pinned by RSI-Harness)`,
    `  resolved:   ${requestedRoot ? "RSIH_ROOT" : "third_party/RSI-Harness (default)"}`,
  ].join("\n") + "\n",
);

if (!runSuite) {
  process.stdout.write(
    "\nChecked structure only. Use --run-suite to run its tests and build.\n",
  );
  process.exit(0);
}

process.stdout.write("\nRunning RSI-Harness's own checks...\n");
const suite = spawn("npm", ["run", "check"], { cwd: root, stdio: "inherit", windowsHide: true });
suite.on("close", (code) => {
  if (code !== 0) fail(`RSI-Harness's 'npm run check' exited with status ${code}`);
  process.stdout.write("\nPASS — installation and its own checks are healthy.\n");
  process.exit(0);
});
