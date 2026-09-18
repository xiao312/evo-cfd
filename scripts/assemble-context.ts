/**
 * Assemble a decision context for the next model invocation.
 *
 * This is the operator-facing entry point for the information interface: it
 * composes the recorded investigation, the solver dossier and the measured state
 * into one briefing tailored to a role and purpose, and writes it into the run.
 *
 *   node --experimental-strip-types scripts/assemble-context.ts \
 *     --run runs/external-003 \
 *     --attempt runs/mascotte/mascotte-agile-002 \
 *     --dossier dossiers/realfluid-reacting-001.json \
 *     --role scientific_advisor --purpose algorithm_design \
 *     [--source-root /data2/kexiao/of8/realFluidFoam-8]
 *
 * The --source-root is optional. When given, the dossier is verified against the
 * pinned source and the verification state is carried into the context, so a
 * model reading the briefing can see whether the algorithm map it is reasoning
 * from was checked against the code.
 */
import { readDossier, verifyDossier } from "../packages/controller/src/dossier.ts";
import { readInvestigation } from "../packages/controller/src/investigation.ts";
import { assembleDecisionContext } from "../packages/controller/src/context.ts";
import {
  activeRequestDir,
  readRequest,
  attemptInputDigest,
  type ConsultationState,
} from "../packages/controller/src/consultation.ts";
import { join } from "node:path";
import { access, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const argv = process.argv.slice(2);
const arg = (n: string): string | undefined => {
  const i = argv.indexOf(n);
  return i > -1 && i + 1 < argv.length ? argv[i + 1] : undefined;
};

/**
 * sha256 of a file that exists, or null. Used to measure identity rather than
 * assert it: a fallback state is still a measured state, or it is reported as
 * unmeasured.
 */
async function digestOf(path: string): Promise<string | null> {
  try {
    return createHash("sha256").update(await readFile(path)).digest("hex");
  } catch {
    return null;
  }
}

/**
 * Build a consultation state from the recorded baseline and the attempt.
 *
 * The assembler needs the solver and case identity; a full consultation request
 * is not required to supply them, because the baseline already records the
 * profile and the attempt already records the prepared case. Anything that
 * cannot be hashed is left empty rather than guessed, and the assembler's own
 * `missing` field is where the gap becomes visible.
 */
async function stateFromBaseline(
  attemptDir: string,
  baselinePath = "cfd-baseline/baseline.json",
): Promise<ConsultationState | null> {
  let baseline: {
    solver_profiles?: Record<string, {
      executable?: string;
      package?: {
        output_appbin?: string;
        source_root?: string;
        source_archive_sha256?: string;
      };
    }>;
  };
  try {
    baseline = JSON.parse(await readFile(baselinePath, "utf8"));
  } catch {
    return null;
  }
  const profile = baseline.solver_profiles?.["of8-realfluid"];
  if (!profile?.package) return null;
  const solverExecutable = join(profile.package.output_appbin ?? "", profile.executable ?? "");
  const solverDigest = (await digestOf(solverExecutable)) ?? "";
  let caseDigest = "";
  try {
    caseDigest = await attemptInputDigest(attemptDir);
  } catch {
    caseDigest = "";
  }
  return {
    solverExecutable,
    solverDigest,
    caseDir: attemptDir,
    caseDigest,
    profileId: "of8-realfluid",
    libraryFiles: [],
    relatedRunIds: [],
  };
}

async function main(): Promise<void> {
  const runRoot = arg("--run");
  const attemptArg = arg("--attempt");
  const dossierPath = arg("--dossier") ?? "dossiers/realfluid-reacting-001.json";
  const role = (arg("--role") ?? "scientific_advisor") as
    | "execution_agent"
    | "scientific_advisor"
    | "harness_proposer"
    | "human_reviewer";
  const purpose = (arg("--purpose") ?? "case_diagnosis") as
    | "case_diagnosis"
    | "algorithm_design"
    | "harness_improvement"
    | "experiment_execution";
  const sourceRoot = arg("--source-root");

  if (!runRoot || !attemptArg) {
    console.error(
      "usage: assemble-context.ts --run <run-root> --attempt <attempt-dir> [--dossier <json>] [--role r] [--purpose p] [--source-root <pinned package>]",
    );
    process.exit(2);
  }

  const investigation = await readInvestigation(attemptArg);
  if (!investigation) {
    console.error(`no investigation record at ${attemptArg}; record one with record-investigation.ts`);
    console.error("The context assembler composes recorded artifacts; it does not write the");
    console.error("scientific narrative for you.");
    process.exit(1);
  }

  const dossier = await readDossier(dossierPath);
  const verification = sourceRoot ? await verifyDossier(dossier, sourceRoot) : undefined;
  if (verification && !verification.ok) {
    console.error(`the dossier does not verify against ${sourceRoot}:`);
    for (const f of verification.failures) console.error(`  ${f.entry}: ${f.reason}`);
    console.error("Re-derive the dossier before assembling a context from it.");
    process.exit(1);
  }

  const request = await readRequest(runRoot);
  const active = await activeRequestDir(runRoot);
  // The state comes from the consultation when one exists, and otherwise from the
  // recorded baseline and the attempt's own prepared-case identity. Either way it
  // is measured rather than asserted; what cannot be measured stays empty and the
  // assembler reports it as missing.
  let state = request?.state;
  if (!state) state = await stateFromBaseline(attemptArg);
  if (!state) {
    console.error(
      `no consultation state at ${runRoot} and no readable baseline; one of the two is required`,
    );
    process.exit(1);
  }

  // The attempt directories are the intervention history. The one named on the
  // command line is included, as are any it points at through prior_evidence.
  const attemptDirs = [attemptArg];
  const here = process.cwd();
  for (const p of investigation.evidence_refs) {
    const candidate = join(here, p.path);
    try {
      await access(candidate);
      if (!attemptDirs.includes(candidate)) attemptDirs.push(candidate);
    } catch {
      // A recorded evidence ref that cannot be opened is a gap the context will
      // report; it is not fatal here.
    }
  }

  const context = await assembleDecisionContext({
    runRoot,
    investigation,
    dossier,
    dossierVerification: verification,
    state,
    request: active ? request : undefined,
    role,
    purpose,
    attemptDirs,
  });

  console.log(`ok context ${context.context_id} for ${runRoot}`);
  console.log(`   role ${role}, purpose ${purpose}, ${context.interventions.length} intervention(s)`);
  console.log(`   measured ${context.current_state.measured.length}, unmeasured ${context.current_state.unmeasured.length}`);
  console.log(`   briefing ${join(runRoot, "context", "briefing.md")}`);
  console.log(`   record   ${join(runRoot, "context", "decision-context.json")}`);
  if (context.missing.length) {
    console.log(`   missing  ${context.missing.length} item(s) the assembler could not supply:`);
    for (const m of context.missing) console.log(`     - ${m}`);
  }
}

await main();
