/**
 * Resolve and validate an external RSI-Harness installation.
 *
 * RSI-Harness is an optional external checkout that EvoCFD drives through its
 * CLI; it is never imported and never redistributed (see THIRD_PARTY.md).
 * Resolution must therefore have two modes: succeed when the checkout is
 * present and healthy, and fail with an actionable message when it is not.
 *
 * Resolution order: an explicit `rsihRoot` (normally process.env.RSIH_ROOT)
 * first, then the default location under the repository's third_party/.
 *
 * The checkout is inspected as data only: package.json is read, and the
 * presence of the runtime entrypoint is checked. Nothing is executed from it.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** A resolved and validated RSI-Harness installation. */
export interface Installation {
  /** Canonical absolute path (symlinks resolved). */
  root: string;
  /** Which resolution path supplied the root. */
  source: "RSIH_ROOT" | "default";
  /** Git revision when the checkout has metadata, else null. */
  revision: string | null;
  /** The Pi version RSI-Harness pins in its own dependencies, else null. */
  piVersion: string | null;
}

export class InstallationNotFoundError extends Error {
  readonly code = "ENOINSTALL";
}

export class InvalidInstallationError extends Error {
  readonly code = "EINVALID";
  readonly problems: string[];
  constructor(problems: string[], root: string) {
    super(`${root} is not a valid RSI-Harness checkout — ${problems.join("; ")}`);
    this.problems = problems;
  }
}

/** Inputs, given explicitly so the resolver is a pure function of them. */
export interface ResolveOptions {
  /** Explicit override, normally process.env.RSIH_ROOT. */
  rsihRoot?: string;
  /** Default location, normally <repo>/third_party/RSI-Harness. */
  defaultRoot: string;
}

/**
 * Resolve and validate the installation. Throws InstallationNotFoundError when
 * no checkout exists at all, or InvalidInstallationError when something exists
 * but is not RSI-Harness.
 */
export function resolveInstallation(options: ResolveOptions): Installation {
  const requested = options.rsihRoot;
  const root = requested ? toCanonical(requested) : toCanonical(options.defaultRoot);
  if (root === null) {
    throw new InstallationNotFoundError(
      requested
        ? `RSIH_ROOT (${requested}) does not exist`
        : `No RSI-Harness checkout found at ${options.defaultRoot}. Set RSIH_ROOT ` +
            "or populate third_party/RSI-Harness.",
    );
  }

  const problems = validate(root);
  if (problems.length > 0) {
    throw new InvalidInstallationError(problems, root);
  }

  return {
    root,
    source: requested ? "RSIH_ROOT" : "default",
    revision: revisionAt(root),
    piVersion: piVersionAt(root),
  };
}

/** Canonicalize to an absolute path that exists, or null if it does not. */
function toCanonical(path: string): string | null {
  // A relative root would resolve against whatever the caller's cwd happens to
  // be, which is exactly the nondeterminism a controlled episode forbids.
  if (!isAbsolute(path)) {
    throw new InstallationNotFoundError(
      `RSI-Harness root must be an absolute path, got: ${path}`,
    );
  }
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

// A valid checkout declares its name and has its runtime entrypoint.
const MARKERS = {
  "package.json": (content: string): string | null => {
    try {
      const pkg = JSON.parse(content) as { name?: string };
      return pkg.name === "rsih" ? null : `package.json name is "${pkg.name ?? "?"}", expected "rsih"`;
    } catch (error) {
      return `package.json is not valid JSON: ${(error as Error).message}`;
    }
  },
  "src/cli.ts": (): string | null => null,
};

function validate(root: string): string[] {
  const problems: string[] = [];
  for (const [name, check] of Object.entries(MARKERS)) {
    try {
      const problem = check(readFileSync(`${root}/${name}`, "utf8"));
      if (problem) problems.push(`${name}: ${problem}`);
    } catch {
      problems.push(`missing expected file: ${name}`);
    }
  }
  return problems;
}

/** The checked-out revision, or null when the tree has no git metadata. */
function revisionAt(root: string): string | null {
  try {
    const git = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
    return git.status === 0 && git.stdout ? git.stdout.trim() : null;
  } catch {
    return null;
  }
}

function piVersionAt(root: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(`${root}/package.json`, "utf8")) as {
      dependencies?: Record<string, string>;
    };
    return pkg.dependencies?.["@earendil-works/pi-coding-agent"] ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve using the process environment and this package's position in the
 * repository tree: packages/rsih-adapter/src -> repo root.
 */
export function resolveInstallationFromEnv(): Installation {
  return resolveInstallation({
    rsihRoot: process.env.RSIH_ROOT,
    defaultRoot: defaultInstallationRoot(),
  });
}

export function defaultInstallationRoot(): string {
  return resolve(fileURLToPath(new URL("../../third_party/RSI-Harness", import.meta.url)));
}
