/**
 * Prepare a scientific consultation and export it for a web chat.
 *
 * Route A of the reviewer's design: EvoCFD writes a frozen briefing, a human
 * carries it to the chosen web chat, and the answer comes back through
 * import-consultation.ts. This is deliberately not autonomous, and the
 * distinction is recorded rather than blurred: transporting an unchanged
 * response is a different contribution from adding scientific guidance.
 *
 * The first real use is the target-solver case gap. `realFluidReactingFoam`
 * builds, but no upstream tutorial runs it: every shipped case specifies
 * `reactingFoam`, and the target solver requires per-species scheme entries the
 * tutorials do not declare. That question is now closed by experiment
 * (target-solver-001), so this script ships the two arms as verified evidence
 * and asks the question that remains open: is the small difference between the
 * target solver and the package’s reactingFoam the expected physical effect,
 * or a sign of an inconsistency.
 *
 * Usage:
 *   node scripts/prepare-consultation.ts <run-root> [question-id]
 */
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { argv, exit } from "node:process";

import { digestPath, prepareConsultation } from "../packages/controller/src/consultation.ts";
import type {
  ConsultationRequest,
  ConsultationState,
  ProblemContract,
} from "../packages/controller/src/consultation.ts";

const SOLVER_ROOT = process.env.EVOCFD_SOLVER_ROOT ?? "/data2/kexiao/of8";
const REPO_ROOT = process.env.EVOCFD_HOST_ROOT ?? ".";
const SOLVER = join(SOLVER_ROOT, "rf-profile", "bin", "realFluidReactingFoam");
const CASE_SOURCE = join(SOLVER_ROOT, "rf-cases", "1D_advection");
// Retained for reference; the experiment arms are the real evidence.
const SOLVER_SOURCE = join(SOLVER_ROOT, "realFluidFoam-8", "applications", "solvers");

async function sha256(file: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

async function main(): Promise<void> {
  const runRoot = argv[2];
  if (!runRoot) {
    console.error("usage: prepare-consultation.ts <run-root>");
    exit(2);
  }
  const questionId = argv[3] ?? "target-solver-case-gap";
  await mkdir(runRoot, { recursive: true });

  // Freeze the computational state: the solver executable, its digest, and a
  // digest of the case inputs. Advice that arrives against a different state
  // is flagged for revalidation rather than applied.
  const solverDigest = await sha256(SOLVER);
  const caseDigest = await digestPath(CASE_SOURCE);
  const state: ConsultationState = {
    solverExecutable: SOLVER,
    solverDigest,
    caseDir: CASE_SOURCE,
    caseDigest,
    profileId: "of8-realfluid",
    relatedRunIds: ["1D-advection-001"],
  };

  const contract: ProblemContract = {
    fixedConstraints: [
      "The Peng-Robinson real-fluid property path must be exercised: PRchungKineticMixture, chungKinetic transport, rfJanaf thermo, rfSpecie",
      "The species set and the inlet/initial conditions of the reference case are mandatory",
      "The stock OpenFOAM-8 installation must remain unchanged",
    ],
    allowedChanges: [
      "the case dictionaries in a disposable copy",
      "fvSchemes entries for per-species terms",
      "initialisation and case preparation steps",
    ],
    forbiddenChanges: [
      "the solver source",
      "the mandatory physical boundary conditions",
      "the evaluator and the trial machinery",
      "anything that promotes a change without execution evidence",
    ],
    conventions: [
      "absolute pressure, not gauge",
      "sensible enthalpy with a consistent reference",
      "mass fractions, species order as declared in the case",
      "a state read from a completed time step is not the same as an intermediate update",
    ],
  };

  const request: ConsultationRequest = {
    requestId: questionId,
    question:
      "The target solver realFluidReactingFoam now runs the reference case to its requested endTime, after adding two per-species div scheme entries its last sampled max temperature is 368.475 K against 368.537 K for the package's own reactingFoam on the same case. Is that 0.06 K difference the physically expected effect of the species-diffusion enthalpy flux terms the target solver carries, or a sign of an inconsistency I should chase before trusting this solver for the MASCOTTE comparison?",
    whyNow:
      "The configuration gap is closed and the solver runs, so the remaining question is whether it runs the right equations. This case has no chemical reaction and no validation data, so the reactingFoam comparison is the only check available, and it is a single sampled comparison."
    contract,
    state,
    items: [
      {
        id: "E1",
        label: "observation",
        text: "All four upstream tutorials specify `application reactingFoam`; none runs the target solver realFluidReactingFoam.",
        source: "grep over realFluidFoam-8/tutorials/**/controlDict",
      },
      {
        id: "E2",
        label: "observation",
        text: "Running the target solver on an unmodified disposable copy of the case exits 1 at the first enthalpy solve: `keyword div(((hei_O2*rho)*YVi_O2)) is undefined in .../system/fvSchemes/divSchemes`.",
        source: "experiment/armA-as-shipped, attached; exit code 1 recorded",
      },
      {
        id: "E5",
        label: "observation",
        text: "Adding exactly two div scheme entries for O2 and N2 makes the same case run: exit 0, 200 time steps at deltaT 1e-5, last reported time 0.002 equals the requested endTime, normal End.",
        source: "experiment/armB-with-species-schemes, attached; the two-line diff is changes/fvSchemes.diff in target-solver-001",
      },
      {
        id: "E6",
        label: "observation",
        text: "The target solver's last sampled min/max(T) is 139.214/368.475 K; the package's reactingFoam on the same case gives 139.214/368.537 K.",
        source: "the last min/max(T) line of each log; first-and-last sampled values, not a history",
      },
      {
        id: "E3",
        label: "observation",
        text: "The term is EEqn.H's explicit `fvc::div(hei[k]*rho*YVi[k])`, which the package's reactingFoam does not have.",
        source: "applications/solvers/realFluidReactingFoam/EEqn.H, attached",
      },
      {
        id: "E4",
        label: "observation",
        text: "The package's own reactingFoam build runs the same case to its requested end time with a normal End, selecting PRchungKineticMixture / PengRobinson.",
        source: "realfluid-baseline-001, records/verification.json",
      },
      {
        id: "H1",
        label: "hypothesis",
        text: "The failure is a configuration gap: the case needs per-species div schemes that the shipped fvSchemes does not declare, and nothing more.",
        source: "worker reading EEqn.H against the error message",
      },
      {
        id: "H2",
        label: "hypothesis",
        text: "The target solver requires additional case structure beyond scheme entries, e.g. fields or initialisation that reactingFoam does not need.",
        source: "the solver creates YVi and hei fields in createFields.H",
      },
      {
        id: "N1",
        label: "not_established",
        text: "Whether supplying the missing scheme entries is sufficient for the target solver to integrate.",
        source: "no test has been run",
      },
      {
        id: "N2",
        label: "not_established",
        text: "Whether the failing run's state was thermodynamically admissible at the point of failure.",
        source: "no property check was made",
      },
    ],
    attempts: [
      "built the package with isolated outputs; stock OF8 verified unchanged",
      "ran the package's reactingFoam on the reference case; reached the requested end time",
      "ran the target solver on the unmodified case; failed at startup with the scheme error",
      "added the two per-species div scheme entries; the target solver reached the requested end time",
    ],
    workerInterpretation:
      "The evidence points at a configuration gap rather than a solver defect: the same property path works under reactingFoam, and the missing term is exactly what the error names. I cannot confirm the gap is the only obstacle, and I have not established that the failing state was admissible.",
    availableActions: [
      "edit the case dictionaries in a disposable copy",
      "add per-species fvSchemes entries",
      "run a short bounded target-solver job through the controller",
    ],
    limits: [
      "the solver source is read-only for this consultation",
      "the budget is one short serial run",
      "the stock installation must not change",
    ],
    responseRequested: [
      "ranked explanations with the evidence supporting and conflicting with each",
      "the smallest bounded experiment that would discriminate between them",
      "what each explanation predicts, so the result is informative either way",
      "any prerequisite or artifact I have not attached, rather than an inference",
    ],
    createdAt: new Date().toISOString(),
  };

  const excerpts: { file: string; why: string; dest: string }[] = [
    {
      file: join(SOLVER_SOURCE, "realFluidReactingFoam", "EEqn.H"),
      why: "the equation file containing the term that fails to evaluate",
      dest: "realFluidReactingFoam/EEqn.H",
    },
    {
      file: join(SOLVER_SOURCE, "realFluidReactingFoam", "createFields.H"),
      why: "declares the per-species YVi and hei fields the scheme entries must name",
      dest: "realFluidReactingFoam/createFields.H",
    },
    {
      file: join(SOLVER_SOURCE, "realFluidReactingFoam", "realFluidReactingFoam.C"),
      why: "the solver's top-level loop, showing where the property update sits",
      dest: "realFluidReactingFoam/realFluidReactingFoam.C",
    },
    {
      file: join(SOLVER_SOURCE, "reactingFoam", "EEqn.H"),
      why: "the corresponding equation without the species term, for comparison",
      dest: "reactingFoam/EEqn.H",
    },
  ];
  const caseInputs = [
    {
      dir: CASE_SOURCE,
      why: "the case as shipped: system/, constant/ and 0/ including fvSchemes and thermophysicalProperties",
    },
  ];
  const evidenceSources: { dir: string; why: string; dest: string }[] = [
    {
      // The real failing target-solver run, captured by running the pinned
      // solver on an unmodified disposable case copy. Not a reactingFoam run
      // and not an inference from reading the source.
      dir: join(runRoot, "experiment", "armA-as-shipped"),
      why: "the failing target-solver run: exits 1 at the first enthalpy solve, naming the undefined scheme entry",
      dest: "armA-failing-run",
    },
    {
      dir: join(runRoot, "experiment", "armB-with-species-schemes"),
      why: "the same case with two per-species div scheme entries added: reaches the requested endTime with a normal End",
      dest: "armB-passing-run",
    },
  ];

  const prepared = await prepareConsultation({
    runRoot,
    request,
    evidenceSources,
    sourceExcerpts: excerpts,
    caseInputs,
  });

  console.log(`ok consultation prepared at ${runRoot}`);
  console.log(`   question ${questionId}`);
  console.log(`   evidence digest ${prepared.digest.slice(0, 16)}…`);
  console.log(`   briefing ${join(prepared.dir, "QUESTION.md")}`);
  console.log(`   manifest ${join(prepared.dir, "manifest.json")}`);
  console.log(`   solver digest ${solverDigest.slice(0, 16)}…  case digest ${caseDigest.slice(0, 16)}…`);
  console.log("");
  console.log("Carry the briefing and the permitted evidence to the chosen web chat.");
  console.log("Record what you added beyond transport when importing the answer.");
}

  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

await main();
