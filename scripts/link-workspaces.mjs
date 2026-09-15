#!/usr/bin/env node
/**
 * Link the workspace packages into node_modules.
 *
 * EvoCFD has no external dependencies, so there is nothing for a package
 * manager to fetch: the only thing an install would do is link the workspace
 * packages into node_modules so one can import another. Doing it ourselves
 * keeps a checkout fully functional with no network access and no package
 * manager, which is what makes CI-fast infrastructure-free.
 *
 * A symlink on POSIX, a junction on Windows. Idempotent: a link that already
 * points at the right place is left alone.
 *
 * Note: this requires a filesystem that supports links. Tests run on the
 * compute host (POSIX) and in CI, not on a local exFAT volume.
 */
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const nodeModules = join(root, "node_modules");

/** Expand the "packages/*" style globs the workspaces field uses. */
function expand(glob) {
  if (!glob.includes("*")) return [glob];
  const base = glob.slice(0, glob.indexOf("*"));
  const dir = join(root, base);
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => base + entry.name);
}

let linked = 0;
for (const glob of pkg.workspaces ?? []) {
  for (const relative of expand(glob)) {
    const target = join(root, relative);
    let name;
    try {
      name = JSON.parse(readFileSync(join(target, "package.json"), "utf8")).name;
    } catch {
      console.warn(`skipping ${relative}: no readable package.json`);
      continue;
    }
    const linkPath = join(nodeModules, ...name.split("/"));
    const linkDir = dirname(linkPath);

    try {
      if (realpathSync(linkPath) === realpathSync(target)) {
        continue; // already linked correctly
      }
    } catch {
      /* not linked yet, or dangling */
    }
    if (exists(linkPath)) {
      rmSync(linkPath, { recursive: true, force: true });
    }
    mkdirSync(linkDir, { recursive: true });
    symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : "dir");
    linked += 1;
    console.log(`linked ${name} -> ${relative}`);
  }
}
if (linked === 0) console.log("workspace links already in place");

function exists(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}
