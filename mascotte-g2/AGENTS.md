# MASCOTTE G2 workspace — agent guidance

This directory is the target case for EvoCFD's agentic CFD loop. It is the fifth
layer of the project: **case and evaluation**. Everything here is evidence and
contract, not a result.

## What this case is for

- The loop improves the **harness, skills, numerics and models** — never model
  weights. This case is the application-level target for performance and
  physical-validation claims; candidate admission and intermediate regression
  testing may use smaller fixtures, and application validation uses execution
  records, numerical fields and diagnostics, and the defined experimental
  observation comparisons — not solver logs alone.
- The physical contract is [`case-lock.yaml`](case-lock.yaml). Read it, and
  [`README.md`](README.md), before proposing or launching anything.
- The evaluation evidence is [`evidence/`](evidence/). Treat literature, experiment
  and prior-run evidence as distinct sources; `evidence/sources.yaml` records the
  rights status of each.

## Rules that are easy to break

- **Never develop results in this directory.** Copy a case into a child attempt
  directory and work there, and run  on the *child*, not on the target.
  The target stays byte-identical so every attempt starts from one identifiable
  state. Note that  hides the outputs of an in-place run from Git
  status; that is housekeeping, not protection, and it does not undo a write.
  EvoCFD's supported launcher refuses paths inside this tree.
- **Run `./Allcheck` before creating an attempt.** It checks that required fields and
  dictionaries exist and that the mesh still passes `checkMesh`.
- **Change only entries marked `tunable`** in `case-lock.yaml`. A proposed geometry or
  experimental-BC change creates a new target version with a written rationale.
- **Never label an iteration count, a scheduler completion, or a high iteration count
  as convergence, stationarity, or validation.** These are different claims and the
  distinction is preserved everywhere in this project.
- **Never accept a run solely because it continued.** Species-sum boundedness and
  mass conservation must be shown, not inferred from the absence of a crash.
- **Do not commit result fields, decomposed processor directories, solver logs,
  scheduler output, or secrets.** `SHA256SUMS` is the byte-level manifest for this
  package and is regenerated whenever the package changes.

## Numerical findings inherited by EvoCFD

These came from the attempt history ([`docs/ATTEMPT-HISTORY.md`](docs/ATTEMPT-HISTORY.md))
and from EvoCFD's own experiments. They are starting knowledge, not conclusions:

- The pinned target solver is `realFluidReactingFoam`. The shipped `fvSchemes` was
  written for `realFluidFoam` and lacks the per-species `div(((hei_*rho)*YVi_*))`
  scheme entries; add them in a child attempt, one per species. Proven in
  [`target-solver-001`](../docs/reviews/target-solver-001/).
- Direct hot-patch ignition generates strong pressure waves into the slow LOX
  passage and was rejected as a primary strategy.
- Finite-duration energy-budgeted heat sources have been screened: weak pulses decay,
  strong pulses hit the 5000 K guard. Neither is accepted as a sustained flame.
- Chamber fill matters: CH4 fill was substantially better behaved than O2 fill. The
  experiment does not prescribe the fill; it is a documented numerical choice.
- Mechanism complexity alone did not remove the ignition and coupling failure.
- Inlet-only heating has not worked at either 1200 K or 1800 K: the hot gas must
  first travel through the feed passage. Preheating the entire CH4 passage is
  more effective, and both hot-passage cases produced substantial temperature
  rise and OH. The selected next baseline is a clean start with a moderately
  preheated CH4 passage (about 1400 K) and a matching hot inlet, then a smooth
  ramp to 288 K after a kernel forms. See
  [`docs/IGNITION-STRATEGY.md`](docs/IGNITION-STRATEGY.md) and
  [`ignition-baseline.yaml`](ignition-baseline.yaml), and read its three
  reconciliation notes before materializing.

## Failure modes worth remembering

1. **Species boundedness** — transient overshoot can smooth later; O2-filled starts
   were worse.
2. **Pressure/species/energy coupling** — real-fluid property corrections, heat
   release and pressure correction can amplify one another during ignition.
3. **Ignition placement** — heating too close to the injector sends a pressure
   disturbance upstream before the slow LOX passage can equilibrate.
4. **Ignition strength** — total injected energy alone is not sufficient; spatial
   concentration, duration, mixed-cell availability and post-pulse chemistry matter.
5. **Cold-field maturity** — ignition from an underdeveloped mixing field can fail
   even with an adequate mechanism.
6. **Validation** — a hot field is not a flame. Require sustained heat release and OH
   after source removal, plus experimental spatial comparison.

## Working with the evidence

- Candel's observable is line-of-sight OH* processed by Abel inversion. OH mass
   fraction is related but **not identical**; do not treat OH, OH* chemiluminescence
   and an OH* proxy as interchangeable observables.
- Cavalieri uses a 3D square chamber and much finer LES meshes; this 5° wedge cannot
  reproduce square-corner or full 3D turbulent structures.
- De Giorgi's axisymmetric area-equivalent model and SRK closure differ from this
  wedge/PR baseline.
- A numerical match produced by changing experimental mass flow, temperature or
  pressure is not accepted.
- The digitized reference fields are relative, not absolute, unless the manifest says
  otherwise. Read [`evidence/README.md`](evidence/README.md) before comparing.

## How to propose a change through the loop

1. State the bounded hypothesis and the evidence that would support *and* conflict
   with it. A proposal admitted is not a proposal promoted.
2. Copy the case into a child attempt directory; apply only `tunable` changes.
3. Run through the controller (`scripts/run-cfd-job.ts plan|run|assess`) so the plan,
   the execution and the assessment are recorded as separate phases.
4. Report from the solver's log: last reported time, whether the run terminated
   normally, species-sum extrema, and mass balance. Sampled values are not a history.
5. Compare against `evidence/` on common coordinates and scales, and record what is
   not established.
