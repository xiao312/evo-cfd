# Experiments

What has actually run, and what it showed. Every entry is a real episode or a
real construction on the compute host, not a unit test.

## M1 baseline trials

Three real episodes under `evocfd:m1-baseline`, driving RSI-Harness's own CLI
into Pi 0.84.3 and out through the egress relay to `Atria-Dawn-Preview`.

| Trial | Events | Malformed | Exit | Verdict |
|---|---|---|---|---|
| `m1-trial-001` | 650 | 0 | 0 | PASS, all four criteria |
| `m1-trial-002` | 386 | 0 | 0 | PASS, all four criteria |
| `m1-trial-003` | 330 | 0 | 0 | PASS, all four criteria |

Trial identity `6d6c9e12…` was identical across the first two (same fixture,
same harness, same environment) and the v2 identity `c3d4a764…` verified
consistent across the launch plan, the trial manifest and the result for the
third. `credential_ref: gateway-token:default` recorded on every result.

## M1 control trials

Three controls were built to put a real deficiency into real evidence, so a
proposer could be tested on the case where a deficiency *is* present. All three
trials passed anyway.

| Control | What it removes | Trial | Verdict |
|---|---|---|---|
| `m1-control-noverify` | "verify before you claim" | `noverify-trial-001` | PASS |
| `m1-control-noreport` | the `REPORT.md` requirement | `noreport-trial-001` | PASS |
| `m1-control-misdirect` | replaces it with an active misdirection | `misdirect-trial-001` | PASS |

Each is an honest negative result, and together they say something specific —
but the claim is narrower than it first looks, and the narrowing matters.

`TASK.md` itself requires a corrected verifiable result and a `REPORT.md`, so
the supported statement is not "the model verifies and reports with no
instruction to do so". It is: **removing those instructions did not produce a
failure when the task prompt still supplied the requirements.** The controls
show the instructions were *redundant with what the task already demanded*, not
that the model would have invented them. Distinguishing the two is the
difference between a result about the harness and a flattering story about the
model.

What the controls do establish is that an instruction the model follows
anyway is not a deficiency the evidence can expose: removing "verify before you
claim" changed nothing, because the agent verifies from its own tendencies and
the task asks for a verifiable result either way. Removing the report
requirement changed nothing, because the agent wrote a 300-character report
unprompted and the criterion only requires non-empty. Even an active
misdirection — instructions that assert the program has a config-reading bug and
must be corrected, when the real defect is a config-key mismatch and the program
must stay byte-identical — did not cause a failure: the agent read the code,
saw the mismatch, and fixed `config.json` anyway.

This is also why a passing run does not forbid an improvement proposal. The
distinction the reviewer asked to record: **admission** is a bounded,
evidence-grounded hypothesis that a candidate *might* help; **promotion** is
the subsequent experimental support for it. A control passing closes neither.
A fixture with no skill-addressable deficiency admits no proposal, and that is
the honest state of this one — not evidence that the harness cannot be
improved.

A deficiency that reaches the evidence has to be something the harness gets
*wrong* in a way the model cannot absorb, not merely something the harness
stops saying. This fixture absorbs a great deal, which is a finding about the
fixture as much as about the harness, and it is why the first real candidates
will come from harder fixtures, not from a stronger stomach for engineering a
failure.

## Proposals

| Run | Evidence | Decision | Built |
|---|---|---|---|
| `proposal-001` | `m1-trial-{001,002,003}` | `no_change` | none |
| `proposal-002` | `fail-trial-001` (synthetic) | refused | none |
| `proposal-003` | `misdirect-trial-001` | `no_change` | none |

**`proposal-001`** — 1811 events, 0 malformed, exit 0, over the three passing
trials. `no_change` with fourteen evidence refs. The rationale classified the
episodes' self-corrected slips (an `xxd` call against a read-only PATH, a
redundant config key left in place, a report line claimed before it was true
and then made true) as model behaviour rather than harness deficiency, and cited
the seed Genome's own contract that the baseline must carry no task-specific
hint. That is the correct answer for all-pass evidence, and it is the answer
that costs the most to get wrong: a proposer that invents a gap to justify
having been run produces a candidate that will be compared as though the gap
were real.

**`proposal-002`** — the synthetic-evidence route. A scripted trial record whose
event stream showed an agent claiming an unverified fix, judged `fail`, labelled
`synthetic: true`. The proposer refused it: evidence no model produced cannot
demonstrate a behaviour the harness lacks. The integrity labelling worked
backwards through the whole design — the label exists so synthetic data can
never be mistaken for a trial that ran, and it was the first thing the proposer
reached for. Scripted evidence is not evidence of a harness, so the control
Genomes are the honest way to obtain the same situation.

**`proposal-003`** — 963 events, 0 malformed, over the misdirect control. The
harness under review genuinely contained a misdirecting paragraph, and the
proposer named it as the one thing that looked like a deficiency — but the trial
passed every criterion, so the evidence carried no failure for a skill to
repair, and the decision was `no_change`. A proposer that proposed against
passing evidence because it disliked the instructions would be rating its own
taste over the recorded outcome.

## Reviewable evidence

The narrative above describes outcomes; the evidence behind a description is
published separately, in [`docs/reviews/`](reviews/).

- [`candidate-build-integration-001`](reviews/candidate-build-integration-001/) —
  the complete chain from a real `evaluateTrial()` result through evidence
  assembly to a built candidate. Its value is precisely that it exercises the
  boundary where the `pass`/`verdict` contract mismatch arose: one side wrote
  `pass: boolean`, the other read a nonexistent `verdict` string, and every
  isolated test on either side was green. The bundle ships the actual
  evaluation result and the construction record that consumed it.

## What the loop has proven, and what it has not

Proven: a proposer episode runs end to end, isolated, recorded through the same
evidence path as a trial; the evidence package excludes the evaluator and the
held-out files; the proposal schema bounds what may be asked for; a
deterministic builder constructs a candidate or refuses it, with identity,
allowlist and parent-untouched checks enforced by construction.

Not yet exercised by a real run: the `propose` path itself. Every real episode
so far has correctly concluded `no_change`, because every real trial so far has
passed. The construction path is covered by unit tests that build and validate
real bundles against the pinned RSI-Harness, but no real LLM proposal has yet
produced a candidate. The way to change that is a fixture where a
skill-addressable deficiency actually fails a criterion — not a stronger
misdirection, but a task the model does not already know how to do.

## Why we are not forcing a candidate out of this fixture

It would be easy to contrive one: a fixture whose evaluator only passes when
some skill fires, so the first proposal has something to build. That has not
been done, and the reason is that it would manufacture the result the loop
exists to discover. The three controls established the shape of the problem —
this model absorbs instruction-level deficiencies, follows verify and report
unprompted, and even reads past an active misdirection to fix the right thing —
so a candidate built on this fixture would be a change the model did not need,
judged against a criterion that was never really at risk. The comparison would
measure nothing, and worse, it would produce a green checkmark that reads as
progress.

The honest alternatives are the two the roadmap now commits to: compare a
control candidate against the baseline under PR 7A, which tests the comparison
machinery without pretending to test the harness; and move the loop to CFD,
where a solver that fails to converge or an inconsistent thermo state is a
deficiency the model cannot talk its way past. `propose` will be exercised by
a real failure, or not at all.

## Infrastructure incident: the OF8 source transfer lost 65 files to case collision

**Symptom.** The first OpenFOAM-8 build on the compute host failed immediately:
`fatal error: PointHit.H: No such file or directory`, from `line.H`'s own
`#include "PointHit.H"`.

**Root cause.** The source was cloned with git onto a Windows exFAT working
tree. That filesystem is case-insensitive, so `PointHit.H` and `pointHit.H`
collapsed into one entry and 65 distinct case-colliding groups were silently
lost. The tree looked complete — 20,000 files present, no error, no warning —
and was not. The failure appeared only at compile time, in a header whose name
differed from its on-disk spelling by one letter.

**Discriminating tests.**

- `find src -name PointHit.H` → nothing, while `pointHit.H` existed. A missing
  file, not a missing include path.
- Re-cloning changed nothing: git on a case-insensitive tree reproduces the
  same loss deterministically.
- Auditing the GitHub archive tarball for lowercased-path duplicates found all
  65 groups, `PointHit.H`/`pointHit.H` among them.

**Fix.** Take the source as an archive tarball
(`https://github.com/OpenFOAM/OpenFOAM-8/archive/refs/heads/master.tar.gz`),
which never passes through a case-insensitive working tree, and transfer that.
Verified on the server: both spellings present, build proceeds past the
failing header with zero errors.

**Generalisation.** Any transfer of a Linux source tree through this Windows
host must avoid a git checkout on exFAT. Tarball in, tarball out, and audit the
case-collisions rather than trusting the file count. This is the same class of
silent-corruption failure as the earlier `write`-tool newline bug: a medium
that quietly changes what it carries, with the damage surfacing far from the
cause.

## Tooling: the source sync is now rsync, not tar

The tar-over-ssh sync worked, but it re-sent the whole tree on every run and
relied on `git checkout -- .` plus `git clean -fdq` on the server to reconcile
what tar could not delete. With the CFD baseline about to put large files in
the tree, that became the wrong trade.

`deps/sync-evo-rsync.sh` now sends only changed bytes, including `.git`, so the
remote copy is a git repository at exactly the local HEAD with no
reconciliation step. Verified end to end: remote HEAD matches local, `git
status` reads clean, and a content checksum of a changed file matches.

Three constraints of this particular host shaped the flags, and each is a real
trap rather than a preference:

- **The Windows rsync build advertises `no symlinks`.** The EvoCFD tree has none
  today, so nothing is lost. The script refuses to run if that changes, because
  silently dropping a symlink is exactly the class of failure the OF8 transfer
  produced.
- **`--no-perms --no-times` are mandatory.** The source is exFAT, whose
  permissions and timestamps are meaningless on Linux; without these flags
  rsync rewrites every file on every run.
- **`-c` compares by content**, because those exFAT timestamps cannot be
  trusted to decide what changed.

The script also refuses a dirty working tree, so the destination is always a
revision and never a half-edited copy. The old `sync-evo.sh` is kept for
reference, not used.

## CFD: the real-fluid solver builds isolated from stock, and runs on its own physics

The reviewer's next work package was *real-fluid baseline integration and one
clean run*, deliberately before CFD-001 and before any scientific modification.
The reasoning is worth keeping: a provenance-mismatch fixture built on top of an
unverified installation cannot distinguish "the agent failed to diagnose the
fault" from "the installation was wrong all along". The correct setup has to be
demonstrably runnable before the injected difference is the only difference.

**What was done.** The `realFluidFoam-8` package at upstream commit `48506de`
was built into **profile-specific output directories**, never into stock output
and never into the user's ambient `~/.OpenFOAM` tree. `Allwmake` exits 0 with
zero compile errors, producing 15 libraries and three executables including the
target `realFluidReactingFoam`.

**Why the output directories were overridden.** The package installs an
executable *named `reactingFoam`* and libraries *named identically to stock
ones* — `libcombustionModels.so`, `libspecie.so`,
`libreactionThermophysicalModels.so`. Built to the default locations,
`reactingFoam` on `PATH` would silently become the modified solver, and which
`libspecie.so` a binary loads would depend on the order of directories in
`LD_LIBRARY_PATH`. The profile removes the ambiguity by construction: stock
outputs live only under `OpenFOAM-8/platforms/…/`, profile outputs only under
`rf-profile/`, and the two never overlap. `ldd` on the executed binary confirms
the effect — the six modified-physics libraries resolve from the profile
directory, the four infrastructure libraries from stock.

**Stock OF8 is unchanged, proven by measurement.** Four stock artefacts were
hashed before the build and again after it; all four identical. This is a
sample rather than a whole-tree digest, and the limitation is recorded as a
review question rather than claimed away.

**The run used the real physics, not ideal gas.** The package's own
`1D_advection` tutorial selects, from the solver's own log,
`PRchungKineticMixture` / `PengRobinson` / `chungKinetic` / `rfJanaf` /
`rfSpecie` with `PRchungKineticStandardChemistryModel`. That is a cubic
equation of state with Chung's kinetic transport. Selection is not correctness,
and the case has zero reactions, so this proves the property path *executes* and
nothing about combustion accuracy — a narrower and honest claim.

Two corrections from the reviewer changed the *workflow*, not only the docs:

- **Archive transfer, not git checkout, for any Linux source tree.** The
  case-collision incident generalises: EvoCFD's own case-safe TypeScript repo
  may sync from Windows, but OpenFOAM source and build trees stay on a
  case-sensitive filesystem end to end. The `no symlinks` limit on the rsync
  build applies to that sync path only, and must not become a universal rule
  for upstream solver trees.
- **Do not synchronise over inputs an active run is consuming.** Sync now runs
  before a trial's inputs are prepared, not during it.

The previous bundle deleted its smoke case and kept only numbers, which made it
inspectable but not replayable. This one retains the full case inputs and logs,
and that is now the standing requirement.

## A genuine compatibility gap: the tutorials do not serve the target solver

The package builds three executables, but **all four of its tutorials specify
`application reactingFoam`** — none of them runs the target
`realFluidReactingFoam`. Trying the target solver on the `1D_advection` case
fails at the first species-enthalpy term:

```text
--> FOAM FATAL IO ERROR:
keyword div(((hei_O2*rho)*YVi_O2)) is undefined in dictionary
  ".../system/fvSchemes/divSchemes"
```

The cause is in `applications/solvers/realFluidReactingFoam/EEqn.H`, which adds
an explicit species-heat-diffusion term
`fvc::div(hei[k]*rho*YVi[k])` that `reactingFoam` does not have. The tutorial's
`fvSchemes` was written for `reactingFoam` and does not declare the per-species
scheme entries that this term looks up.

**This is a real finding about the upstream package, not a build error.** The
target solver is built and its `-help` runs, but no shipped tutorial can execute
it end to end. The gap is recorded rather than papered over: patching
`fvSchemes` by hand would produce a run, but it would be *my* case
configuration, not the package's, and it would silently misrepresent the
package as ready-to-run.

What this means for sequencing: the "one clean target-solver run" the reviewer
asked for needs either a compatible case constructed deliberately, or a minimal
`fvSchemes` extension identified as an EvoCFD adaptation rather than an upstream
property. Either is honest; pretending the tutorials exercise the target solver
is not. The verified Peng-Robinson property path remains the strongest current
evidence, and it came from the package's own `reactingFoam` build, which is a
distinct binary from stock despite the shared name.

## The container cannot run the solver, and that is the boundary the reviewer named

Running a CFD job through the controller, inside the campaign container, fails
in a way that is worth recording precisely because it is not a bug in our code:

```text
reactingFoam: error while loading shared libraries:
  libmpi.so.40: cannot open shared object file: No such file or directory
```

The `evocfd-dev:node22` container is a Node toolchain. It has no OpenMPI and no
C compiler — the solver was built on the *host* with system gcc 9.4 and system
Open MPI 4.0.3, and its binaries dynamically link `libmpi.so.40`, which does not
exist inside the container.

This is the exact concern the reviewer raised: *mounting host-built binaries
into a container is not, by itself, a demonstration that the runtime
dependencies are compatible.* The mount succeeded, the binary was visible and
executable, and it still could not run. The failure was silent at mount time
and loud at execution time.

**What this decides.** A CFD job is therefore a *host-side* execution, not a
container-side one, and the invocation contract must say so. The controller
records the plan and reads back the state; the solver runs where its libraries
are. Two consequences follow, and both are recorded rather than smoothed over:

1. The agent container and the solver runtime are different trust domains with
   different toolchains. A trial that claims to have used the `of8-realfluid`
   profile must record *where* the solver ran, and a controller that runs the
   solver on the host is exercising a different path than one that runs it in a
   container — even with an identical case and an identical executable digest.
2. The alternative — rebuilding the solver inside a container that has MPI — is
   a real option, but it is a *different build* with a different identity chain.
   It is not a fix for this build; it is a second environment to record.

For now the honest statement is: the job-lifecycle primitive works (it recorded
the plan, executed, and correctly reported `failed` with the reason rather than
silently succeeding), and the execution environment it needs is the host, not
the container. The primitive's value is that it reported the incompatibility
instead of hiding it.

## The scientific consultation layer, and what preparing one exposed

The reviewer's on-demand consultation layer is implemented
(`packages/controller/src/consultation.ts`): a worker escalates one specific
scientific question to a stronger reasoning model, with a frozen evidence
package, and the returned advice is recorded as an *input* — never as an
authority, never as a command. An imported response is bound to the digest of
the evidence it was prepared against, and staleness is *measured* at decision
time by re-hashing the solver and the case, not assumed.

The division of responsibility is the design, and it is kept structurally rather
than in prose: the advisor's original text and the controller's normalisation of
it are separate files, so they can never become indistinguishable; a rejection
must carry a rationale or it is refused; a consultation with no response stays
*pending*, which is a different outcome from *no change needed*.

Sixteen tests cover the reviewer's seven acceptance conditions.

**The first real use caught two evidence-integrity defects, and this is the more
interesting result.** Preparing the first consultation required every claimed
observation to be backed by a real artifact. Two were not:

1. **Two source excerpts collapsed into one.** `realFluidReactingFoam/EEqn.H`
   and `reactingFoam/EEqn.H` share a basename, and the preparation step flattened
   both to `source-excerpts/EEqn.H`. The second overwrote the first, so the
   briefing shipped `reactingFoam/EEqn.H` under a manifest entry describing it as
   the target solver's equation *containing the failing term*. The briefing had
   become self-contradictory: an advisor reading it would have concluded the
   worker's own evidence contradicted its hypothesis. Fixed by making excerpt
   destinations caller-supplied and *unique* — a duplicate now fails loudly
   instead of overwriting, with a regression test.

2. **An observation that was an inference.** The item stated that running the
   target solver "exits 1" with a named scheme error, sourced to a log. The log
   attached was the *successful* package-`reactingFoam` run from `cfd-job-001`,
   and the target solver had never been run at all. The claim was correct in
   substance — it had been read off the source — but it was labelled an
   observation when it was a prediction.

Verifying item 2 was itself the discriminating experiment, and it closed the
question before any advice was sent. That is the layer working as designed:
advice must be verified through execution, and here verification happened first.

### The experiment: target-solver-001

Two disposable copies of the retained reference case, run on the host under the
profile env file (the container still cannot run the host-built solver):

| arm | change | exit | outcome |
|---|---|---|---|
| A as shipped | none | 1 | `keyword div(((hei_O2*rho)*YVi_O2)) is undefined in fvSchemes/divSchemes` |
| B with species schemes | two lines | 0 | normal `End`, 200 steps, last reported time `0.002` = requested `endTime` |

The change in full:

```diff
     div(((rho*nuEff)*dev2(T(grad(U))))) Gauss linear;
+    div(((hei_O2*rho)*YVi_O2))  Gauss linear;
+    div(((hei_N2*rho)*YVi_N2))  Gauss linear;
```

Both species are covered because `EEqn.H` loops over all of `Y`, not only the
active species; the case carries O2 and N2. `Gauss linear` matches this case's
own convention for explicit non-convective divergence terms — the `dev2` entry
immediately above is the same class of term.

**What this establishes.** The gap was configuration, not unsupported physics and
not an implementation defect. The target solver runs, exercises the Peng-Robinson
property path throughout, and its last sampled max T (368.475 K) sits 0.06 K from
the package's `reactingFoam` on the same case (368.537 K). The two solvers do not
diverge over 200 steps.

**What it does not establish**, and the consultation record says so: the values
are last-sampled, not a history, and cannot bound the field over the run; 200
steps is a short window; the 0.06 K is a single unstatistical comparison; and the
target solver's equations differ from the baseline's in *three* coupled places
(species-diffusion enthalpy flux, the replaced heat-flux closure, and the
mixture-averaged diffusion correction in `YEqn.H`), so the difference is not
attributable to the one term the scheme error named.

The closed loop is recorded at `runs/consultation-001`: a request frozen against
digest `9dc96367…`, an advisor response imported and bound to that digest, and a
decision recorded `admit` / `requires_human_decision` with `stale: false` because
the solver and case digests were re-measured and unchanged. The response proposes
a bounded experiment — smooth the interface, re-run both arms, sample the
conserved sums over time — and declines to promote any explanation on a single
sampled comparison.

**Unblocked.** CFD-001 and the reacting-case path no longer depend on a guess
about which file to edit. The next consultation has a question that is genuinely
open.

## The MASCOTTE G2 target case joins the project

The project's fifth layer — case and evaluation — was previously represented by the
`1D_advection` reference case, which is a useful smoke case but has no reaction, no
validation data, and no connection to the experiment. It is now backed by a real
target: `mascotte-g2/`.

The package was imported from an internal MASCOTTE investigation repository and
sanitized. What was kept and what was changed is recorded explicitly, because an
imported asset whose provenance is unclear is an asset that cannot be cited.

**Kept unchanged** (132 of 146 entries byte-identical after LF normalization): both
meshes and their `checkMesh` logs, all time-zero fields, every case dictionary, the
JL9 and RAMEC17 mechanisms, all digitized evidence, and `evidence/sources.yaml`
rights metadata.

**Removed**: internal host names, scheduler job identifiers, and internal run paths
from `docs/ATTEMPT-HISTORY.md` and the target README. None of the scientific content
was altered — the attempt history's findings, failure modes and next attempts are
preserved as written.

**Replaced**: the source package's top-level documents were oriented to a Fluent-only
workflow that explicitly forbade OpenFOAM execution. They were replaced by
`README.md`, `AGENTS.md` and `project.yaml` written for this project: OpenFOAM, the
pinned `realFluidReactingFoam` profile, and the controller's job-lifecycle primitive.

**Not imported**: the source's 1.4 MB `corpus.json`, a Fluent-run ledger carrying
over a hundred references to internal infrastructure. Its curated bibliographic
subset is already present as `evidence/sources.yaml`.

### A defect in the source's own manifest

The source package ships a `SHA256SUMS` manifest that does not match its own bytes.
The cause is line-ending normalization, and it is *inconsistent across entries*: the
scripts were hashed as LF while the CSVs were hashed with CRLF terminators as
committed. There is no single normalization that reproduces all of its hashes.

This repository stores LF (`.gitattributes`, `* text=auto eol=lf`), so the imported
tree was normalized to LF and the manifest was regenerated from the stored bytes. It
now verifies cleanly — 146 entries, 0 failures. All 8 digitized CSVs were confirmed
content-identical to the source after normalization, so the only real differences are
the five documents edited for this project plus the two added.

This is the same class of defect as the OF8 case-collision incident: a manifest that
was correct when it was written no longer describes what is on disk, and the
discrepancy is invisible until someone verifies. The lesson is recorded here rather
than smoothed over — byte-level provenance is only as good as the last regeneration,
and it must be regenerable from the stored bytes.

### Connection to the existing work

The case ships `application realFluidFoam` and its `fvSchemes` was written for that
solver. Running it under the pinned `realFluidReactingFoam` needs the per-species
`div(((hei_*rho)*YVi_*))` entries — one per species, ten of them here — which is the
same gap proven in `target-solver-001`. The case lock classifies schemes as
`tunable`, so the entries belong in a child attempt directory, never in this
immutable target. The README and AGENTS.md say so.

With this asset, the loop has a target that is worth improving against: an
experimental operating point, digitized OH\* reference fields, a mesh that passes
`checkMesh`, and an acceptance gate that a candidate must survive.

## MASCOTTE G2 runs under the target solver: mascotte-startup-001

With the target imported and `target-solver-001` having proven the solver runs,
the remaining question was whether the real case could be exercised at all.
Answering it is the first use of the layer-5 asset, and it produced the
`mascotte-startup-001` bundle.

The run is a **bounded chemistry-off startup qualification** on `agile-80mm`:
Allcheck passed on a child attempt, `realFluidReactingFoam` started and advanced
20 time steps to `Time = 1.79e-06`, `deltaT` grew by a factor of ~24 showing the
adjustable time step responding, and the last sampled `min/max(T)` was
`85, 288.59 K` — the two inlet temperatures, which is what chemistry-off flow at
this operating point should show. The Peng-Robinson property path is active in
the log. Nothing in this bears on combustion accuracy; the window is a fraction
of the case's own end time and the reaction source was off.

The substantive contribution is the **child-attempt contract**, because the
alternative was to modify the immutable target. The imported `Allcheck` writes
`checkMesh.current.log` into the case it inspects and `Allrun` decomposes that
case and writes solver results into it. `.gitignore` hides those from Git
status, which is housekeeping, not protection — ignore rules do not prevent
filesystem writes, and the README's agile example pointed `CASE_DIR` directly at
the imported directory. `scripts/prepare-mascotte-attempt.ts` is the supported
path: it refuses a destination inside the target tree, copies only admitted
inputs, verifies every copied file against `mascotte-g2/SHA256SUMS`, and
preserves a prior attempt rather than overwriting it.

Five things that executing the run exposed, which reading the code did not:

1. **A files-only copy dropped the mesh.** `constant/polyMesh` is a directory,
   so the child had no `points` and `checkMesh` failed. The manifest comparison
   was also suffix-based, letting a `cases/full-200mm` path satisfy an
   expectation for `cases/agile-80mm`. Both fixed.
2. **`set -e` aborted the OpenFOAM environment halfway.** `config.sh/aliases`
   ends in `unalias wmRefresh`, which fails whenever that alias is undefined —
   the normal non-interactive case. Under errexit the source aborted there,
   leaving PATH and LD_LIBRARY_PATH half-configured. The symptom was a launcher
   exiting 1 having printed nothing. The env is now sourced with errexit off and
   the outcome verified by resolution: the launcher refuses to continue unless
   both the solver and `checkMesh` actually resolve.
3. **The generated launcher baked in a container-only path.** The attempt is
   materialised in the container, where the repo is `/workspace`, but the
   launcher executes on the host, where it is `/data2/kexiao/EvoCFD`. Allcheck
   is now resolved relative to the launcher's own location.
4. **The host's bash 5.2 cannot source the OF8 bashrc at all**
   (`pop_var_context: head of shell_variables not a function context`), a second
   independent reason the solver executes on the host — consistent with the
   frozen three-phase boundary.
5. **Stopping the launcher does not stop the solver.** SIGTERM to the
   launcher's `bash` did not reach the `realFluidReactingFoam | tee` pipeline it
   had spawned, and the run kept advancing for minutes after "stopped" was
   reported. The budget is now enforced inside the launcher by `timeout`, the
   process that actually owns the solver.

Two standing corrections apply to the numbers above and are recorded as such in
the bundle: the temperature and continuity figures are **last sampled values**,
not bounds over the run, and "time step continuity errors" is the solver's own
term rather than a residual or convergence measure.

## The host runner was broken; mascotte-startup-002 proves the repair

The review of `dac3970` isolated four defects in the generic host runner, and
reproduced them with a dummy solver. All four were real, and the reason they
survived is that the generated runner had never been executed in a test — its
text was asserted over, but not run.

1. `run-cfd-job.ts` used `RECORD_FILE` and `readFile` without importing either.
   Planning reached a `ReferenceError`; receipt reading returned `null` through
   a catch-all, so a programming error was reported as an execution outcome.
2. The deadline was applied to a shell expression. `buildCommand` returns
   `source env && solver`, so `timeout 600 source env && solver` asks `timeout`
   to exec a program named `source`, which does not exist; the solver was left
   outside the deadline entirely.
3. The receipt was invalid JSON: a comma followed the last property, so every
   receipt was rejected by a parser, and the same catch-all turned the failure
   into "receipt absent".
4. The receipt did not influence the state. `assessFromLog` wrote a terminal
   state from the log alone and only then printed the receipt, so a log ending
   in `End` overrode a failed execution.

The repair removed the cause of the divergence rather than patching each
symptom: **there is now one execution backend**,
`packages/controller/src/runner.ts`, and a generic job and a prepared MASCOTTE
attempt both execute through it. `prepare-mascotte-attempt.ts` is a case
preparer that writes a job record and generates `run.sh` from the same tested
function; the thin `Allrun-child` wrapper keeps only the case-specific
preflight, refusing processor directories and running the target's `Allcheck`.

The backend is tested by executing the scripts it generates against
deterministic dummy solvers — a fast success, a nonzero exit, a hanging solver
with a child the deadline must collect, and a repeated submission. That is what
caught defects 2 and 4, both invisible unless the generated script actually
runs.

`mascotte-startup-002` is the real proof. The budget was set to 240 s against a
case needing far longer, so the deadline was expected to fire and did:
`exit_code=124`, `wall_clock_seconds=240` of `budget_seconds=240`. The
assessment attributed the stop to the budget, not to a solver error — and the
log ends mid-timestep with no normal `End`, which under the old code would have
been read as a crash.

The attempt record now carries **two** identities: `inputs`, measured before any
change, and `prepared_attempt`, a digest measured after all documented changes
were applied. The receipt's `plan_digest` binds to the case that ran rather
than the case that was imported.

Four further defects were found by executing, each fixed: the completeness check
compared against the manifest including non-input files; the preflight could not
find `checkMesh` because it sourced no environment; a helper constant was
declared inside `main`; and `run-cfd-job.ts` carried a duplicated header from an
earlier splice.

## The first external consultation is prepared and exported

The loop closes only when a genuinely separate advisor participates, so the first
external consultation is now prepared, frozen and exported — not yet answered.

The question is the next scientific decision, not a code review: given a
chemistry-off child of the MASCOTTE agile case that reached about 1.2e-7 s of a
requested 1e-5 s before a deliberate 240 s budget stopped it, what should the
next bounded diagnostic measure to distinguish normal startup behaviour from a
thermodynamic or coupling problem, and what would each outcome imply?

The request binds to the attempt's own investigation record, so the advisor sees
what is established and what is open as the campaign recorded it. The evidence
set is the attempt records, both solver equation files, and the prepared case
dictionaries. `scripts/prepare-external-consultation.ts` freezes it;
`scripts/export-consultation.ts` produces the package; `--lean` omits the mesh
and time-zero fields, which are 35 MB and carry no information about the
question, leaving 32 KB that a web chat can accept.

The transport is manual and outside the project by design: the operator submits
through their own authenticated web session. No password, cookie or session
token enters EvoCFD. The answer must come back declaring the request id and the
digest the export printed, because the importer refuses one that does not —
closing the association gap the review identified, where the importer previously
supplied the identity itself and could therefore attach an unrelated answer.

A relative `runRoot` was found to break evidence reservation while preparing
this: the containment guard compared a resolved absolute destination against a
relative staging root and rejected every destination as an escape. The guard was
right about the comparison and wrong about the operand; the staging root is now
resolved once at creation.

## The first external advisor answered — the loop is closed for real

The consultation `external-diagnostic-selection` was answered by a genuinely
separate model through the operator's ChatGPT web session, and imported. The
decision is recorded as `admitted-pending-review`. Freshness was measured at
decision time by re-hashing the profile libraries, not assumed.

This is the first round trip that tests the layer's actual hypothesis: that a
separate advisor materially improves the next decision. It did.

### The transport worked as designed

The operator never pasted file contents. The advisor read the evidence itself
through the read-only bridge and cited it by file and line: `YEqn.H` lines
20-78, `EEqn.H` lines 1-43, `execution-receipt.txt`, `checkMesh.current.log`,
`constant/thermophysicalProperties`, `system/fvSchemes`. The receive side is now
automated: `scripts/receive-advisor.ts` attaches to the chat tab through the
Chrome debug port and extracts the completed answer by stability detection.
The control message stays under a kilobyte; the evidence transfer is auditable.

### The advisor corrected the request, in four places

Every correction is recorded because each one is a defect in our own process.

1. **A cited artifact was never attached.** The request described a sampled
   temperature series and a 288.26 K maximum. The advisor searched the workspace
   and found those filenames and that number only in the request documents. The
   sampled series had never been generated for this attempt. The claim was
   unsupported by the evidence actually released.
2. **The property package was named for the wrong attempt.** The request named
   the `PRchungKinetic` variants, which belong to the earlier baseline run. The
   executed attempt's log, attempt record and dictionaries agree on
   `PRchungTakaMixture`, `chungTaka`, `rfJanaf`, `PengRobinson`, `rfSpecie`,
   `sensibleEnthalpy`.
3. **The time-step growth was over-read.** The request treated a growing time
   step as evidence that the LOX/CH4 interface imposes the step size. The
   observed growth is 1.199e-8 to 2.967e-8 s, and the largest printed Courant
   number is 7.3e-6 against a configured maxCo of 0.3. Stock OpenFOAM-8 caps
   growth at 1.2x per step; the observed ~20% growth at negligible Courant is
   consistent with that startup ramp. Hypothesis H1 is not established by this
   evidence.
4. **Physical time was reported loosely.** The last announced time
   (1.187e-7 s) is an interrupted step; the last visibly completed step is
   8.90e-8 s, about 0.89% of the requested interval.

### The advisor's recommendation

Remain chemistry-off and instrument the next run: volume-integrated mass,
per-species inventories, and a complete energy ledger over a few fully
completed steps, with colocated thermodynamic states and the actual time-step
controls. The discriminating question is whether a changing inventory is
explained by measured boundary fluxes and pressure work, or not. Neither
constant temperature extrema nor a growing time step establishes that.

The advisor was specific about what would *not* count: a species sum near one
is partly algebraically enforced by the inert-species closure in `YEqn.H`, so
nonnegative species do not prove conservation; `wallHeatFlux` is not equivalent
to the custom energy equation's own fluxes; a same-library property round trip
establishes internal consistency, not cryogenic accuracy.

It also flagged a real property-data concern: `property-assumptions.json` marks
the O2 polynomial range as starting at 200 K while the LOX inlet is 85 K, and
`thermo.inputData` permits 50-5000 K. Widening the allowable bounds does not
validate extrapolated coefficients.

### Two export defects this exposed

Both are recorded as the same class as the earlier provenance incidents: an
evidence set is only as good as what it actually contains.

- The lean export emptied `0/`. The advisor needs the initial and boundary
  fields to verify pressure, inlet conventions, wall conditions and outlet
  backflow. The lean filter was sized for an upload budget that the bridge
  makes unnecessary — the advisor reads files, it does not receive an
  attachment. Serving the full export through the bridge is the correct fix.
- The sampled series were never generated for this attempt at all, while the
  request cited them. The sampling step must be part of every attempt's record,
  not an optional bundle extra.

### What this establishes, and what it does not

Established: the consultation loop works end to end with a real separate
advisor, the transport is automated in both directions, and the advisor
identified four unsupported or incorrect statements in our own request.

Not established: anything about the solver's physics. The advisor was explicit
that the present evidence establishes deadline behaviour and some startup
advancement, and does not establish conserved transport, correct cryogenic
thermodynamics, or the cause of any temperature drift. No case changes and no
execution were performed by the advisor.

## The ignition strategy is recorded in the case package

The operator's conclusion from the ignition screens is now the package's
prescribed next baseline: a clean time-zero start with a moderately preheated
CH4 feed passage and a matching hot inlet, followed by a smooth inlet-temperature
reduction once a flame kernel forms.

It is recorded as `mascotte-g2/docs/IGNITION-STRATEGY.md` plus the
machine-readable `mascotte-g2/ignition-baseline.yaml`, and it is wired into the
package's own `AGENTS.md`, `README.md` and attempt history. It changes nothing
in the immutable target: under `case-lock.yaml`, ignition method and energy
budget, and the documented time-zero chamber fill, are both tunable. A preparer
materializes it as a derived initialization in a disposable child attempt.

Three things were deliberately recorded as tensions rather than resolved, so a
preparer must confront them before materializing:

1. The prescription states 5.61 MPa and 0.0441 kg/s oxygen; the case lock states
   5.59 MPa and 0.0444 kg/s, sourced from Candel et al. 2006 Table 1. The case
   lock was not re-locked by this document.
2. A fixed 0.5 us time step has crashed before. Independently, the external
   advisor measured the chemistry-off startup advancing at an adaptive step of
   about 1.2e-8 to 3.0e-8 s with a largest printed Courant number of 7.3e-6
   against a configured maxCo of 0.3. A fixed 0.5 us is 17 to 40 times larger,
   and the near-injector mesh cannot satisfy maxCo at the resulting velocities.
3. The advisor's chemistry-off conservation instrumentation remains open, and a
   reacting baseline does not bypass it.

The hard constraint is recorded as thermodynamic consistency: temperature,
density, enthalpy and velocity must all be derived from the pinned property
package at the prescribed pressure and mass flow. A temperature-only patch
retaining 288 K density and velocity is not a physical initial condition.

This is a prescribed baseline, not a validated result.

## A manifest break was found and repaired

Regenerating the package manifest to cover the new strategy documents exposed a
pre-existing defect: the earlier review fixes to `README.md`, `AGENTS.md` and
`project.yaml` had been committed without regenerating `SHA256SUMS`, so the
manifest at HEAD no longer described those three files. The package's integrity
record had been silently stale since then.

Two editors had also introduced CRLF line endings into `README.md` and
`AGENTS.md`, mixed with the surrounding LF, which is the same class of
byte-level defect as the earlier case-collision and source-manifest incidents.

All four files were regenerated, the CRLF was normalized to LF, and two new
documents were added. Verification is now 149/149 with zero failures. The
regeneration is recorded in a new `mascotte-g2/docs/MANIFEST-CHANGELOG.md`,
which is itself manifested, so future regenerations form an auditable chain
rather than silent supersessions. Prior digests remain recoverable from git
history.

The standing rule is now explicit: any edit to a manifested file must be
followed by a regeneration recorded in the changelog. A stale manifest is a
defect, not a formality.
