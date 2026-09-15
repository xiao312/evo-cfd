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

We are *almost at the first scientifically meaningful milestone*. Not almost
done.

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
├─ PR 5    harness identity + candidates        ✅
│
├─ PR 5     harness identity
├─ PR 6     bounded candidate generation
├─ PR 7     parent/candidate selection
│
│          ★ M2: primitive self-improving harness
│
├─ PR 8     OF8 + realFluid execution
├─ CFD-001  provenance fixture
├─ CFD-002  thermo fixture
├─ CFD-003  coupled numerical fixture
│
│          ★ M3: self-improving CFD workbench
│
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

### PR 6 — bounded candidate generation

A **separate stable proposer episode** produces a bounded candidate from
completed evidence. Initially allow only upsert/modify of **one skill** — no
solver modifications, no extension-writing, no model switching. The proposer
may inspect the trial, trajectory, evaluation and parent harness, but cannot
activate its candidate.

### PR 7 — parent/candidate experiment

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

One trial each proves machinery. Later, 3 fixture families × replicates gives
evidence for promotion. Only then is there an actual primitive
self-improvement loop. **M2**.

### PR 8 — OF8/realFluid execution profile

Pin OpenFOAM 8, the realFluidFoam-8 source revision, compiler/toolchain,
container digest and linked libraries. Build → tiny existing tutorial/smoke
case → structured run result. No MASCOTTE yet.

Solver jobs can survive an LLM turn or session, so CFD needs a durable
execution primitive distinct from `runEpisode()`:

```text
submit CFD job → status → collect result → cancel
```

### CFD fixtures, in order

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
