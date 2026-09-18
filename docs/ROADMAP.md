# EvoCFD roadmap

The plan of record. Read this before proposing a PR; every PR answers one
question, and the questions are ordered.

## State

> An experimental apparatus exists, but the first experimentally valid agent
> loop has not yet closed.

What is finished is not trivial: a real runtime path exists end to end.

```text
Windows credential/network boundary
        ↓
authenticated relay + CONNECT proxy
        ↓
bridge-isolated runtime container
        ↓
RSIH / Pi
        ↓
real model
        ↓
episode recording
```

Reproducible fixture materialization sits on top of that. The infrastructure is
no longer hypothetical.

## Milestones

| Milestone | Meaning | Status |
|---|---|---|
| **M0 Runtime** | Real Pi/RSIH episode runs reproducibly on the server with controlled network and evidence capture | **Done** |
| **M1 Experiment** | Resettable fixture → isolated real agent → protected external evaluator → authoritative evaluation record | **Done** |
| **M2 Harness improvement** | Evidence → candidate harness change → fresh parent/candidate trials → selection | **In progress** |
| **M3 CFD loop** | Real solver incident → diagnosis → solver/recipe change → regression/evaluation → reusable harness learning | Not yet |
| **M4 MASCOTTE campaign** | Full CH₄/O₂ application with physical and experimental evaluation | Not yet |
| **M5 Generalization** | Second solver family + repeated fixture/promotion evidence + cross-profile learning | Later |

We are *at* the first scientifically meaningful milestone and building the
second. Not almost done.

### Why the next milestone is CFD, not more controls

M2's remaining question is whether a candidate harness *behaves differently*
from its parent. The three control Genomes answered the question that came
before it — can a deficiency be injected into evidence at all — and the answer
was that on this fixture the model absorbs instruction-level deficiencies, so a
repeated-iteration loop on the toy fixture has nothing to measure. More
controls on the same fixture would produce more negative results at the same
point, which is not progress.

PR 7A is therefore the *thinnest* version of the comparison — enough to say
"this candidate is not its parent" and no more — and then the loop moves to a
domain where a task genuinely exceeds what the model already knows. That is
PR 8 and the CFD fixtures: a solver that fails to converge, a thermo state that
is inconsistent, a coupled numerical instability. Those are failures a skill
can address and a model cannot paper over, which is exactly what the `propose`
path has never been exercised on.

## PR sequence

```text
NOW
│
├─ PR 3.1   fixture provenance hardening
│
├─ PR 4A    real isolation
├─ PR 4B    authoritative evaluator
├─ PR 4C    first real evaluated agent trial   ✅
│
│          ★ M1: experimental agent workbench   ✅
│
├─ PR 5     harness identity + candidates      ✅
├─ PR 6     bounded candidate generation       ✅
├─ PR 6.1   candidate-integrity hardening      ✅
├─ PR 6.2   producer-consumer contract repair   ✅
├─ PR 7A    minimal parent/candidate trial      ✅
│
├─ PR 8     OF8 + realFluid execution          ← the pivot (steps 0–2 ✅)
├─ CFD-001  provenance fixture
├─ CFD-002  thermo fixture
├─ CFD-003  coupled numerical fixture
│
│          ★ M3: self-improving CFD workbench
│
├─ PR 7B    parent/candidate selection at scale ← after CFD proves the loop
│          pays for itself on a task the model does not already know
├─ MASCOTTE G2 baseline campaign
├─ real incident → solver / case / harness improvement
├─ experimental validation
│
│          ★ M4: original research objective
│
└─ DeepFlame second profile
           ↓
        generalization
```

### PR 3.1 — fixture provenance hardening

No new capability. Small, then freeze fixtures.

1. Fixture-ID path traversal: restrict `fixture_id` and `loadFixtureById()` to
   a flat pattern (`/^[A-Za-z0-9][A-Za-z0-9._-]*$/`). Fixtures do not need
   hierarchical IDs; flat is safer.
2. Symlink rejection: fixture inputs may contain regular files and directories
   **only**. Recursively validate with `lstat()` / `Dirent.isSymbolicLink()`.
   This is easier and safer than defining portable symlink semantics.
3. Evaluator digest enters identity. Changing the evaluator changes what
   "success" means — a Law-4 concern.
4. Evaluator must not fail open. A missing reference is a failed criterion or an
   evaluator error, never a pass. Better: make the evaluator self-contained
   (`evaluator/reference/…`) so it needs no access to the original fixture tree.
5. Staged and atomic materialize/reset. Materialize into a temp sibling, finish
   all hashes and manifests, then rename. Reset must build `agent.next/`, derive
   its digest, compare, and only then replace — never delete before proving the
   reconstruction matches the recorded baseline.
6. Task contract and evaluator must agree. Remove or actually check the
   "leave a note" requirement.
7. Top-level `fixture.json` must actually be an object.

Also while there: include directory entries in `digestTree()`. An agent can
observe that an empty directory exists, so identity should represent it.

### PR 4A — enforced agent/evaluator isolation  ✅ done

The most important architectural PR. Turn the current honest "structural
classification only" into a real authority boundary.

Delivered as `packages/controller/src/isolate.ts` (pure command builder) +
`packages/controller/test/isolate.test.ts` (boundary contract, no Docker
needed) + `scripts/verify-isolation.mjs` (real container probe, exits non-zero
on any `BAD-` marker). Verified on the compute host: prompt read-only,
workspace writable, evaluator and manifests unreachable, Docker socket absent,
sibling trial invisible.

The agent physically receives:

```text
/task/TASK.md        read-only
/task/workspace/     read-write
RSIH/Pi runtime      read-only
agent session dir    dedicated writable
```

and nothing else — no `private/`, no `manifests`, no other trials, no controller
source, no Docker socket, no host filesystem.

Prefer a dedicated agent container over relying on `cwd`:

```text
trusted controller
    ↓
launch agent container
       ├── mount agent/TASK.md      ro
       ├── mount agent/workspace    rw
       ├── mount RSIH runtime       ro
       ├── dedicated agent-state    rw
       └── NO private/
```

Run the evaluator only after that container exits. Harden the container:
`--cap-drop=ALL`, `--security-opt=no-new-privileges`, non-root UID. For the
synthetic fixture the root filesystem can be read-only except `/tmp`, agent
state and workspace.

The key test is no longer "evaluator wasn't copied into workspace" (already
tested) but:

> an actual agent-side process attempts to access the known evaluator path and
> receives `EACCES` / not-mounted.

### PR 4B — authoritative evaluation  ✅ done

Implemented as `packages/controller/src/evaluate.ts` + `evaluate.test.ts` (14
tests, all fail-closed paths covered). Delivered as `private/result.json`
written once; the field names below were simplified during implementation
(`pass`/`criteria`/`evaluator_digest`/`workspace_digest`) but the contract is the
one described here.

Implement `evaluate.ts`. Do not let every evaluator invent its own protocol.

```text
input:  immutable evaluator package, completed agent workspace, trial manifest
output: evaluation.json
```

```json
{
  "evaluation_schema_version": 1,
  "trial_identity": "...",
  "evaluator_identity": "...",
  "status": "completed",
  "accepted": true,
  "criteria": [{ "id": "output", "pass": true, "detail": "..." }],
  "started_at": "...",
  "ended_at": "..."
}
```

The strong distinction to preserve:

```text
task failed        ≠   evaluator failed
status=completed, accepted=false      → valid negative result
status=error                          → the experiment could not be judged
```

Before execution, re-hash the evaluator package and compare to the recorded
digest. Run the evaluator with no network, with the workspace read-only, under
a wall-clock timeout, without model credentials, independently of the agent
session. This is the actual Law-4 boundary.

### PR 4C — first real controlled experiment  ✅ done, M1 closed

The pipeline is proven end to end on the compute host, first with a
deterministic fake agent and then with a real one. `m1-trial-001` executed a
genuine episode — the `evocfd:m1-baseline` Genome driving RSI-Harness's own CLI,
which vendors Pi 0.84.3 — inside the isolation boundary: 7 turns, 11 tool calls,
650 recorded events, zero malformed, exit 0. The agent renamed the mis-cased
configuration field, ran the program, and wrote its report. An independent
evaluator then judged it on all four criteria — output, structure, config,
report — and recorded a PASS with the episode reference and the credential name.

The claim closed here is exactly and only:

> EvoCFD can execute and independently evaluate a real agent trial.

Not that the harness is good, not that the model is good, not that
self-improvement works.

Bugs found only by running the real thing, all fixed: the agent's config
was seeded one directory too shallow (RSIH's vendored Pi reads
`RSIH_CODING_AGENT_DIR`, which RSIH defaults to `$HOME/.rsih`, so `models.json`
was invisible and every provider was unknown); the trial's budgets and working
directory were host paths inside a controller container that had no such paths;
the agent container had no Docker client or docker group; the Genome bundle was
mounted at `/genome` but referenced as `/genome/<id>`; the task was never passed
as a prompt, so the agent opened a session and exited having done nothing; and
results were staged in `/tmp` where `rename` cannot cross the bind-mounted runs
tree (EXDEV).

### PR 5 — harness identity and candidate representation  ✅ done

The harness is what the programme varies, so it now has an identity rather than
an implication. `packages/controller/src/harness.ts` defines the four types the
comparison machinery rests on.

A **`HarnessSnapshot`** covers more than `genome.json`, because a bundle is a
self-contained directory by RSI-Harness's own rule and its components, skills
and extensions live in it:

- the whole Genome bundle, digested over relative names and contents;
- the agent configuration — provider, model, reasoning level — digested from
  the repository copy, which carries no credential;
- the runtime the Genome is driven through: RSI-Harness revision and vendored Pi
  version;
- the ambient context the agent is given, which for every EvoCFD harness is
  *none*.

**`harnessIdentity`** composes those into a versioned digest. The version tag is
bumped when a field is added, so an old record can never be confused with a new
one. The trial identity now includes it — bumped to `v2` — because a trial under
one harness is not the same trial as under another, and a parent/candidate
comparison that could compare a harness against itself would be worthless.

A **`CandidateChange`** is bounded on purpose: only `skill_upsert` and
`skill_modify`. A skill is file-based knowledge that loads on demand, so
changing one cannot touch the model, the tools, the provider or the evaluator.
Widening this set is a decision to make with evidence, not a convenience.

A **`CandidateRecord`** links a candidate to its parent by *identity*, not by
name — a name can be reused, a digest cannot — and records the episode whose
evidence motivated it. `candidateLineage` walks that chain from a candidate back
to its seed; a missing parent is a **`LineageBreakError`**, reported rather than
silently truncated, because a candidate with no ancestry cannot be compared to
anything.

The `AGENTS.md` leakage problem is solved by making it structural. An EvoCFD
harness reaches the agent *only* through its Genome, and `--no-context-files` is
what makes that true — so a harness that wants to teach the agent something adds
a skill to its bundle, where the teaching is digested, rather than dropping a
file into the workspace where it is neither controlled nor recorded. The
snapshot records `context_files: []` so a harness that silently gained an
`AGENTS.md` could not hide it.

A record is excluded from the digest of what it describes: `candidate.json` is
not hashed, because a file containing its own identity cannot be written down
without changing it.

### PR 6 — bounded candidate generation  ✅ done

A **separate stable proposer episode** produces a bounded candidate from
completed evidence. Only upsert/modify of **one skill** is representable — no
solver modifications, no extension-writing, no model switching. The proposer
inspects the trial, trajectory, evaluation and parent harness, but cannot
activate its candidate: it writes one file, and a deterministic builder decides
what becomes of it.

What exists:

- `packages/controller/src/proposal.ts` — the proposal schema and its
  validation. A `no_change` decision is first-class, because most evidence
  supports it and a proposer that invents a gap to justify being run is worse
  than one that finds nothing.
- `packages/controller/src/evidence.ts` — a read-only, digested evidence
  package assembled from recorded artifacts only. The evaluation *result* is
  copied in; the evaluation *package* never is.
- `packages/controller/src/candidate-builder.ts` — deterministic construction:
  validate the proposal, snapshot the parent from its real bytes, copy, apply
  one skill change, load the bundle through RSI-Harness's own validator, then
  check identity, diff against a per-kind allowlist, and publish atomically or
  remove the staging entirely.
- `genomes/evocfd-proposer/` — the proposer's own Genome, outside the lineage
  it reviews.
- `scripts/run-proposer.ts`, `scripts/execute-proposer.ts`,
  `scripts/build-candidate.ts` — the same prepare/execute/construct split a
  trial uses, for the same reason: what runs is what was written down.
- Two PR 5 integrity gaps closed: `recordCandidate` accepts only `proposed`
  and only for the bundle it sits in, and `candidateLineage` recomputes every
  identity it walks and rejects a claim that does not match the bundle.

Three real proposer episodes ran (see `docs/EXPERIMENTS.md`). All concluded
`no_change`, correctly, because every real trial so far has passed. Three
control Genomes were built to put a real deficiency into real evidence; all
three trials passed anyway, because on this fixture the model follows verify
and report unprompted and even an active misdirection was absorbed. The
`propose` path is unit-tested against real bundles but not yet exercised by a
real LLM run — the way to change that is a fixture where a skill-addressable
deficiency actually fails a criterion, which is the first job of the fixture
work rather than something to force.

### PR 6.1 — candidate-integrity hardening  ✅ done
PR 6's machinery was sound but its integrity guarantees were partly
conventional. This PR makes them structural:

- **Public CI is green on a clean checkout.** The candidate-builder tests no
  longer invoke the pinned RSI-Harness, which is gitignored and absent from a
  fresh clone. Unit tests validate bundle *shape* through an injected stub;
  the one assertion that needs the real runtime skips with a stated reason and
  is covered by the CI-rsih tier instead.
- **A candidate is identified by content, not by `(parent, skill)`.** Two
  candidates of the same skill from the same parent with different bytes are
  two candidates, and both can exist; a repeated proposal is still a duplicate.
- **`skill_upsert` is refused for a skill the parent already registers** — that
  is a modify wearing an upsert's label, and the two have different provenance.
- **Every evidence reference is grounded**: relative, inside the package,
  existing, and naming a trial artifact rather than the package's bookkeeping.
  A proposal to change the harness must rest on at least one *trial* artifact;
  reading the parent Genome describes what changes, not why.
- **A proposal resting on an unjudged trial is refused.** "I have not looked
  yet" is not "no change needed", and a candidate built from unjudged evidence
  would be compared as though a verdict had said something.
- **The proposer's harness identity is recorded on every candidate**, because a
  candidate with no recorded instrument is not auditable and a silent change of
  proposer must not be readable as a change of parent.
- **The `denied` path list is checked against the mount list**, so a boundary
  that asserts a path is unreachable while mounting it is now a refused launch
  rather than a probe that passes on a path it was meant to prove unreachable.
- **`private/report.json`** is the machine-readable twin of each script's
  console output: write-once, and carrying `no_change`/`duplicate`/`rejected`
  as first-class statuses rather than as the absence of an outcome.

### PR 6.2 — producer–consumer contract repair  ✅ done

PR 6.1's grounding check read a `verdict` string that the evaluator never
writes; `evaluateTrial()` produces `pass: boolean` and `criteria`. Every real
evaluation therefore read back as unjudged, and **any proposal citing genuine
evidence would have been refused — the propose → build path could not have
completed.** No test caught it, because the candidate-builder fixture authored
its own `{verdict: "pass"}` that matched the consumer's expectation, and every
real episode so far had returned `no_change` before the grounding check ran.

The parser now lives in the *producer* (`readJudgement` in `evaluate.ts`) and
every consumer reads through it. A failed task is judged evidence — a repair
proposal is what a failure is for; only an evaluator `error`, or a missing or
malformed record, is unjudged.

Three more construction defects, found in the same review:

- `scripts/build-candidate.ts` omitted `rsihDir`, so the production CLI would
  have thrown joining `undefined/src/cli.ts` — every test injected a stub.
- The existing-skills branch called `writeSkills()` without awaiting, so the
  write could land after the bundle was published.
- Staging defaulted to `tmpdir()` with a `rename()` into the Genome tree — the
  same cross-filesystem `EXDEV` failure as before, now staged on the
  destination filesystem and removed in a `finally` that covers the `duplicate`
  and identical-to-parent early returns too.

The acceptance test is a real chain, not a unit test: `scripts/integration-candidate.ts`
materializes a fixture, runs a deterministic agent through the real
`runEpisode()`, judges it with the real `evaluateTrial()`, assembles the
evidence package, and builds a candidate through the production CLI and the
pinned validator. It is verified on the compute host and exports a review
bundle at `docs/reviews/candidate-build-integration-001/`. **This is the first
time the positive construction path has been exercised at all** — every real
LLM episode so far concluded `no_change`.

The lesson is recorded: a boundary tested from both sides against two
different contracts is a boundary tested twice, not once.

### PR 7A — the thinnest parent/candidate comparison, and the integration repair it exposed

```text
Fixture reset
       ├──────────────┐
       ↓              ↓
parent harness    candidate harness
       ↓              ↓
fresh episode     fresh episode
       ↓              ↓
evaluation        evaluation
       └──────┬───────┘
              ↓
           comparison
```

Deliberately small: **one** parent trial and **one** candidate trial, on the
existing fixture, with replication and promotion logic explicitly out of
scope. The only claim it can support is that a built candidate is loadable,
runnable and distinguishable from its parent — that the comparison machinery
works end to end. It is not an experiment about the harness, and it must not be
read as one: with n=1 there is no power to say anything about which harness is
better.

The construction half of this is done and verified: `integration-candidate-001`
proves a built candidate is bounded, validated by the pinned runtime, and
publishable, with the parent left byte-identical. The comparison half ran for
real over `m1-trial-001` and `misdirect-trial-001` and reported `same` — no
criterion moved, which is the honest result for two harnesses that both passed.

If the toy fixture produces no candidate — which is what every real run so far
has produced — PR 7A compares a control candidate against the baseline and says
so, rather than forcing a real candidate out of a fixture that has no deficiency
to repair.

### PR 7B — parent/candidate selection at scale

3 fixture families × replicates, a promotion rule and a ledger over
`private/report.json`. Deferred until after PR 8: this is where n=1 stops being
enough, and it is worth doing on a task where the harness actually has
something to add. **M2** closes here, not at PR 7A.

### PR 8 — OF8/realFluid execution profile  ← the pivot

**Step 0 is done: the toolchain exists and is verified.** OpenFOAM-8 and
ThirdParty-8 are built on the compute host at `/data2/kexiao/of8/`, with
`Allwmake` exiting 0 and zero compile errors, 201 executables and 100 shared
libraries. A stock `reactingFoam` counter-flow flame runs to a truncated end
time with the continuity residual falling two orders of magnitude. The
inventory is published as
[`docs/reviews/of8-environment-001/`](../reviews/of8-environment-001/) and
recorded in `cfd-baseline/baseline.json`.

What is **not** done: `realFluidReactingFoam` is built but has not yet been run
on a case, because **no upstream tutorial can run it** — the package's own
cases all specify `reactingFoam`, and the target solver requires per-species
`fvSchemes` entries (`div((hei_O2*rho*YVi_O2))`) that the tutorials do not
declare. That is an upstream gap, recorded rather than papered over. The
verified run used the package's own `reactingFoam` build — a distinct binary
from stock despite the shared name — which exercises the same Peng-Robinson
property path the target solver would use.

**The execution layer now exists and is proven against the real solver.**
`cfd-job.ts` defines the state machine and the solver profile as a resolved
contract; `cfd-exec.ts` runs and observes; `scripts/run-cfd-job.ts` splits the
job into plan, run and assess. The split exists because the controller (a Node
toolchain in the container) and the solver (a host build linking `libmpi.so.40`)
cannot run in the same place — the container sees the binary but cannot load
its MPI. The runner script is generated by the plan phase, so the host executes
the command the record describes, and the assess phase derives the terminal
state from the solver's log alone. The job reached its requested physical time
of 0.002 and used the real-fluid property path.

What changed about how the work is arranged, per review: the stock tree is
**never** overwritten. The package builds into profile-specific output
directories (`rf-profile/`), and stock OF8 was hashed before and after the
build to prove non-interference. This matters because the package installs an
executable named `reactingFoam` and libraries with the same SONAMES as stock —
so identity at runtime is decided by `LD_LIBRARY_PATH` order, not by the
executable path. The profile makes that order explicit and `ldd` verifies it.

Pin OpenFOAM 8, the realFluidFoam-8 source revision, compiler/toolchain,
container digest and linked libraries. Build → tiny existing tutorial/smoke
case → structured run result. No MASCOTTE yet.

Solver jobs can survive an LLM turn or session, so CFD needs a durable
execution primitive distinct from `runEpisode()`:

```text
submit CFD job → status → collect result → cancel
```

### CFD fixtures, in order

**The reviewer's sequencing, adopted.** A fixture is only meaningful on top of
a demonstrably runnable correct setup — otherwise a failing fixture cannot
separate "the agent did not diagnose the fault" from "the installation was
wrong all along". So the order is: pinned stock reference → pinned real-fluid
package with isolated outputs → a small correctly configured target-solver
run → EvoCFD launches, records and assesses that run → and only then does
CFD-001 introduce one controlled mismatch.

The first three of those exist now, in `realfluid-baseline-001`.

**CFD-001 — executable/library provenance.** Cheap and extremely important.
Deliberately load the wrong solver/library; ask the agent to investigate
unexpected behavior. Correct: inspect executable, inspect library provenance,
discover the mismatch, correct the environment. Wrong: start modifying
thermodynamics. Tests scientific debugging discipline without a difficult
physical calculation.

**CFD-002 — thermodynamic state recovery.** A reproducible state where a
thermo recovery issue occurs. The agent must discriminate between bad local
inversion, invalid upstream state, and configuration/convention mismatch. This
begins to resemble the real research.

**CFD-003 — small coupled numerical problem.** A short-time species/energy/
pressure calculation where the agent must reason about numerical coupling, not
just software provenance.

Once these work, EvoCFD has moved from agent-evaluation research to **CFD agent
research**. **M3**.

### MASCOTTE — after the first CFD loop, not before

Introduce the real MASCOTTE G2 CH₄/O₂ geometry, mesh, mandatory BC/IC and
experimental measurements. This stage needs an explicit observation operator:

```text
q_CFD  →  H  →  d_pred
```

before any comparison to experimental data — an experimental OH\* signal is not
raw OH mass fraction. The evaluator becomes multi-level:

```text
execution validity
    ↓
numerical validity
    ↓
physical sanity
    ↓
experimental observables
    ↓
cost
```

That is the actual scientific campaign. Only after the first solver profile can
do this should DeepFlame enter as the second profile (**M5**).

## Identity composition (target)

Do not let the current partial identity become the final trial identifier by
accident. What PR 3 calls `trialIdentity` is really closer to a
`FixtureExecutionIdentity`.

```text
TaskIdentity        task prompt + starting workspace
EvaluationIdentity  evaluator package
EnvironmentIdentity container / runtime / network / solver
HarnessIdentity     Genome + skills + extensions + Pi/RSIH revision
ModelIdentity       provider / model / options
TrialIdentity       hash(all of the above + resource limits)
```

Retain full SHA-256 as the canonical identifier; short forms are for display
only.

## Do not build yet

Multi-agent swarms; GEPA; AutoSkill integration; dashboards; full campaign
databases; automatic OpenFOAM 7/8 switching; Cantera/CoolProp integration;
sophisticated HPC scheduling; large MASCOTTE runs; cross-solver automatic
transfer. They all become easier to justify once M1/M2/M3 expose what is
actually missing.

## What to protect

The biggest positive sign so far is not the test count. It is that the
implementation keeps explicitly distinguishing

```text
source fixture          materialized trial
agent-visible state     private evaluator state
task identity           environment identity     trial identity
```

instead of treating a directory of files as "the benchmark." That distinction
is what will eventually make credible self-improvement claims possible.

# Milestone: Integrated Investigation Loop v1

Review of `63345da` (checkpoint tag `checkpoint-2026-09-17-pre-consolidation`)
concluded that EvoCFD has most of the necessary components, but the connections
between them still depend on experiment-specific scripts, operator
coordination, and manually maintained interpretations. The next milestone
therefore stops feature expansion and makes one complete loop dependable.

The loop to make dependable:

```text
read campaign state
  -> construct the worker context
  -> record question, plan and evaluation basis
  -> prepare a bounded attempt
  -> execute and assess it
  -> decide whether consultation is needed
  -> obtain and validate external advice
  -> admit a bounded follow-up plan
  -> execute the follow-up
  -> update the investigation and selected experience
  -> start the next episode with that experience
```

## Deliverables, in order

1. **Integration contract and defect repair.** Wrong-response, stale-state,
   mismatched-receipt and missing-evidence tests exercise real producers and
   consumers. The five known connection defects are listed below.
2. **Two-attempt investigation loop.** Attempt A's evidence, advice, decision
   and selected experience visibly reach attempt B. Restart from disk does not
   duplicate a solver job or an advisor request.
3. **Advisor efficiency and numerical-R&D contract.** Versioned solver dossier
   plus a small decision delta; measured retrieval and interaction overhead; an
   algorithm-design request type with explicit transfer criteria.
4. **Incremental refactor.** Behaviour and recorded identities stay valid; old
   commands keep tested migration paths.
5. **Development conventions.** Type checking over packages and entry points,
   test discovery that cannot silently shrink, commit/PR conventions,
   `CONTRIBUTING.md`.

## The five known connection defects

These are the initial hardening scope. Each is a real defect with a concrete
failure mode, not a style preference. Two are closed; the remaining three are
the receiver-transaction work below.

- **[CLOSED, `317699f` + `60554cf`] Execution receipts are not bound to a plan,**
  and the receipt heredoc expanded what it recorded. `assessExecution` now takes
  the expected job id and plan digest and reports a mismatch as a finding. The
  receipt is written in two halves: a static half through a *quoted* heredoc
  delimiter (job identity, budget, the argv — nothing evaluated) and a dynamic
  half written by `echo` appends (timestamps, elapsed time, exit code). An
  earlier test decoded the command line from the generated text without
  executing the script, which is why an unquoted delimiter looked acceptable;
  the replacement test runs the script and requires the observer's argv, the
  receipt's argv and the joined command to agree.
- **[CLOSED, `7979d46`] Consultation preparation embeds obsolete experiment facts**, and
  the digest measured a conventional guess rather than the prepared inputs. The
  attempt record now carries case-relative `path` as the identity with
  target-relative `source` as provenance; the reader resolves `path`, converts
  legacy `source`-only records, and folds the coverage basis into the hash so a
  declared list can never coincide with an assumed one. The two corrected
  observations the advisor returned were rewritten to state only what the
  attached log supports.
- **The receiver can accept an old answer or even a user message.** Text
  stability is not evidence of completion or identity. The receiver must bind
  capture to a recorded submission, validate a response envelope, keep a
  deadline, and preserve an incomplete answer as incomplete. `textContent` also
  discards markdown structure and code fences, so the original representation
  must be preserved where the transport permits.
- **Receive and import are not one transaction.** The receiver hard-codes the
  request id and digest prefix; the importer takes them from arguments without
  checking they were declared in the captured answer. A stale answer can be
  labelled as current by the caller. No experiment id or digest belongs in the
  receiver's source.
- **The investigation layer is retrospective and drops actual changes.** The
  record is written only after the outcome is known, so the plan cannot be shown
  to precede execution, and `actual_changes` is hard-coded empty. The lifecycle
  must split into plan -> prepared change -> execution -> assessment ->
  interpretation, with the change bound to the preparer's own diff.

## Rules for this milestone

- Refactoring supports the loop; it is not a separate cosmetic exercise.
  Directory moves happen only after behaviour is covered.
- Do not retroactively broaden a frozen request. New advisor permissions get a
  new request type.
- A protocol test does not need to discover a superior numerical method. Report
  loop completion and scientific improvement separately.
- Preserve the exact tested source snapshot. Evidence must not depend only on a
  disposable branch commit.
- Separate functional fixes, mechanical moves, numerical changes and experiment
  interpretation into different commits.
