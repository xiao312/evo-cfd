# realfluid-baseline-001 — the real-fluid solver, built isolated and run on its own physics

**Bundle id:** `realfluid-baseline-001`
**Type:** solver baseline (no agent episode; no LLM behaviour in this bundle)
**Status:** the target solver builds with zero errors, stock OF8 is left
byte-for-byte unchanged, and a case exercising the **Peng-Robinson real-fluid
property path** integrates to its requested end time with a normal
termination.

---

## Question

Can the real-fluid solver exist as a build whose identity is separable from
stock OpenFOAM, and can a run be proven to use the modified physics rather than
silently falling back to ideal gas?

This is the reviewer's requested next work package: *real-fluid baseline
integration and one clean run*, before CFD-001 and before any scientific
modification. It follows `of8-environment-001`, which established the stock
base this build was layered on.

## Code tested

Not evo-cfd code. This bundle establishes the **external solver** that
evo-cfd's `of8-realfluid` profile will drive:

| Component | Identity |
|---|---|
| Package | `danhnam11/realFluidFoam-8` |
| Upstream commit | `48506de20ce67f35279c5347b09dcd86865a4c39` ("add c3.PR.LEMOS tutorial case") |
| Source archive sha256 | `13073ca413d2bd73b8506fb77c42095fcb6e754bef72c59bda1c8934236048a4` |
| Local modifications | **none** — built exactly as upstream ships |
| Base OpenFOAM | stock 8, as recorded in `of8-environment-001` |
| Compiler / MPI | gcc 9.4.0, Open MPI 4.0.3, `linux64GccDPInt32Opt` |
| License | GPL-3.0 |

Provenance follows the reviewer's correction: the archive was downloaded **of
the pinned commit**, so both the commit and the archive checksum are recorded,
and the tree was never extracted on a case-insensitive filesystem. The archive
was cross-verified against an independent `git archive` of the same commit:
all 1199 file contents are byte-identical, including both spellings of the 7
case-colliding groups the package contains.

## Execution

1. Stock OF8 environment sourced, then `FOAM_USER_APPBIN`/`FOAM_USER_LIBBIN`
   overridden to profile-specific directories — so the build writes into
   `rf-profile/`, never into stock output and never into the user's ambient
   `~/.OpenFOAM` tree.
2. `./Allwmake -j 32` in a detached tmux session, `TMPDIR` on `/data2`.
3. Stock artefacts re-hashed to confirm non-interference.
4. The package's own `tutorials/1D_advection` case: `blockMesh`, `setFields`,
   `reactingFoam`, with `endTime` truncated from `0.02` to `0.002`. **The case
   inputs and full logs are retained in `case/` and on the host**, unlike the
   previous bundle, which deleted its case.

## Expected

- The package builds with zero errors, with no source modification.
- Stock OF8 executables and libraries are unchanged afterwards.
- A case that selects the real-fluid thermophysical path runs and terminates
  normally.
- The binary that runs is the profile build, and its modified-physics
  libraries resolve from the profile directory.

## Observed

- `Allwmake` exit **0**, **0** compile errors, 15 libraries, 3 executables
  (`reactingFoam`, `realFluidFoam`, `realFluidReactingFoam`).
- **Stock OF8 unchanged**: four md5s identical before and after the build
  (table in `changes/separation.md`).
- The case reached its requested `endTime = 0.002` exactly, first logged time
  `1e-05`, terminating with a normal `End`.
- **The real-fluid path was selected**, from the solver's own log:

  ```
  type            hePsiThermo;
  mixture         PRchungKineticMixture;
  transport       chungKinetic;
  thermo          rfJanaf;
  equationOfState PengRobinson;
  specie          rfSpecie;
  ```

  with `PRchungKineticStandardChemistryModel` (2 species, 0 reactions). This is
  a cubic Peng-Robinson equation of state with Chung's kinetic transport — the
  modified physics, not ideal gas.

- **Library resolution verified with `ldd`**, not assumed: the six
  modified-physics libraries load from `rf-profile/lib`, the four
  infrastructure libraries from stock.

## Evidence

- `records/environment.json` — build inputs, output layout, stock-separation
  verification.
- `records/identity-chain.json` — executable digests **and** the
  per-executable library resolution, including the two distinct binaries named
  `reactingFoam`.
- `records/verification.json` — run outcome, thermophysical selection, and the
  boundary between what is and is not supported.
- `logs/build-tail.txt` — build outcome and error count.
- `logs/run-tail.txt` — solver header, thermo selection lines, run tail,
  sampled times and continuity.
- `case/` — the complete input dictionaries and initial/boundary fields, so
  the run is exactly replayable.
- `changes/separation.md` — the non-interference proof and how the profile
  removes the library-shadowing hazard.

## Human intervention

- **User directive:** do not touch the existing server environment. Everything
  new is under `/data2/kexiao/`; the pre-existing OF7 and DeepFlame trees and
  the installed container images are untouched, and no system package was
  installed.
- `endTime` was truncated to `0.002` (from `0.02`) to bound wall time. The
  modified `controlDict` is retained in `case/`, so the input as run is the
  input in the bundle.
- The reviewer specified the pinned commit, the isolated-output architecture,
  and the order of work (baseline before CFD-001). All three are followed here.

## Limitations

- **This is not combustion.** `1D_advection` is an isothermal species
  advection case with two species and **zero reactions**. It proves the
  real-fluid *property* path — the equation of state, transport and specie
  models — and nothing about a flame, heat release, or the trans-/super-critical
  regimes the project targets.
- **`realFluidReactingFoam` was built but not yet run on a case.** The tutorial
  specifies `reactingFoam`. Running the target solver on a compatible reacting
  case is the immediate follow-up; building it first was necessary, since an
  unbuilt target solver cannot be exercised at all.
- **Sampled, not historical.** The continuity figures are the first and last
  entries the solver reported. They are its `time step continuity errors`, not
  a linear-solver residual and not evidence of convergence or accuracy.
- **Host toolchain, not the agent container.** The solver ran in a host shell
  through `rf-profile-env.sh`. A trial that claims to have used this profile
  must go through that invocation contract, or state clearly how it differed.
  That contract is recorded in `records/identity-chain.json`.
- **No reproducibility claim.** Recorded digests identify the artefacts; they
  do not prove a rebuild is bit-for-bit identical. That stronger claim needs a
  separate rebuild comparison.

## Review requested

1. Is the separation proof sufficient? Four stock artefacts hashed before and
   after is a sample, not a full-tree comparison. Should the baseline instead
   record a digest of the whole stock `platforms/` tree, so that *any*
   interference would be detected rather than only interference in the four
   files someone thought to check?
2. The case selects the real-fluid path, and the log says so. But selection is
   not correctness. Is a small quantitative check appropriate as the next
   gate — e.g. a super-critical nitrogen state where the Peng-Robinson density
   differs from ideal gas by a known amount — so that the property path is
   shown to *compute* something, not merely to be selected?
3. `reactingFoam` now names two binaries. The profile resolves the ambiguity by
   directory order. Should EvoCFD additionally record, at trial time, a
   machine-readable assertion of *which* binary and *which* library set a run
   used, so a mismatch is a caught failure rather than a silent difference?

## What this unblocks

CFD-001 can now be defined from a **working** reference rather than from an
aspiration. The reviewer's point is exactly right: a provenance-mismatch
fixture built on top of an unverified installation cannot distinguish "the
agent failed to diagnose" from "the installation was wrong all along". With
this bundle, the correct setup is demonstrably runnable, and CFD-001's
injected mismatch becomes the only difference between a passing and a failing
run.
