# mascotte-startup-001 — MASCOTTE G2 runs under realFluidReactingFoam

## Question

Can the imported MASCOTTE G2 case run at all under the pinned target solver
`realFluidReactingFoam`, once the documented per-species scheme entries are
present? This is the first use of the layer-5 asset, so the question is
deliberately the smallest one worth answering: does it start, does it solve,
does it advance in physical time, with the real-fluid property path active.

This is a **startup qualification**, not a validation run. Chemistry is off and
the end time is far short of the case's own. Nothing here bears on combustion
accuracy.

## Why this needed a child attempt and not the target

The imported `Allcheck` writes `checkMesh.current.log` into the case it checks,
and the imported `Allrun` decomposes that case and writes solver results into
it. `.gitignore` hides those outputs from Git status, which is housekeeping
rather than protection — ignore rules do not prevent filesystem writes, and the
README's agile example pointed `CASE_DIR` directly at the imported directory.
Following that example modifies the immutable target.

`scripts/prepare-mascotte-attempt.ts` is the supported path instead. It
materialises a child attempt in `runs/mascotte/` and refuses a destination
inside the target tree.

## Command

```bash
# materialise, in the campaign container
node --experimental-strip-types scripts/prepare-mascotte-attempt.ts \
  --job mascotte-agile-001 --variant agile-80mm --ranks 1 \
  --chemistry off --end-time 1e-4 --budget 900

# execute, on the host (the solver is host-built; see the three-phase boundary)
cd /data2/kexiao/EvoCFD/runs/mascotte/mascotte-agile-001 && bash Allrun-child
```

## What the attempt changed, and why

All five changes are recorded in `records/attempt-record.json` and are
re-derived rather than assumed:

| Change | Why |
|---|---|
| `controlDict application realFluidFoam → realFluidReactingFoam` | the imported `Allrun` invokes `realFluidFoam`; changing `controlDict` alone would not change what runs |
| `controlDict endTime 0.005 → 1e-4` | a bounded startup qualification is bounded by physics, not only by wall clock |
| `fvSchemes`: 10 per-species `div(((hei_*rho)*YVi_*))` entries | proven necessary in `target-solver-001`; derived here from the selected mechanism's own species list, so the count cannot go stale after a mechanism switch |
| `chemistryProperties chemistry on → off` | startup qualification with the reaction source off isolates the flow/thermo coupling |
| `decomposeParDict numberOfSubdomains 16 → 1, method scotch → simple` | the pinned OF8 build carries dummy Scotch libraries, so `scotch` is not qualified; serial qualification avoids the question entirely |

The 10 entries are the mechanism's own species — CH4, O2, CO, H2, H2O, O, H,
OH, CO2, N2 — including the inert N2, because the energy equation loops over
all of Y.

40 input files were copied and each verified byte-identical against
`mascotte-g2/SHA256SUMS`. Directories are copied recursively; an earlier
files-only copy silently dropped `constant/polyMesh` and `checkMesh` then failed
looking for `points`.

## Observed

Allcheck passed on the child (all structure checks and the mesh check), and the
solver started and advanced. Over the sampled window:

- 20 time steps, reaching `Time = 1.7861731e-06`
- `deltaT` grew from `1.1990408e-08` to `2.9335096e-07`, i.e. the adjustable time
  step is responding to the flow, not stuck
- last sampled `min/max(T) = 85, 288.59 K`
- the last sampled solver-reported time step continuity error has cumulative
  `-3.24e-10`
- the Peng–Robinson property path is active in the log (`PengRobinson`,
  `PRchung`)

`records/time-history.txt`, `deltat-history.txt` and `temperature-samples.txt`
are the full sampled series, not a summary.

## Interpretation, and what this does *not* establish

The temperature range is the two inlet temperatures — LOX at 85 K and GCH4 at
288 K — which is what chemistry-off flow should show. That the two inlets are
both present and at their stated temperatures is a meaningful check on the case
wiring, and it is the only temperature statement available here.

The temperature drifts slowly upward over the window (288.13 → 288.59 K at the
last sample), consistent with the hot wall / cold inlet coupling warming the
domain. That is an observation of the sampled series, not a rate measurement:
the window is far too short to characterise a trend.

Per the project's standing corrections, three limits apply:

1. **These are sampled values, not a time history of a bound.** "min/max(T) =
   85, 288.17" is the last sampled line; it does not bound temperature over the
   run.
2. **"Time step continuity errors" is the solver's own term and is recorded as
   such**, not read as a residual or a convergence measure.
3. **This is not validation.** Chemistry was off, the window is ~1/100th of the
   requested physical time at a fraction of the case's own end time, and no
   comparison to the reference experiment is attempted. Nothing here bears on
   combustion accuracy or on the transport-closure question that
   `consultation-001` left open.

The run was stopped by the operator before its (physically unreachable in the
time available) end time; the launcher now enforces the wall-clock budget
itself so a later run is bounded by the record rather than by an operator.

That latter point is not theoretical here: the first stop attempt sent SIGTERM
to the launcher's `bash`, which did not reach the `realFluidReactingFoam | tee`
pipeline it had spawned, and the solver kept advancing for several minutes
after the launcher reported stopped. It was stopped properly by signalling the
solver process group. This is the same class of problem as the missing budget —
a run's boundary has to be enforced where the process actually lives.

## Incidents found while making this run

Five defects were found by executing rather than by reading, each fixed in code:

1. **A files-only copy dropped the mesh.** `constant/polyMesh` is a directory;
   copying only regular files left the case without `points` and `checkMesh`
   failed. Manifest matching was also suffix-based, so a file in
   `cases/full-200mm` could satisfy an expectation for the same path in
   `cases/agile-80mm`. Both fixed.
2. **`set -e` aborted the OpenFOAM environment halfway.** `config.sh/aliases`
   ends with `unalias wmRefresh`, which fails whenever that alias is undefined —
   the normal case for a non-interactive shell. Under errexit the source aborted
   there, leaving PATH and LD_LIBRARY_PATH half-configured. The symptom was a
   launcher exiting 1 having printed nothing at all. The env is now sourced with
   errexit off and the result verified by resolution.
3. **The generated launcher baked in a container-only absolute path.** The
   attempt is materialised in the container, where the repository is
   `/workspace`, but the launcher runs on the host, where it is
   `/data2/kexiao/EvoCFD`. Allcheck is now resolved from the launcher's own
   location.
4. **The host's bash 5.2 cannot source the OF8 bashrc at all** (`pop_var_context:
   head of shell_variables not a function context`), which is a second reason
   the solver must execute on the host and not in the campaign container —
   consistent with the frozen three-phase boundary.
5. **Stopping the launcher does not stop the solver.** `kill` on the launcher's
   `bash` does not propagate to the `timeout ... solver | tee` pipeline it
   spawned, so the run continued after the launcher was reported stopped. The
   budget is now enforced inside the launcher by `timeout`, which is the process
   that actually owns the solver.

## Records

- `records/attempt-record.json` — the attempt: admitted and verified inputs, the
  five documented changes, the effective configuration, both executables, and
  the executable digest
- `records/log-head.log`, `records/log-tail.log` — the solver's own output
- `records/time-history.txt`, `deltat-history.txt`, `temperature-samples.txt` —
  the sampled series

## Commit

`67ec480` — the attempt was materialised and executed at this revision; the
records above were captured from that run.
