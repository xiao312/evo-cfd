# target-solver-001 — the target solver runs

**Question.** Does the pinned `realFluidReactingFoam` build run at all on a correctly
configured case, and what is the smallest defensible set of case changes required to
exercise its intended equations?

**Status: closed by experiment.** The observed startup failure was caused by missing
per discretization entries; adding them was sufficient for this short test to complete.
That does not rule out defects elsewhere in the solver, and it does not establish that
the entries are the only change a full reacting MASCOTTE case would need.

## Why this was not obvious

Every upstream tutorial in `realFluidFoam-8` specifies `application reactingFoam`.
None runs the target solver. The target solver's `EEqn.H` contains an explicit term
the package's `reactingFoam` does not:

```cpp
sumHeatDiffusion2 += fvc::div(hei[k]*rho*YVi[k]);
```

OpenFOAM turns that expression into the scheme lookup
`div(((hei_O2*rho)*YVi_O2))`, which no shipped case declares. The failure surfaces as
a fatal IO error at the first enthalpy solve, not as a message mentioning a missing
feature.

## The experiment

Two arms, one disposable copy each of the retained reference case, run on the host
under the profile env file. The container cannot run the host-built solver
(`libmpi.so.40` absent), so this used the same three-phase boundary as `cfd-job-001`.

| arm | change | exit | outcome |
|---|---|---|---|
| A as shipped | none | 1 | `keyword div(((hei_O2*rho)*YVi_O2)) is undefined in fvSchemes/divSchemes` |
| B with species schemes | two lines, see `changes/fvSchemes.diff` | 0 | normal `End`, 200 steps, last reported time `0.002` = requested `endTime` |

The change, in full:

```diff
     div(((rho*nuEff)*dev2(T(grad(U))))) Gauss linear;
+    div(((hei_O2*rho)*YVi_O2))  Gauss linear;
+    div(((hei_N2*rho)*YVi_N2))  Gauss linear;
```

`Gauss linear` was chosen to match this case's own convention for explicit
non-convective divergence terms — the `dev2(T(grad(U)))` entry immediately above is
the same class of term. `limitedLinear 1` is the alternative if boundedness of the
species-enthalpy flux matters; it was not needed to run.

Both species are covered because `EEqn.H` loops over all of `Y`, not only the active
species: the case carries O2 (active) and N2 (inert).

## What the result establishes

- The observed startup failure was caused by missing discretization entries, and
  adding them was sufficient for this short test to complete. It does not rule out
  defects elsewhere in the solver.
- The Peng-Robinson property path is exercised, not merely selected:
  `PRchungKineticMixture`, `PengRobinson`, `chungKinetic`, `rfJanaf`, `rfSpecie`,
  `PRchungKineticStandardChemistryModel`.
- Against the package's own `reactingFoam` on the same case (`cfd-job-001`), the last
  sampled max T is 368.475 K against 368.537 K — a difference of about 0.06 K. The two
  solvers do not diverge over 200 steps. **The direction and magnitude of this
  difference are not established as the expected effect of any particular term.** The
  comparison changes solver implementations in three coupled places — the
  species-diffusion enthalpy flux terms, the replaced heat-flux closure, and the
  mixture-averaged diffusion correction in the species equation — and it compares two
  scalar extrema rather than the full temperature fields.

## Caveats, stated as caveats

- min/max(T) values are the **last sampled line** of each log, not a time history, and
  cannot bound the field over the run.
- "time step continuity errors" is the solver's own term, recorded as such; it is not
  read as a linear-solver residual or a proof of convergence.
- 200 steps at `deltaT 1e-5` to `endTime 0.002` is a short window. This establishes
  that the intended equations *can be exercised*. It does not establish that the case
  is physically correct, converged in space, or fit for the MASCOTTE comparison.
- The 0.06 K agreement is a single sampled comparison against one baseline run, not a
  statistic and not a validation.

## How this bundle was produced

Prepared while assembling the first scientific consultation. The consultation layer
requires every claimed observation to be backed by a real artifact, and the first
attempt failed that requirement twice — see `docs/EXPERIMENTS.md`. Verifying the
failing-run claim was itself the discriminating experiment, so the question closed
before any advice was sent. That is the layer working as designed: advice must be
verified through execution, and here verification happened first.

## Records

- `records/experiment.json` — machine-readable summary, digests, hypotheses, caveats
- `records/armA-as-shipped.log` — the failing run
- `records/armB-with-species-schemes.log` — the passing run
- `records/digests.txt` — sha256 of each record
- `changes/fvSchemes.diff` — the complete change

Tested at commit `7a5368e`.
