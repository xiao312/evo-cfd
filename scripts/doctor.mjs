#!/usr/bin/env node
/**
 * Report the EvoCFD environment. Informational only: `doctor` describes the
 * environment and never fails a build on it. Use `npm run check` and
 * `npm run check:rsih` for pass/fail validation.
 *
 * Reports: the local runtime, the repository state, the recorded baseline in
 * cfd-baseline/baseline.json versus what is actually observed, the resolvable
 * RSI-Harness installation, whether it is excluded from git, and Docker.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, realpathSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = realpathSync(
  resolve(dirname(fileURLToPath(import.meta.url)), ".."),
);

// npm is npm.cmd on Windows and cannot be spawned without a shell there
// (CVE-2024-27980). The command is a fixed literal, so there is no injection
// surface and passing no args array avoids the shell-args deprecation warning.
const npmVersion = (() => {
  try {
    const result = spawnSync("npm --version", { shell: true, encoding: "utf8" });
    return result.status === 0 ? (result.stdout ?? "").trim() : null;
  } catch {
    return null;
  }
})();
const lines = [];
const say = (text = "") => lines.push(text);

say("EvoCFD environment");
say("==================");

say("\n[local runtime]");
say(`  node:     ${process.version}`);
say(`  npm:      ${npmVersion ?? "?"}`);
say(`  platform: ${process.platform} ${process.arch}`);

say("\n[repository]");
say(`  root: ${repoRoot}`);
const gitState = run("git", ["rev-parse", "HEAD"], repoRoot);
if (gitState) {
  say(`  commit: ${gitState}`);
  const status = run("git", ["status", "--porcelain"], repoRoot);
  say(`  clean:  ${status ? "no" : "yes"}`);
} else {
  say("  commit: not a git repository");
}

say("\n[workspace packages]");
say("  EvoCFD's packages import each other under their package names;");
say("  scripts/link-workspaces.mjs wires those into node_modules, and `npm run");
say("  check` runs it first. Links are expected after any checkout.");
const rootPkg = readJson(resolve(repoRoot, "package.json"));
if (!rootPkg?.workspaces) {
  say("  no workspaces field in package.json");
} else {
  for (const glob of rootPkg.workspaces) {
    for (const relative of expandGlob(glob, repoRoot)) {
      const target = resolve(repoRoot, relative);
      const name = readJson(resolve(target, "package.json"))?.name;
      if (!name) continue;
      const linkPath = resolve(repoRoot, "node_modules", ...name.split("/"));
      try {
        const points = realpathSync(linkPath) === realpathSync(target);
        say(`  ${name}: ${points ? "linked" : "present but not linked to " + relative}`);
      } catch {
        say(`  ${name}: MISSING (run npm run check to link)`);
      }
    }
  }
}

say("\n[baseline record]");
const baselinePath = resolve(repoRoot, "cfd-baseline/baseline.json");
const baseline = readJson(baselinePath);
if (!baseline) {
  say(`  no baseline.json at ${baselinePath}`);
} else {
  say(`  schema_version: ${baseline.schema_version ?? "?"}`);
  const runtime = baseline.agent_runtime ?? {};
  say(`  rsih_revision:  ${runtime.rsih_revision ?? "?"}`);
  say(`  pi_version:     ${runtime.pi_version ?? "?"}`);
  say(`  node_version:   ${runtime.node_version ?? "?"}`);

  say("\n[baseline drift]");
  const rsih = resolveRsih(repoRoot);
  const observed = observeRsih(rsih?.root);
  const drift = [];
  if (rsih && observed.revision !== runtime.rsih_revision) {
    drift.push(`rsih_revision: recorded ${runtime.rsih_revision}, observed ${observed.revision}`);
  }
  if (rsih && observed.piVersion !== runtime.pi_version) {
    drift.push(`pi_version: recorded ${runtime.pi_version}, observed ${observed.piVersion}`);
  }
  if (runtime.node_version && process.version.replace(/^v/, "") !== runtime.node_version) {
    drift.push(
      `node_version: recorded ${runtime.node_version}, running ${process.version} ` +
        "(expected to differ across machines; must match on the campaign host)",
    );
  }
  say(drift.length ? drift.map((d) => `  ! ${d}`).join("\n") : "  none");
}

say("\n[RSI-Harness]");
const rsih = resolveRsih(repoRoot);
if (!rsih) {
  say("  not resolvable (set RSIH_ROOT or populate third_party/RSI-Harness)");
} else {
  const observed = observeRsih(rsih.root);
  say(`  root:       ${rsih.root}`);
  say(`  resolved:   ${rsih.source}`);
  say(`  revision:   ${observed.revision}`);
  say(`  pi version: ${observed.piVersion}`);

  // The checkout must never be redistributed from this repository.
  const ignored = runOk("git", ["check-ignore", "-q", rsih.root], repoRoot);
  say(`  gitignored: ${ignored ? "yes" : "NO — this would redistribute third-party code"}`);
}

say("\n[docker]");
const dockerVersion = run("docker", ["--version"], repoRoot);
if (dockerVersion) {
  say(`  ${dockerVersion}`);
  const images = run("docker", ["images", "--format", "{{.Repository}}:{{.Tag}}"], repoRoot);
  const have = (images ?? "")
    .split("\n")
    .filter((line) => line.includes("evocfd-dev"));
  say(have.length ? `  image present: ${have.join(", ")}` : "  no evocfd-dev image present");
} else {
  say("  docker not available on this host");
}

say("");
process.stdout.write(lines.join("\n"));

function run(command, args, cwd) {
  try {
    const result = spawnSync(command, args, { cwd, encoding: "utf8" });
    if (result.status !== 0) return null;
    return (result.stdout ?? "").trim() || null;
  } catch {
    return null;
  }
}

// Like run(), but reports the exit status rather than the output: some checks
// (git check-ignore -q) communicate by exit code and print nothing at all.
function runOk(command, args, cwd) {
  try {
    const result = spawnSync(command, args, { cwd, encoding: "utf8" });
    return result.status === 0;
  } catch {
    return false;
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

// Expand a "packages/*" workspaces glob relative to the repository root.
function expandGlob(glob, root) {
  if (!glob.includes("*")) return [glob];
  const base = glob.slice(0, glob.indexOf("*"));
  return readdirSync(resolve(root, base), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => base + entry.name);
}

function resolveRsih(root) {
  const candidates = [];
  if (process.env.RSIH_ROOT) candidates.push([process.env.RSIH_ROOT, "RSIH_ROOT"]);
  candidates.push([
    resolve(root, "third_party/RSI-Harness"),
    "third_party/RSI-Harness (default)",
  ]);
  for (const [path, source] of candidates) {
    try {
      return { root: realpathSync(path), source };
    } catch {
      /* try next */
    }
  }
  return null;
}

function observeRsih(root) {
  if (!root) return { revision: "?", piVersion: "?" };
  const pkg = readJson(resolve(root, "package.json")) ?? {};
  return {
    revision: run("git", ["rev-parse", "HEAD"], root) ?? "unknown (no git metadata)",
    piVersion: pkg.dependencies?.["@earendil-works/pi-coding-agent"] ?? "?",
  };
}
