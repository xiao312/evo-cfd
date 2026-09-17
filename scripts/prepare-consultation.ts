/**
 * Prepare a scientific consultation and export it for a web chat.
 *
 * Route A of the reviewer's design: EvoCFD writes a frozen briefing, a human
 * carries it to the chosen web application, and the answer comes back through
 * import-consultation.ts. That is a genuine external consultation with human
 * transport, not a substitute for one. The mode is recorded on import, so a
 * same-model self-review can never be mistaken for an external advisor.
 *
 * The first briefing asked which case changes the target solver needed. That
 * question is closed by experiment: two per-species div scheme entries suffice
 * for the two-species reference case to complete a short interval
 * (target-solver-001). This briefing therefore asks the question that remains
 * open — whether the small difference between the target solver and the
 * package's reactingFoam is the physical effect of the different transport
 * closures or a sign of inconsistency — and ships the species and energy
 * equations of both solvers, because the difference lives in the species
 * equation as much as in the energy equation.
 *
 * Usage:
 *   node scripts/prepare-consultation.ts <run-root> [question-id]
 */
import { join } from "node:path";
import { mkdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { argv, exit } from "node:process";

import {
  digestPath,
  prepareConsultation,
  type ConsultationRequest,
  type ConsultationState,
  type ProblemContract,
} from "../packages/controller/src/consultation.ts";

const SOLVER_ROOT = process.env.EVOCFD_SOLVER_ROOT ?? "/data2/kexiao/of8";
const REPO_ROOT = process.env.EVOCFD_HOST_ROOT ?? ".";
const PROFILE = join(SOLVER_ROOT, "rf-profile");
const SOLVER = join(PROFILE, "bin", "realFluidReactingFoam");
const CASE_SOURCE = join(SOLVER_ROOT, "rf-cases", "1D_advection");
const SOLVER_SOURCE = join(SOLVER_ROOT, "realFluidFoam-8", "applications", "solvers");
const EXPERIMENT = join(REPO_ROOT, "runs", "consultation-001", "experiment");

/** The profile libraries that decide which physics a run gets. */
const PROFILE_LIBRARIES = [
  "lib/libcombustionModels.so",
  "lib/libreactionThermophysicalModels.so",
  "lib/librfFluidThermophysicalModels.so",
  "lib/libspecie.so",
  "lib/libturbulenceModels.so",
];

async function sha256(file: string): Promise<string> {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

async function main(): Promise<void> {
  const runRoot = argv[2];
  if (!runRoot) {
    console.error("usage: prepare-consultation.ts <run-root> [question-id]");
    exit(2);
  }
  const questionId = argv[3] ?? "target-solver-consistency";
  await mkdir(runRoot, { recursive: true });

  // Freeze the computational state: the executable, the case inputs, and the
  // profile libraries. The libraries matter because the package ships
  // libraries with stock-identical SONAMES, so an unchanged executable can
  // resolve different physics depending on directory order.
  const solverDigest = await sha256(SOLVER);
  const caseDigest = await digestPath(CASE_SOURCE);
  const libraryFiles = [];
  for (const rel of PROFILE_LIBRARIES) {
    const abs = join(PROFILE, rel);
    try {
      libraryFiles.push({ path: abs, digest: await sha256(abs) });
    } catch {
      console.error(`warning: profile library not measurable: ${abs}`);
    }
  }
  const state: ConsultationState = {
    solverExecutable: SOLVER,
    solverDigest,
    caseDir: CASE_SOURCE,
    caseDigest,
    profileId: "of8-realfluid",
    libraryFiles,
    relatedRunIds: ["1D-advection-001", "target-solver-001"],
  };

  const contract: ProblemContract = {
    fixedConstraints: [
      "The Peng-Robinson real-fluid property path must be exercised: PRchungKineticMixture, chungKinetic transport, rfJanaf thermo, rfSpecie",
      "The species set and the inlet/initial conditions of the reference case are mandatory",
      "The stock OpenFOAM-8 installation must remain unchanged",
    ],
    allowedChanges: [
      "the case dictionaries in a disposable copy",
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
      "sampled extrema are not a time history",
    ],
  };

  const request: ConsultationRequest = {
    requestId: questionId,
    question:
      "On the same two-species case, the target solver realFluidReactingFoam and the package's reactingFoam both complete the requested interval, but their last sampled maxima differ by about 0.06 K in 368. The two solvers differ in three coupled places, not one: the species-diffusion enthalpy flux terms in the energy equation, the replaced heat-flux closure, and the mixture-averaged diffusion correction in the species equation. Given the attached sources and both runs, is this difference consistent with the different transport closures, or is it a sign of an inconsistency I should chase before trusting this solver? What bounded experiment would discriminate?",
    whyNow:
      "The startup configuration gap is closed, so the remaining question is whether the target solver runs the right equations rather than whether it runs at all. This case has no chemical reaction and no validation data, so the reactingFoam comparison is the only check available, and it is a single sampled comparison of two extrema.",
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
        id: "E3",
        label: "observation",
        text: "Adding two div scheme entries for O2 and N2 makes the same case run: exit 0, 200 time steps at deltaT 1e-5, last reported time 0.002 equals the requested endTime, normal End, Peng-Robinson property path throughout.",
        source: "experiment/armB-with-species-schemes, attached; the two-line diff is in target-solver-001",
      },
      {
        id: "E4",
        label: "observation",
        text: "The target solver's last sampled min/max(T) is 139.214/368.475 K; the package's reactingFoam on the same case gives 139.214/368.537 K.",
        source: "the last min/max(T) line of each log",
      },
      {
        id: "E5",
        label: "observation",
        text: "The two solvers' equations differ in three coupled places: `sumHeatDiffusion`/`sumHeatDiffusion2` in the target's energy equation, the removal of `thermophysicalTransport->divq(he)` in favour of an explicit laplacian, and the mixture-averaged diffusion correction in the target's species equation.",
        source: "the attached EEqn.H and YEqn.H of both solvers",
      },
      {
        id: "H1",
        label: "hypothesis",
        text: "The temperature difference is the combined effect of the different species and heat transport closures, not of one term.",
        source: "worker reading the attached sources",
      },
      {
        id: "H2",
        label: "hypothesis",
        text: "The magnitude of the difference is set by the sharp interface in this 1D advection case, where every diffusion term acts with maximum strength, rather than by the bulk physics.",
        source: "the case is by construction a discontinuity advection case",
      },
      {
        id: "N1",
        label: "not_established",
        text: "Whether the difference would persist, shrink, or grow on a smoothed interface or a longer interval. Only first and last sampled values are available; no time history of any quantity has been examined.",
        source: "no such run has been made",
      },
      {
        id: "N2",
        label: "not_established",
        text: "Whether the failing arm's state was thermodynamically admissible, and whether the conserved sums (sum(Y), total enthalpy, mass balance) hold in either run.",
        source: "no conservation check has been made",
      },
    ],
    attempts: [
      "built the package with isolated outputs; stock OF8 verified unchanged",
      "ran the package's reactingFoam on the reference case; reached the requested end time",
      "ran the target solver on the unmodified case; failed at startup with the scheme error",
      "added the two per-species div scheme entries; the target solver reached the requested end time",
    ],
    workerInterpretation:
      "The startup gap is closed and is not in doubt. What I cannot do is attribute the 0.06 K: the two solvers differ in three coupled places, I have only two sampled extrema, and I have not checked the conserved sums. My working hypothesis is that the difference is the combined transport-closure effect modulated by the sharp interface, but that is a reading of the equations, not a measurement.",
    availableActions: [
      "edit the case dictionaries in a disposable copy",
      "run a short bounded solver job through the controller",
      "smooth the initial interface in a disposable copy",
    ],
    limits: [
      "the solver source is read-only for this consultation",
      "the budget is one or two short serial runs",
      "the stock installation must not change",
    ],
    responseRequested: [
      "ranked explanations with the evidence supporting and conflicting with each",
      "the smallest bounded experiment that would discriminate between them",
      "what each explanation predicts, so the result is informative either way",
      "which conserved quantities I should sample over time, and why those",
      "any prerequisite or artifact I have not attached, rather than an inference",
    ],
    createdAt: new Date().toISOString(),
  };

  const excerpts: { file: string; why: string; dest: string }[] = [
    {
      file: join(SOLVER_SOURCE, "realFluidReactingFoam", "EEqn.H"),
      why: "the target solver's energy equation, with the species-diffusion enthalpy flux terms",
      dest: "realFluidReactingFoam/EEqn.H",
    },
    {
      file: join(SOLVER_SOURCE, "realFluidReactingFoam", "YEqn.H"),
      why: "the target solver's species equation, with the mixture-averaged diffusion correction; the difference from the baseline lives here as much as in the energy equation",
      dest: "realFluidReactingFoam/YEqn.H",
    },
    {
      file: join(SOLVER_SOURCE, "realFluidReactingFoam", "createFields.H"),
      why: "declares the per-species YVi and hei fields the scheme entries must name",
      dest: "realFluidReactingFoam/createFields.H",
    },
    {
      file: join(SOLVER_SOURCE, "reactingFoam", "EEqn.H"),
      why: "the baseline energy equation, without the species-diffusion enthalpy flux terms",
      dest: "reactingFoam/EEqn.H",
    },
    {
      file: join(SOLVER_SOURCE, "reactingFoam", "YEqn.H"),
      why: "the baseline species equation, for side-by-side comparison of the diffusion closure",
      dest: "reactingFoam/YEqn.H",
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
      dir: join(EXPERIMENT, "armA-as-shipped"),
      why: "the failing target-solver run: exits 1 at the first enthalpy solve, naming the undefined scheme entry",
      dest: "armA-failing-run",
    },
    {
      dir: join(EXPERIMENT, "armB-with-species-schemes"),
      why: "the passing target-solver run: reaches the requested endTime with a normal End",
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
  console.log(`   question ${questionId}, revision ${prepared.revision}`);
  console.log(`   evidence digest ${prepared.digest.slice(0, 16)}…`);
  console.log(`   briefing ${join(prepared.dir, "QUESTION.md")}`);
  console.log(`   manifest ${join(prepared.dir, "manifest.json")}`);
  console.log(
    `   solver ${solverDigest.slice(0, 16)}…  case ${caseDigest.slice(0, 16)}…  libs ${libraryFiles.length}`,
  );
  console.log("");
  console.log("Carry the briefing and the permitted evidence to the chosen web application.");
  console.log("On import, record the mode and, for an external round, the conversation");
  console.log("reference. Record what you added beyond transport.");
}

await main();
