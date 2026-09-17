/**
 * Prepare the first genuinely external consultation.
 *
 * `prepare-consultation.ts` serves the internal consistency question and is
 * bound to the 1D case. This script prepares a *different* question against a
 * different evidence set: the next scientific decision, not another code review.
 *
 * The reviewer's framing is adopted directly: given the current cold-start
 * evidence and the fixed MASCOTTE conditions, what should the next bounded
 * diagnostic run measure to distinguish normal startup behaviour from a
 * thermodynamic or coupling problem?
 *
 * The request is frozen, exported as a package, and handed to the operator. The
 * operator submits it through their own authenticated web session; nothing in
 * this project holds a password, a cookie or a session token. What comes back is
 * imported by `import-consultation.ts`, which requires the answer to declare the
 * request identity it was prepared against.
 *
 * Usage:
 *   node scripts/prepare-external-consultation.ts <run-root> <attempt-dir>
 */
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { argv, exit } from "node:process";

import {
  prepareConsultation,
  type ConsultationRequest,
  type ConsultationState,
  type ProblemContract,
} from "../packages/controller/src/consultation.ts";

const SOLVER_ROOT = "/data2/kexiao/of8";
const PROFILE = join(SOLVER_ROOT, "rf-profile");
const SOLVER = join(PROFILE, "bin", "realFluidReactingFoam");
const SOLVER_SOURCE = join(SOLVER_ROOT, "realFluidFoam-8", "applications", "solvers");
const PROFILE_LIBRARIES = [
  "libreactionThermophysicalModels.so",
  "libspecie.so",
  "libchemistryModel.so",
  "libcombustionModels.so",
];

async function sha256(file: string): Promise<string> {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

/** Keeps only the excerpts that exist, so a moved file is reported rather than fatal. */
async function readableExcerpts(
  excerpts: { file: string; why: string; dest: string }[],
): Promise<{ file: string; why: string; dest: string }[]> {
  const out = [];
  for (const e of excerpts) {
    try {
      await readFile(e.file);
      out.push(e);
    } catch {
      console.error(`warning: excerpt not found: ${e.file}`);
    }
  }
  return out;
}

async function main(): Promise<void> {
  const runRoot = argv[2];
  const attemptDir = argv[3];
  if (!runRoot || !attemptDir) {
    console.error("usage: prepare-external-consultation.ts <run-root> <attempt-dir>");
    exit(2);
  }

  // The attempt's own investigation record is what makes the question
  // well-posed: it states what is established, what is open, and which bounds
  // applied. The advisor sees the evidence as the campaign recorded it.
  let investigation: {
    question: { text: string };
    outcome: { established: { claim: string }[]; remains_open: string[] };
  };
  try {
    investigation = JSON.parse(
      await readFile(join(attemptDir, "investigation.json"), "utf8"),
    );
  } catch (err) {
    console.error(
      `no investigation.json at ${attemptDir}: ${(err as Error).message}; record the investigation first`,
    );
    exit(1);
  }

  const solverDigest = await sha256(SOLVER);
  const caseDigest = await sha256(join(attemptDir, "attempt-record.json"));
  const libraryFiles = [];
  for (const rel of PROFILE_LIBRARIES) {
    const abs = join(PROFILE, "lib", rel);
    try {
      libraryFiles.push({ path: abs, digest: await sha256(abs) });
    } catch {
      console.error(`warning: profile library not measurable: ${abs}`);
    }
  }

  const state: ConsultationState = {
    solverExecutable: SOLVER,
    solverDigest,
    caseDir: attemptDir,
    caseDigest,
    profileId: "of8-realfluid",
    libraryFiles,
    relatedRunIds: ["mascotte-agile-002"],
  };

  const contract: ProblemContract = {
    fixedConstraints: [
      "The MASCOTTE G2 operating point is fixed: 5.59 MPa, LOX 44.4 g/s at 85 K, GCH4 143.1 g/s at 288 K, a 5-degree wedge, O/F 0.31",
      "The Peng-Robinson real-fluid property path is exercised: PRchungKineticMixture, chungKinetic transport, rfJanaf thermo, rfSpecie",
      "The imported target case is immutable; any change belongs in a disposable child attempt",
      "The stock OpenFOAM-8 installation must remain unchanged",
    ],
    allowedChanges: [
      "the case dictionaries in a disposable child attempt",
      "what is measured and sampled, including conserved sums and extrema",
      "whether chemistry is enabled, for a diagnostic that isolates the flow/thermo coupling",
    ],
    forbiddenChanges: [
      "the solver source",
      "the mandatory physical boundary conditions",
      "anything that promotes a change without execution evidence",
    ],
    conventions: [
      "absolute pressure, not gauge",
      "mass fractions, species order as declared in the case",
      "sampled extrema are not a time history",
      "the solver's own term 'time step continuity errors' is kept, not read as a residual",
    ],
  };

  const request: ConsultationRequest = {
    requestId: "external-diagnostic-selection",
    question:
      "A chemistry-off child of the MASCOTTE G2 agile case initializes and advances under realFluidReactingFoam, but reaches only about 1.2e-7 s of a requested 1e-5 s before a deliberately short 240 s budget stops it. The real-fluid property path is active and the sampled temperature extrema are the two inlet values. Given this cold-start evidence and the fixed operating conditions, what should the next bounded diagnostic run measure to distinguish normal startup behaviour from a thermodynamic or coupling problem? Which conserved quantities or diagnostics would discriminate, and what would each outcome imply?",
    whyNow:
      "The execution machinery is now proven: a deadline stops a run and the receipt decides the outcome. What is not known is whether the slow physical-time advance and the sampled temperature behaviour are normal for this coupled real-fluid startup or indicate a thermodynamic inconsistency. Before spending a long run, the next diagnostic should be chosen by what would discriminate.",
    contract,
    state,
    items: [
      {
        id: "O1",
        label: "observation",
        text: "A chemistry-off child of the agile MASCOTTE case initializes and advances under realFluidReactingFoam, reaching about 1.2e-7 s of a requested 1e-5 s before a 240 s wall-clock budget stopped it.",
        source: "attempt-record.json and execution-receipt.txt of mascotte-agile-002, attached",
      },
      {
        id: "O2",
        label: "observation",
        text: "The receipt records exit code 124 with wall_clock_seconds equal to budget_seconds, so the stop was the deadline and not a solver crash; the log ends mid-timestep with no normal End.",
        source: "execution-receipt.txt, attached",
      },
      {
        id: "O3",
        label: "observation",
        text: "The Peng-Robinson real-fluid property path is active throughout: PRchungKineticMixture, chungKinetic transport, rfJanaf thermo, rfSpecie.",
        source: "the solver log, attached",
      },
      {
        id: "O4",
        label: "observation",
        text: "The last sampled temperature extrema are the two inlet values, 85 K and 288.26 K, which is what chemistry-off flow at this operating point should show; the maximum drifts slowly upward across the sampled window.",
        source: "temperature-samples.txt, attached; sampled values, not a time history",
      },
      {
        id: "O5",
        label: "observation",
        text: "The adjustable time step grows during the run, from about 1.2e-8 to about 1.0e-7, so the solver is responding to the flow rather than stuck at the initial step.",
        source: "deltat-history.txt, attached",
      },
      {
        id: "H1",
        label: "hypothesis",
        text: "The slow advance in physical time is the coupled real-fluid startup at 5.59 MPa resolving the LOX/CH4 interface, not a pathology.",
        source: "worker reading the logs; untested",
      },
      {
        id: "H2",
        label: "hypothesis",
        text: "The slow upward temperature drift is wall or inlet coupling warming the domain.",
        source: "worker reading the sampled series; untested, and the window is far too short to characterise a rate",
      },
      {
        id: "N1",
        label: "not_established",
        text: "Whether the run would reach the requested end time given a full budget. Only about 1.2 percent of the interval was covered.",
        source: "the budget stopped the run by design",
      },
      {
        id: "N2",
        label: "not_established",
        text: "Whether the conserved sums hold: sum(Y), total enthalpy, and mass balance have not been examined in any run.",
        source: "no conservation check has been made",
      },
      {
        id: "N3",
        label: "not_established",
        text: "Whether the sampled temperature extrema verify both inlet boundary conditions; the extrema alone do not identify a cause for the drift.",
        source: "only min/max(T) is sampled",
      },
    ],
    attempts: [
      "imported the MASCOTTE G2 case and validated it on the pinned build",
      "materialised a chemistry-off child with the per-species scheme entries derived from the mechanism",
      "ran the child through the shared execution backend with a 240 s budget",
      "assessed the outcome from the receipt and the log together",
    ],
    workerInterpretation:
      "The startup is real and the machinery is proven, but I have only sampled extrema and a very short window. I cannot tell whether the slow physical-time advance and the temperature drift are normal for this coupled real-fluid startup or indicate a thermodynamic inconsistency. Before spending a long run I want the next diagnostic chosen by what would discriminate.",
    availableActions: [
      "edit the case dictionaries in a disposable child attempt",
      "choose what is sampled, including conserved sums and extrema over time",
      "run a bounded serial solver job through the controller",
      "enable chemistry for a diagnostic that isolates the flow/thermo coupling",
    ],
    limits: [
      "the solver source is read-only for this consultation",
      "the imported target case is immutable; changes belong in a child",
      "the budget is one or two short serial runs",
      "the stock OpenFOAM-8 installation must not change",
    ],
    responseRequested: [
      "which conserved quantities or diagnostics would discriminate normal startup from a coupling problem, and why those",
      "what each possible outcome would imply, so the diagnostic is informative either way",
      "the smallest bounded run that carries that discrimination",
      "any prerequisite or artifact I have not attached, rather than an inference",
    ],
    createdAt: new Date().toISOString(),
  };

  // Evidence the advisor needs: the attempt's own records, the receipt, the
  // solver's equation set, and the case dictionaries.
  const excerpts = [
    {
      file: join(SOLVER_SOURCE, "realFluidReactingFoam", "EEqn.H"),
      why: "the energy equation, where the real-fluid enthalpy flux terms enter",
      dest: "realFluidReactingFoam/EEqn.H",
    },
    {
      file: join(SOLVER_SOURCE, "realFluidReactingFoam", "YEqn.H"),
      why: "the species equation and its mixture-averaged diffusion correction",
      dest: "realFluidReactingFoam/YEqn.H",
    },
  ];
  for (const e of excerpts) {
    try {
      await readFile(e.file);
    } catch {
      console.error(`warning: excerpt not found: ${e.file}`);
    }
  }

  const prepared = await prepareConsultation({
    runRoot,
    request,
    evidenceSources: [
      {
        dir: attemptDir,
        why: "the attempt directory: the receipt, the records, and the case as prepared",
        dest: "attempt",
      },
    ],
    sourceExcerpts: await readableExcerpts(excerpts),
    caseInputs: [
      {
        dir: join(attemptDir, "constant"),
        why: "the prepared case dictionaries, including the thermophysical and chemistry selection",
        dest: "constant",
      },
      {
        dir: join(attemptDir, "system"),
        why: "the schemes and the control settings as they ran",
        dest: "system",
      },
    ],
  });

  console.log(`ok external consultation prepared at ${runRoot}`);
  console.log(`   question ${request.requestId}, revision ${prepared.revision}`);
  console.log(`   evidence digest ${prepared.digest.slice(0, 16)}…`);
  console.log(`   briefing ${join(prepared.dir, "QUESTION.md")}`);
  console.log(`   manifest ${join(prepared.dir, "manifest.json")}`);
  console.log(`   solver ${solverDigest.slice(0, 16)}…  attempt ${caseDigest.slice(0, 16)}…  libs ${libraryFiles.length}`);
  console.log("");
  console.log("export the package and submit it through an authenticated web session;");
  console.log("the request id and digest above must come back with the answer.");
  console.log(
    `   request id     ${request.requestId}`,
  );
  console.log(`   request digest ${prepared.digest}`);
}

await main();
