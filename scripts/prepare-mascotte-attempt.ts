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
}

async function main(): Promise<void> {
  const jobId = arg("--job");
  const variant = arg("--variant", "agile-80mm");
  const ranks = Number(arg("--ranks", "1"));
  const executable = arg("--executable", "realFluidReactingFoam");
  const chemistry = arg("--chemistry", "on");
  const budget = Number(arg("--budget", "900"));
  const runsRoot = arg("--runs-root") ?? join(process.env.EVOCFD_HOST_ROOT ?? ".", "runs", "mascotte");

  if (!jobId) {
    console.error("usage: prepare-mascotte-attempt.ts --job <id> --variant <v> --ranks <n> --executable <e>");
    exit(2);
  }
  if (!Number.isFinite(ranks) || ranks < 1) {
    console.error("--ranks must be a positive integer");
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
  // is not an attempt, it is a modified immutable reference.
  const rel = relative(targetRoot, dest);
  if (rel === "" || (!rel.startsWith("..") && !rel.startsWith(`..${sep}`))) {
    console.error(
      `refusing to create an attempt inside the target tree: ${dest} is within ${targetRoot}`,
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
  for (const dir of ADMITTED_INPUT_DIRS) {
    const from = join(sourceCase, dir);
    if (!existsSync(from)) continue;
    for (const entry of await readdir(from, { withFileTypes: true })) {
      if (!entry.isFile() || EXCLUDE_NAMES.has(entry.name)) continue;
      const fromFile = join(from, entry.name);
      const relPath = `${dir}/${entry.name}`;
      const toFile = join(dest, dir, entry.name);
      await mkdir(join(dest, dir), { recursive: true });
      await cp(fromFile, toFile);
      const digest = await sha256(toFile);
      const expected = manifest.find((e) => e.path.endsWith(relPath));
      if (expected && expected.sha256 !== digest) {
        throw new Error(
          `copied input ${relPath} does not match the target manifest; the target or the copy is inconsistent`,
        );
      }
      if (!manifestNames.has(`./cases/${variant}/${relPath}`)) {
        throw new Error(`copied input ${relPath} is not listed in the target manifest`);
      }
      copied.push({ source: `cases/${variant}/${relPath}`, sha256: digest });
    }
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
  await writeFile(
    join(dest, "attempt-record.json"),
    JSON.stringify(record, null, 2) + "\n",
    "utf8",
  );

  // The child gets its own launcher. It refuses processor directories and runs
  // Allcheck on the child, never on the target.
  await writeFile(
    join(dest, "Allrun-child"),
    [
      "#!/bin/bash",
      "# Child-attempt launcher generated by prepare-mascotte-attempt.ts.",
      "# The imported Allrun is retained in the target for provenance and is not used here.",
      "set -euo pipefail",
      'root="$(cd "$(dirname "$0")" && pwd)"',
      'cd "$root"',
      'if find . -maxdepth 1 -type d -name "processor*" | grep -q .; then',
      '  echo "Refusing to run in an attempt containing processor directories." >&2',
      "  exit 1",
      "fi",
      'CASE_DIR="$root" "$root/../Allcheck" || { echo "Allcheck failed on the child" >&2; exit 1; }',
      ranks > 1
        ? `decomposePar -force | tee log.decomposePar\nmpirun -np ${ranks} ${profileExe} -parallel | tee log.${executable}`
        : `${profileExe} | tee log.${executable}`,
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
