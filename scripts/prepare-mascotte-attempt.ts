/**
 * Materialize a MASCOTTE G2 child attempt.
 *
 * The imported target is never run in place. `Allcheck` writes into the case it
 * checks and `Allrun` decomposes it and writes solver results into it, and
 * `.gitignore` only hides that from Git status — ignore rules do not prevent
 * filesystem writes. This launcher is the supported path instead:
 *
 *   select the pinned target revision
 *       -> copy only the admitted inputs into a new child attempt directory
 *       -> verify the copied inputs against the target manifest
 *       -> run Allcheck on the child
 *       -> apply the documented attempt changes
 *       -> execute the child
 *
 * It refuses a destination inside the target tree, derives the per-species scheme
 * entries from the mechanism actually selected (not a hard-coded count), reconciles
 * the decomposition with the MPI rank count, and records the *effective* model and
 * numerics rather than listing the dictionaries present.
 *
 * Usage:
 *   node scripts/prepare-mascotte-attempt.ts \
 *     --job mascotte-agile-001 --variant agile-80mm --ranks 1 \
 *     --executable realFluidReactingFoam [--chemistry off] [--budget 900]
 */
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { argv, exit } from "node:process";

import {
  buildArgv,
  planDigest,
  resolveProfile,
  writeJobRecord,
  RECORD_FILE,
} from "../packages/controller/src/cfd-exec.ts";
import { buildRunnerScript } from "../packages/controller/src/runner.ts";
import type { CfdJobPlan } from "../packages/controller/src/cfd-job.ts";

/** Directories admitted into a child attempt. Everything else stays in the target. */
const ADMITTED_INPUT_DIRS = ["0", "constant", "system"];
/** Files written by tooling, not case inputs. Never copied. */
const EXCLUDE_NAMES = new Set(["checkMesh.current.log", "checkMesh.agile80.log", "checkMesh.log"]);

function arg(name: string, fallback?: string): string | undefined {
  const i = argv.indexOf(name);
  if (i > -1 && i + 1 < argv.length) return argv[i + 1];
  return fallback;
}

async function sha256(file: string): Promise<string> {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

/** Species declared by the selected mechanism, including the inert species. */
function parseSpecies(thermoInputData: string): string[] {
  const m = /species\s*\(([^)]*)\)/.exec(thermoInputData);
  if (!m) throw new Error("could not find the species list in constant/thermo.inputData");
  const species = m[1]
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (species.length === 0) throw new Error("the species list is empty");
  return species;
}

/**
 * Read a Foam dictionary entry. This is deliberately not a parser: it reads the
 * specific scalar entries that identify an *effective* selection, so the attempt
 * record says what will run rather than which dictionaries exist.
 */
function readEntry(text: string, key: string): string | null {
  const m = new RegExp(`^\\s*${key}\\s+([\\w.+-]+);`, "m").exec(text);
  return m ? m[1] : null;
}

function readBlockEntry(text: string, block: string, key: string): string | null {
  const blockStart = text.indexOf(block);
  if (blockStart === -1) return null;
  const braceStart = text.indexOf("{", blockStart);
  const braceEnd = text.indexOf("}", braceStart);
  if (braceStart === -1 || braceEnd === -1) return null;
  return readEntry(text.slice(braceStart, braceEnd), key);
}

/**
 * Decompose an integer into up to three factors, for `simpleCoeffs.n`.
 *
 * OpenFOAM's simple method needs the product of the three entries to equal
 * numberOfSubdomains. This picks the most cube-like factorisation, which is what
 * a person would choose for a roughly isotropic domain.
 */
function factorThree(n: number): [number, number, number] {
  if (n <= 1) return [1, 1, 1];
  let a = 1, b = 1, c = 1;
  let remaining = n;
  for (const d of [2, 3, 5, 7, 11, 13]) {
    while (remaining % d === 0) {
      if (a <= b && a <= c) a *= d;
      else if (b <= c) b *= d;
      else c *= d;
      remaining /= d;
    }
  }
  if (remaining > 1) {
    if (a <= b && a <= c) a *= remaining;
    else if (b <= c) b *= remaining;
    else c *= remaining;
  }
  return [a, b, c];
}

interface AttemptRecord {
  attempt_id: string;
  created_at: string;
  target: {
    revision_dir: string;
    variant: string;
    manifest: string;
  };
  executables: {
    imported_reference: string;
    selected_for_this_attempt: string;
    selected_sha256: string;
    note: string;
  };
  required_case_adaptation: string[];
  other_changes: string[];
  effective_configuration: Record<string, string | null>;
  decomposition: {
    method: string;
    number_of_subdomains: number;
    ranks: number;
    ranks_match: boolean;
    note: string;
  };
  species: string[];
  inputs: { source: string; sha256: string }[];
  prepared_attempt?: {
    digest: string;
    measured_after: string;
    note: string;
  };
}

/**
 * A safe identifier for a directory name or a job id.
 *
 * This is not a sandbox escape policy, because the script also refuses any
 * destination inside the target tree. It exists so that an agent-supplied value
 * cannot silently become a path traversal or a nested directory.
 */
function isSafeIdentifier(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) && value.length <= 128;
}

function isFiniteNumeric(value: string): boolean {
  const n = Number(value);
  return Number.isFinite(n) && n > 0;
}

/**
 * Canonical containment: dest is inside base only if every step of the resolved
 * dest path starts with the resolved base path. A lexical `startsWith` test is
 * fooled by a sibling that shares a prefix.
 */
function isInside(base: string, dest: string): boolean {
  const b = resolve(base);
  const d = resolve(dest);
  if (d === b) return true;
  return d.startsWith(b + sep);
}

async function main(): Promise<void> {
  const jobId = arg("--job");
  const variant = arg("--variant", "agile-80mm");
  const ranks = Number(arg("--ranks", "1"));
  const executable = arg("--executable", "realFluidReactingFoam");
  const chemistry = arg("--chemistry", "on");
  const endTimeOverride = arg("--end-time");
  const budget = Number(arg("--budget", "900"));
  const runsRoot = arg("--runs-root") ?? join(process.env.EVOCFD_HOST_ROOT ?? ".", "runs", "mascotte");

  if (!jobId) {
    console.error("usage: prepare-mascotte-attempt.ts --job <id> --variant <v> --ranks <n> --executable <e> [--chemistry off] [--end-time T] [--budget S]");
    exit(2);
  }
  // These become agent-supplied arguments, so they are validated before the
  // script does anything with them. `Number(2.5) < 1` is false but is not a rank
  // count, and an identifier containing a path separator or space reaches into
  // places this script does not intend to write.
  if (!Number.isInteger(ranks) || ranks < 1) {
    console.error(`--ranks must be a positive integer, got ${arg("--ranks", "1")}`);
    exit(2);
  }
  if (!Number.isInteger(budget) || budget <= 0) {
    console.error(`--budget must be a positive integer of seconds, got ${arg("--budget", "900")}`);
    exit(2);
  }
  if (!isSafeIdentifier(jobId)) {
    console.error(`--job must be a safe identifier (letters, digits, dash, dot), got ${JSON.stringify(jobId)}`);
    exit(2);
  }
  if (!isSafeIdentifier(variant)) {
    console.error(`--variant must be a safe identifier, got ${JSON.stringify(variant)}`);
    exit(2);
  }
  if (endTimeOverride !== undefined && !isFiniteNumeric(endTimeOverride)) {
    console.error(`--end-time must be a finite number, got ${JSON.stringify(endTimeOverride)}`);
    exit(2);
  }

  // The target root is resolved from this script's own location so the launcher
  // cannot be pointed at a copy that has not been reviewed.
  const here = resolve(import.meta.dirname ?? ".");
  const repoRoot = resolve(here, "..");
  const targetRoot = resolve(repoRoot, "mascotte-g2");
  const sourceCase = resolve(targetRoot, "cases", variant);
  if (!existsSync(sourceCase)) {
    console.error(`variant ${variant} not found at ${sourceCase}`);
    exit(1);
  }

  const dest = resolve(runsRoot, jobId);
  // Refuse to write inside the target tree. A child that overwrites the target
  // is not an attempt, it is a modified immutable reference. The check is
  // canonical, on resolved paths, because a lexical prefix test is fooled by a
  // sibling directory that shares a name prefix.
  if (isInside(targetRoot, dest)) {
    console.error(
      `refusing to create an attempt inside the target tree: ${dest} is within ${targetRoot}`,
    );
    exit(1);
  }
  // A partial destination is not merged into. An existing record means a prior
  // attempt, and a directory with no record but with case content is an
  // abandoned materialisation whose provenance is unknown.
  if (existsSync(join(dest, RECORD_FILE))) {
    console.error(
      `a job record already exists at ${join(dest, RECORD_FILE)}; a prior attempt is preserved. Use a new job id.`,
    );
    exit(1);
  }
  if (existsSync(dest) && (await readdir(dest)).length > 0) {
    console.error(
      `${dest} exists and is not empty; refusing to merge into a directory of unknown provenance. Use a new job id or remove it.`,
    );
    exit(1);
  }
  if (existsSync(join(dest, "attempt-record.json"))) {
    console.error(
      `an attempt record already exists at ${dest}; a prior attempt is preserved. Use a new job id.`,
    );
    exit(1);
  }

  // Verify the target itself against its manifest before copying from it, so a
  // drifted target is caught here rather than blamed on the attempt later.
  const manifestPath = join(targetRoot, "SHA256SUMS");
  const manifest = await readManifest(manifestPath);
  const manifestNames = new Set(manifest.map((e) => e.path));

  await mkdir(dest, { recursive: true });
  const copied: { source: string; sha256: string }[] = [];
  // Copy recursively: constant/polyMesh is a directory and the mesh lives in it.
  // A files-only copy silently drops the mesh, and Allcheck then fails at
  // checkMesh looking for "points".
  const skipDir = (name: string) =>
    name.startsWith("processor") || name === "sets" || name === "lagrangian";
  async function copyTree(fromDir: string, relDir: string): Promise<void> {
    for (const entry of await readdir(fromDir, { withFileTypes: true })) {
      if (entry.isFile()) {
        if (EXCLUDE_NAMES.has(entry.name)) continue;
        const fromFile = join(fromDir, entry.name);
        const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
        const toFile = join(dest, relPath);
        await mkdir(join(dest, relDir), { recursive: true });
        await cp(fromFile, toFile);
        const digest = await sha256(toFile);
        const manifestRel = `cases/${variant}/${relPath}`;
        const expected = manifest.find((e) => e.path === `./${manifestRel}`);
        if (expected && expected.sha256 !== digest) {
          throw new Error(
            `copied input ${relPath} does not match the target manifest; the target or the copy is inconsistent`,
          );
        }
        if (!manifestNames.has(`./${manifestRel}`)) {
          throw new Error(`copied input ${relPath} is not listed in the target manifest`);
        }
        copied.push({ source: manifestRel, sha256: digest });
      } else if (entry.isDirectory()) {
        if (skipDir(entry.name)) continue;
        await copyTree(join(fromDir, entry.name), relDir ? `${relDir}/${entry.name}` : entry.name);
      }
    }
  }
  for (const dir of ADMITTED_INPUT_DIRS) {
    const from = join(sourceCase, dir);
    if (!existsSync(from)) continue;
    await copyTree(from, dir);
  }

  // Completeness is checked against the expected set, not inferred from what
  // the copy happened to visit. Iterating the source tree verifies the files
  // that are there; it says nothing about a file that is missing from the
  // target, or about an admitted directory the source no longer has.
  const expectedAll = manifest
    .map((e) => e.path)
    .filter((p) => p.startsWith(`./cases/${variant}/`));
  const copiedSet = new Set(copied.map((c) => `./${c.source}`));
  const omitted = expectedAll.filter((p) => !copiedSet.has(p));
  if (omitted.length > 0) {
    throw new Error(
      `the copy omitted ${omitted.length} file(s) the target manifest lists for this variant, including ${omitted.slice(0, 3).join(", ")}; refusing to ship a partial case`,
    );
  }

  // Derive the species from the mechanism actually selected, including the inert
  // species. The energy equation loops over all of Y, so a scheme entry is needed
  // per species; hard-coding the count of one mechanism would silently drop
  // entries after switching to another.
  const thermoInputData = await readFile(join(dest, "constant", "thermo.inputData"), "utf8");
  const species = parseSpecies(thermoInputData);

  const changes: string[] = [];
  const controlDictPath = join(dest, "system", "controlDict");
  let controlDict = await readFile(controlDictPath, "utf8");
  if (readEntry(controlDict, "application") !== executable) {
    const prior = readEntry(controlDict, "application");
    controlDict = controlDict.replace(
      /^(\s*application\s+)\S+;/m,
      `$1${executable};`,
    );
    changes.push(
      `controlDict application ${prior} -> ${executable} (the imported reference launcher invokes realFluidFoam)`,
    );
  }
  await writeFile(controlDictPath, controlDict, "utf8");

  if (endTimeOverride) {
    // A startup qualification is bounded by physics, not only by wall clock.
    // Cutting the run at the budget would answer "did it hang" but not "did it
    // advance"; a short endTime answers both and is recorded as an attempt change.
    controlDict = await readFile(controlDictPath, "utf8");
    const priorEnd = readEntry(controlDict, "endTime");
    controlDict = controlDict.replace(/^([ \t]*endTime[ \t]+)\S+;/m, "$1" + endTimeOverride + ";");
    await writeFile(controlDictPath, controlDict, "utf8");
    changes.push(
      `controlDict endTime ${priorEnd} -> ${endTimeOverride} for a bounded startup qualification`,
    );
  }

  // The required adaptation for the selected solver: one div scheme entry per
  // species. Proven necessary in target-solver-001; derived here from the
  // selected mechanism so it cannot go stale after a mechanism switch.
  const fvSchemesPath = join(dest, "system", "fvSchemes");
  let fvSchemes = await readFile(fvSchemesPath, "utf8");
  const needed = species.filter((s) => !fvSchemes.includes(`hei_${s}`));
  if (needed.length > 0) {
    // Match the anchor on content, tolerating whatever whitespace the case uses
    // between the term and its scheme.
    const anchor = /^([ \t]*div\(\(\(rho\*nuEff\)\*dev2\(T\(grad\(U\)\)\)\)\)[ \t]+Gauss \w+;)[ \t]*$/m;
    if (!anchor.test(fvSchemes)) {
      throw new Error(
        "could not locate the anchor line in fvSchemes to append the per-species entries",
      );
    }
    const added = needed
      .map((s) => `    div(((hei_${s}*rho)*YVi_${s}))  Gauss linear;`)
      .join("\n");
    fvSchemes = fvSchemes.replace(
      anchor,
      (line) => `${line}\n${added}`,
    );
    changes.push(
      `fvSchemes: added ${needed.length} per-species div(((hei_*rho)*YVi_*)) entries (${needed.join(", ")}) for ${executable}`,
    );
    await writeFile(fvSchemesPath, fvSchemes, "utf8");
  }

  if (chemistry === "off") {
    let chem = await readFile(join(dest, "constant", "chemistryProperties"), "utf8");
    chem = chem.replace(/^(\s*chemistry\s+)\S+;/m, "$1off;");
    await writeFile(join(dest, "constant", "chemistryProperties"), chem, "utf8");
    changes.push("chemistryProperties: chemistry on -> off for a startup-qualification attempt");
  }

  // Reconcile decomposition with the rank count. The imported case declares
  // scotch with 16 subdomains; the OF8 build this project pinned carries dummy
  // Scotch libraries, so scotch is not qualified unless the profile proves it is.
  // Serial qualification avoids the question entirely.
  const decomposePath = join(dest, "system", "decomposeParDict");
  let decompose = await readFile(decomposePath, "utf8");
  const declaredMethod = readEntry(decompose, "method") ?? "simple";
  const declaredSubdomains = Number(readEntry(decompose, "numberOfSubdomains") ?? "1");
  let method = declaredMethod;
  let note = "unchanged from the imported case";
  if (ranks === 1) {
    method = "simple";
    note = "serial startup qualification; no decomposition is performed";
  } else if (declaredMethod === "scotch") {
    method = "simple";
    note =
      "the pinned OF8 build carries dummy Scotch libraries, so scotch is not qualified; switched to simple. Qualify a real Scotch installation to use scotch.";
  }
  const n = factorThree(ranks);
  decompose = decompose
    .replace(/^(\s*numberOfSubdomains\s+)\d+;/m, `$1${ranks};`)
    .replace(/^(\s*method\s+)\w+;/m, `$1${method};`)
    .replace(/^(\s*n\s+)\([^)]*\);/m, `$1( ${n.join(" ")} );`);
  await writeFile(decomposePath, decompose, "utf8");
  if (ranks !== declaredSubdomains || method !== declaredMethod) {
    changes.push(
      `decomposeParDict: numberOfSubdomains ${declaredSubdomains} -> ${ranks}, method ${declaredMethod} -> ${method}, n -> ( ${n.join(" ")} )`,
    );
  }

  // The effective configuration: what will actually run, not which dictionaries
  // are present. `odeCoeffs` mentions Rosenbrock43 but the selected chemistry
  // solver is EulerImplicit, and a record that listed both would be ambiguous.
  const chemText = await readFile(join(dest, "constant", "chemistryProperties"), "utf8");
  const thermoText = await readFile(join(dest, "constant", "thermophysicalProperties"), "utf8");
  const momentumText = await readFile(join(dest, "constant", "momentumTransport"), "utf8");
  const effective: Record<string, string | null> = {
    chemistry_solver: readBlockEntry(chemText, "chemistryType", "solver"),
    chemistry_method: readBlockEntry(chemText, "chemistryType", "method"),
    chemistry_active: readEntry(chemText, "chemistry"),
    reaction_model: readEntry(await readFile(join(dest, "constant", "reactions"), "utf8"), "reactions") ? "JL9 global mechanism present" : null,
    equation_of_state: readBlockEntry(thermoText, "thermoType", "equationOfState"),
    thermo_mixture: readBlockEntry(thermoText, "thermoType", "mixture"),
    transport: readBlockEntry(thermoText, "thermoType", "transport"),
    turbulence_model: readEntry(momentumText, "RAS") ?? readEntry(momentumText, "LES") ?? null,
    ddt_scheme: readBlockEntry(
      await readFile(join(dest, "system", "fvSchemes"), "utf8"),
      "ddtSchemes",
      "default",
    ),
    application: executable,
    species_count: String(species.length),
  };

  const profileExe = `/data2/kexiao/of8/rf-profile/bin/${executable}`;
  const ENV_FILE = "/data2/kexiao/of8/rf-profile-env.sh";
  let exeDigest = "unmeasured";
  try {
    exeDigest = await sha256(profileExe);
  } catch {
    console.error(`warning: selected executable not measurable at ${profileExe}`);
  }

  const record: AttemptRecord = {
    attempt_id: jobId,
    created_at: new Date().toISOString(),
    target: {
      revision_dir: relative(repoRoot, targetRoot),
      variant,
      manifest: "mascotte-g2/SHA256SUMS",
    },
    executables: {
      imported_reference: "realFluidFoam (the imported Allrun invokes this)",
      selected_for_this_attempt: executable,
      selected_sha256: exeDigest,
      note:
        "The imported launcher is retained for provenance and is not executed. Changing only controlDict.application would not change what Allrun invokes, so the child records both and uses its own launcher.",
    },
    required_case_adaptation: changes.filter((c) => c.startsWith("fvSchemes")),
    other_changes: changes.filter((c) => !c.startsWith("fvSchemes")),
    effective_configuration: effective,
    decomposition: {
      method,
      number_of_subdomains: ranks,
      ranks,
      ranks_match: true,
      note,
    },
    species,
    inputs: copied,
  };
  // The imported-input identity above was measured before the changes. The
  // prepared attempt is a different case, and the record must bind that too:
  // imported-input identity + the exact preparation diff = prepared-attempt
  // identity. The execution receipt references this digest, so an answer can be
  // tied to the case that actually ran rather than to the one that was imported.
  const preparedDigest = await digestPrepared(dest, changes);
  record.prepared_attempt = {
    digest: preparedDigest,
    measured_after: "all documented changes were applied",
    note:
      "The imported-input digests above were taken before these changes; this digest covers the case that will run.",
  };
  await writeFile(
    join(dest, "attempt-record.json"),
    JSON.stringify(record, null, 2) + "\n",
    "utf8",
  );

  // One execution backend. The deadline, the environment sourcing, the
  // resolution check and the receipt are the same tested implementation a
  // generic job uses, from packages/controller/src/runner.ts. What stays here is
  // only the case-specific preflight: the child must not already hold processor
  // directories, and it must pass the target's own structure and mesh checks
  // before the solver is allowed to start.
  const plan: CfdJobPlan = {
    jobId,
    profile: resolveProfile({
      id: "of8-realfluid",
      executable: profileExe,
      executableSha256: exeDigest === "unmeasured" ? "" : exeDigest,
      envFile: ENV_FILE,
      libraryPaths: [
        "/data2/kexiao/of8/rf-profile/lib",
        "/data2/kexiao/of8/OpenFOAM-8/platforms/linux64GccDPInt32Opt/lib",
      ],
      expectedProfileLibraries: [
        "libreactionThermophysicalModels.so",
        "libspecie.so",
        "libchemistryModel.so",
        "libcombustionModels.so",
      ],
    }),
    caseDir: dest,
    args: [],
    budgetSeconds: budget,
    requestedEndTime: endTimeOverride !== undefined ? Number(endTimeOverride) : 0.005,
    ranks,
    logFile: `log.${executable}`,
  };
  const digest = planDigest(plan);
  await writeJobRecord(dest, { plan, state: emptyJobState(jobId), planDigest: digest });

  const argv = buildArgv(profileExe, plan.args, ranks);
  await writeFile(
    join(dest, "run.sh"),
    buildRunnerScript({
      jobId,
      planDigest: digest,
      argv,
      envFile: ENV_FILE,
      budgetSeconds: budget,
      logFile: plan.logFile,
    }),
    "utf8",
  );

  // The preflight wrapper is deliberately small and stable. Everything that can
  // go wrong with a deadline, a receipt or a library order lives in run.sh,
  // which the same backend a generic job uses generates.
  await writeFile(
    join(dest, "Allrun-child"),
    [
      "#!/bin/bash",
      "# Child-attempt preflight. The execution itself is run.sh, generated by",
      "# the same backend a generic CFD job uses, so the deadline, the receipt",
      "# and the library resolution behave identically.",
      "set -euo pipefail",
      'root="$(cd "$(dirname "$0")" && pwd)"',
      'cd "$root"',
      'if find . -maxdepth 1 -type d -name "processor*" | grep -q .; then',
      '  echo "Refusing to run in an attempt containing processor directories." >&2',
      "  exit 1",
      "fi",
      // The attempt is at <repo>/runs/mascotte/<job>; the target's Allcheck is
      // <repo>/mascotte-g2/Allcheck. Resolved from the launcher's own location so
      // the same file works under the host and the container roots.
      'repo="$(cd "$root/../../.." && pwd)"',
      `allcheck="$repo/${allcheckRel}"`,
      'test -f "$allcheck" || { echo "Allcheck not found at $allcheck" >&2; exit 1; }',
      'CASE_DIR="$root" bash "$allcheck" || { echo "Allcheck failed on the child" >&2; exit 1; }',
      'bash "$root/run.sh"',
    ].join("\n") + "\n",
    "utf8",
  );
  console.log(`ok attempt ${jobId} materialized at ${dest}`);
  console.log(`   variant ${variant}, species ${species.length}, ranks ${ranks}, chemistry ${chemistry}`);
  console.log(`   executable ${executable} (${exeDigest.slice(0, 16)}…)`);
  console.log(`   decomposition ${method}, ${ranks} subdomain(s): ${note}`);
  console.log(`   ${changes.length} documented change(s):`);
  for (const c of changes) console.log(`     - ${c}`);
  console.log(`   inputs verified: ${copied.length} files match the target manifest`);
  console.log(`   budget ${budget}s; run with bash ${join(dest, "Allrun-child")}`);
}

function emptyJobState(jobId: string) {
  return {
    jobId,
    state: "submitted" as const,
    submittedAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    container: null,
    lastReportedTime: null,
    terminatedNormally: false,
    stopReason: null,
    detail: "",
  };
}

/**
 * Digests the prepared case as it will run.
 *
 * The dictionaries this script changed are hashed in their final state and the
 * change list is included, so the digest moves if either the case or the stated
 * changes move. This is a prepared-case identity, not a claim of bit-for-bit
 * reproducibility from the target.
 */
async function digestPrepared(dest: string, changes: string[]): Promise<string> {
  const h = createHash("sha256");
  const files = [
    "system/controlDict",
    "system/fvSchemes",
    "system/decomposeParDict",
    "constant/chemistryProperties",
    "constant/thermophysicalProperties",
    "constant/thermo.inputData",
  ].sort();
  for (const f of files) {
    try {
      const raw = await readFile(join(dest, f));
      h.update(f)
        .update(":")
        .update(createHash("sha256").update(raw).digest("hex"))
        .update("\n");
    } catch {
      h.update(f).update(":absent\n");
    }
  }
  h.update("changes:\n" + changes.join("\n"));
  return h.digest("hex");
}
async function readManifest(path: string): Promise<{ path: string; sha256: string }[]> {
  const raw = await readFile(path, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      const [sha256, p] = line.replace(/\*/g, "").trim().split(/\s+/);
      return { path: p, sha256 };
    })
    .filter((e) => e.path && e.sha256);
}

await main();
