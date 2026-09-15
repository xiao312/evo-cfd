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
| **M1 Experiment** | Resettable fixture → isolated real agent → protected external evaluator → authoritative evaluation record | ~3 PRs away |
| **M2 Harness improvement** | Evidence → candidate harness change → fresh parent/candidate trials → selection | Not yet |
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
├─ PR 4C    first real evaluated agent trial
│
│          ★ M1: experimental agent workbench
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

### PR 4C — first real controlled experiment

```text
control-plane-001
        ↓
materialize
        ↓
real Pi / Atria-Dawn-Preview
        ↓
agent edits workspace
        ↓
agent exits
        ↓
external evaluator
        ↓
evaluation.json
```

Once, initially. If it passes, the claim is exactly and only:

> EvoCFD can execute and independently evaluate a real agent trial.

Not that the harness is good, not that the model is good, not that
self-improvement works. That closes **M1**.

### PR 5 — harness identity and candidate representation

Define `HarnessSnapshot`, `HarnessIdentity`, `CandidateChange`,
`CandidateLineage`. Identify Genome, skills, extensions, context/instruction
files, and Pi/RSIH revision — not just `genome.json`. This is also where the
`AGENTS.md` leakage problem gets solved.

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
