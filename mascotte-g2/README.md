# MASCOTTE G2 target case

This directory is the target case for EvoCFD: the **Layer 5 (case and evaluation)**
asset that the agentic CFD loop works against. It is a clean, version-controlled
target definition for a MASCOTTE G2 LOX/GCH4 calculation with the `realFluidFoam-8`
family — a mesh, explicit time-zero fields, experimental boundary conditions, a JL9
finite-rate mechanism, real-fluid thermodynamics, and digitized validation evidence.

It deliberately contains no developed restart, decomposed field, scheduler log, or
result data. A run is produced by copying this target into a child attempt
directory, never by developing results here.

## Role in EvoCFD

EvoCFD's five layers are: LLM (used as-is), agent and harness, CFD solver, physical
and numerical models, and **case and evaluation**. This directory is the fifth layer.
Concretely:

- The solver is the pinned `realFluidFoam-8` package built with isolated outputs
  (`of8-realfluid` profile), recorded in [`../cfd-baseline/baseline.json`](../cfd-baseline/baseline.json).
- The physical contract is [`case-lock.yaml`](case-lock.yaml): what is immutable,
  what is tunable, and what may never appear in the target.
- The evaluation evidence is [`evidence/`](evidence/): digitized experimental and
  paper fields, rights metadata, and the required result bundle.
- A trial that claims to have improved the harness or the numerics must show it on
  this case, through the controller's job-lifecycle primitive, and be assessed from
  the solver's own log rather than from an assertion.

## Intended use

1. Treat [`case-lock.yaml`](case-lock.yaml) as the physical contract.
2. Run `./Allcheck` before creating an attempt.
3. Copy a case directory to a new run directory. Never develop results in the target.
4. Change only entries marked `tunable`. Any proposed geometry or experimental-BC
   change creates a new target version and requires a written rationale.
5. Keep large results outside this directory and record their lineage separately.

Select the agile variant:

```bash
CASE_DIR="$PWD/cases/agile-80mm" ./Allcheck
CASE_DIR="$PWD/cases/agile-80mm" NP=16 ./Allrun
```

## Which executable to run

The package provides three solvers, and they are not interchangeable:

| executable | role |
|---|---|
| `realFluidFoam` | the solver the shipped `Allrun` and `controlDict` name; a reacting multispecies real-fluid solver |
| `reactingFoam` | the package's modified-physics build of stock `reactingFoam`; real-fluid properties, but without the species-diffusion enthalpy flux terms |
| `realFluidReactingFoam` | carries the extra per-species `fvc::div(hei[k]*rho*YVi[k])` enthalpy flux and the mixture-averaged diffusion correction |

The EvoCFD-pinned target solver is `realFluidReactingFoam`. Running this case under
it needs one documented adaptation, discovered and proven in the
[`target-solver-001`](../docs/reviews/target-solver-001/) experiment: the shipped
`fvSchemes` was written for `realFluidFoam` and lacks the per-species scheme entries
`realFluidReactingFoam` looks up. With 10 species the loop covers all of them:

```diff
     div(((rho*nuEff)*dev2(T(grad(U))))) Gauss linear;
+    div(((hei_CH4*rho)*YVi_CH4))  Gauss linear;
+    ...one entry per species...
```

Apply that in a **child attempt directory**, not here. Scheme entries are `tunable`
under the case lock, but the immutable target must stay as shipped so that every
attempt starts from one identifiable state.

## Target operating point

| Quantity | Full experiment | 5° wedge value used here | Status |
|---|---:|---:|---|
| Chamber pressure | 5.59 MPa | 5.59 MPa | locked |
| LOX mass flow | 44.4 g/s | 0.6166667 g/s | locked |
| GCH4 mass flow | 143.1 g/s | 1.9875 g/s | locked |
| LOX temperature | 85 K | 85 K | locked |
| GCH4 temperature | 288 K | 288 K | locked |
| O/F | 0.31 | unchanged by sector scaling | validation check |

The values are reported for G2 in Candel et al. (2006), Table 1. Sector rates are
full-annulus rates multiplied by `5/360`.

## Case contents

- `cases/full-200mm`: immutable validation-domain case, 200,622 cells.
- `cases/agile-80mm`: mechanically subset 106,782-cell case for fast development
  tests; **not** a validation domain.
- Each case has explicit time-zero fields. The chamber begins as CH4 at 288 K, the
  two feed passages are prefilled by their own fluids, and velocity begins at zero.
  This is a numerical initialization choice, not an experimental claim.
- `constant/thermo.inputData`: 10-species real-fluid property input.
- `constant/reactions`: modified Jones–Lindstedt, 9 reactive species plus inert N2,
  6 global reactions.
- `mechanisms/ramec17`: optional CNF-RAMEC profile with 17 reactive species plus N2
  and 44 reactions, including Cantera, CHEMKIN and OpenFOAM representations.
- `constant/thermophysicalProperties`: Peng–Robinson EOS, real-fluid JANAF calorics
  and Chung/Takahashi transport.
- `evidence/`: curated paper facts, digitized fields, provenance and acceptance
  targets; only explicitly CC-licensed PDFs are included.
- `docs/ATTEMPT-HISTORY.md`: what was tried, what failed, and what remains unproven.
- `SHA256SUMS`: byte-level manifest for this package, regenerated after any change.
  Hashes are computed over LF-normalized text, which is what this repository stores
  (`.gitattributes`, `* text=auto eol=lf`). Binary files are hashed as-is.

## Fixed and tunable boundaries

Do not change without creating a new target version:

- mesh topology, patch names and 5° sector angle;
- experimental pressure, mass-flow rates and inlet temperatures;
- pure CH4 and pure O2 inlet compositions;
- physical injector/chamber dimensions represented by this mesh.

Expected to change between child attempts:

- chamber-fill species at time zero, provided the choice is documented;
- inlet ramp duration;
- chemistry on/off and ignition method;
- timestep/Courant policy, PIMPLE correctors, solvers, schemes and relaxation;
- turbulence/combustion closure;
- mechanism, EOS, mixing rule and transport model, provided the branch name and
  validation comparison identify the change.

The included JL9/PR/Chung setup is the default baseline, not a claim that it is
uniquely correct. RAMEC17 is included as a larger comparison mechanism and must be
activated into a new child case; it does not silently replace JL9.

## Current maturity

The mesh passes `checkMesh`. A closely related chemistry-off CH4-chamber case
advanced to about 3.49 ms before its wall-time allocation ended. It was bounded
enough to produce useful cold-mixing evidence, but it was not demonstrated
stationary and showed pressure excursions and a 50 K temperature clamp. Reacting
restarts using finite-duration heat sources did not produce a validated sustained
flame: several over-heated toward the 5000 K guard, while weaker pulses decayed or
failed to generate a durable OH-bearing kernel. Species-sum behavior was sensitive
to chamber initialization, with CH4 fill substantially better behaved than O2 fill.

Therefore this package is **target-ready, not validated-result-ready**. A successful
run must pass conservation and boundedness gates and then match the experimental and
paper observables in [`evidence/`](evidence/).

## Minimum acceptance gate

- no NaN, solver abort, persistent limiter domination, or unphysical species sum;
- documented mass conservation and pressure/density consistency;
- sustained heat release after any external ignition source is removed;
- attached flame without an unsupported lift-off artifact;
- no unexplained extra inner high-speed jets;
- temperature, OH/OH-proxy and flame length compared on common coordinates/scales;
- experimental reference: time-averaged OH* Abel transform; reported flame length
  near 11 oxygen-injector diameters is a useful paper-level check, not a sufficient
  validation by itself.

## Provenance and licensing

Curated facts, DOIs, hashes and explicitly licensed source figures are recorded in
[`evidence/sources.yaml`](evidence/sources.yaml), which carries per-source access and
redistribution status. Only CC-licensed PDFs are included in `evidence/papers/`:

- Cavalieri et al. (2025), CC BY 4.0, DOI 10.1016/j.ijheatmasstransfer.2025.127284
- De Giorgi et al. (2014), CC BY 3.0, DOI 10.3390/en7010477

Restricted and team-authorized sources are cited by DOI and hash but their bytes are
not redistributed here. See [`evidence/README.md`](evidence/README.md).
