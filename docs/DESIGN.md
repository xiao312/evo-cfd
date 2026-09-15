# EvoCFD design

## Objective

One solver-pinned case attempt produces a reproducible incident; an LLM agent
designs a useful investigation; a tested change improves the computational
treatment; and a separately evaluated harness change improves a subsequent agent
episode.

## Objects

Consistent terminology, used throughout the code and docs:

| Object | Meaning |
|---|---|
| **Campaign** | An ongoing effort to address the case with one solver profile, potentially improving its harness, solver, and recipe. |
| **Agent episode** | A bounded session with one objective: establish a baseline, diagnose a failure, implement a change, or evaluate a skill. |
| **CFD run** | One solver execution with fixed inputs, executable, libraries, and resource allocation. |

A campaign contains many episodes; an episode may launch several small tests
plus a larger run.

## One baseline, two profiles

`cfd-baseline/` defines one baseline: a minimal agent seed plus two **separately
executed** solver profiles against the same physical task contract.

- `of8-realfluid` — OpenFOAM 8 + `realFluidReactingFoam`
- `of7-deepflame` — OpenFOAM 7 + DeepFlame `dfLowMachFoam`

The two depend on incompatible supporting library trees, so isolation is a
build-system necessity rather than session hygiene. Checkpoints, thermodynamic
state representations, and case dictionaries do **not** transfer between
profiles; a transfer is a conversion task with its own checks. An episode header
states the active profile, executable, build identity, and permitted working
directories. Switching profiles is an explicit operation, never a continuation.

## Three kinds of improvement, three evidence requirements

| Target | Example | Evidence |
|---|---|---|
| Case recipe | Permitted initialization, Δt policy, scheme, model selection | Revised recipe performs better under the task's checks |
| Solver/model | Corrected interface, coupling, diagnostic, new model | Component tests, integration tests, application evidence |
| Agent harness | Skill, extension, tool, retrieval or context policy | A fresh agent episode performs better because of it |

Reducing the time step until a run stops crashing establishes only that the
modified recipe completed the tested interval. It does not establish numerical
correctness, agent learning, or flame accuracy.

## The loop

```text
Attempt the case
  → capture an unresolved observation
  → create a reproducible diagnostic task
  → propose competing explanations and discriminating tests
  → execute a bounded test
  → update the explanation and propose an intervention
  → verify locally, then return to the original case
  → separately test whether any harness improvement helps a fresh episode
```

Diagnosis triggers on three categories, not just crashes: a failure or stall; a
repeated unsuccessful or impractically slow attempt; and a numerically completed
result that does not support the intended physical conclusion. Triggers record
**observations**; causes are hypotheses requiring evidence.

An incident package is saved before anything is edited. The smallest problem
that retains the suspected mechanism is the target — not necessarily a
one-cell reproducer. Stabilization is permitted before the cause is established,
but is recorded as provisional.

## Two acceptance decisions

**Decision A — may this candidate be used in the current campaign?**
Verification levels, not prescribed scientific stages: configuration/build
validity → component tests → original incident replay → short integration test →
continued full-case assessment. A diagnostic test may intentionally switch off
chemistry; that is investigation, not a substitute for the prescribed case.

**Decision B — should this harness change become the default for later
episodes?** Fresh parent and candidate episodes on the same reset task, with the
same model configuration, starting solver state, permitted actions, and budget.
Assess actual behavior — accepted completion, relevant tests, unnecessary
interventions, failed jobs, compute spent, human assistance — not whether the
candidate repeats the skill's preferred wording.

A protected evaluator can still become an optimization target: do not test
repeatedly against a "held-out" task and keep calling it held out.

## Evidence standards

- **Fixtures are executable environments**, not hard prompts. The prompt can be
  one sentence; the value is in the source snapshot, reproducible starting
  state, diagnostics, controlled resources, and checks that distinguish a valid
  intervention from a workaround.
- Each fixture has an **agent-visible package** and a separate **evaluation
  package** that the worker cannot read. Success criteria are public; the
  solution and assessment data are withheld. Grade evidence and outcome, not a
  prescribed command sequence.
- Three fixture families initially: executable/library mismatch; thermodynamic
  state recovery; a small coupled numerical problem. Include a "no solver change
  needed" variant so the agent does not learn that every investigation ends in a
  code patch.
- One trial per configuration is integration testing, not an improvement claim.
  Three trials per fixture per configuration is a pilot budget, not adequate
  power. Promotion assessment fixes the task set, trial budget, primary outcome,
  regression conditions, and stopping rule **before** the candidate runs.
- Repeat trials estimate reliability on one fixture; different fixtures address
  transfer. Results stay grouped by fixture.
- **Joint attribution is the default** when a skill depends on a diagnostic the
  new solver introduces. Report the combined improvement and record the
  dependency edge; do not manufacture separate attribution when one of the
  configurations is invalid.

## Authorization

An action requiring authorization must not execute without valid authorization.
That is weaker and better than "refuse when headless": a headless campaign may
already hold a human-approved, bounded authorization tied to campaign, action
scope, resource ceiling, and input/build identities. Absent a channel, the action
returns `BLOCKED_PENDING_AUTHORIZATION` and yields — it does not hang, and it
does not ask the LLM to infer approval.

## Isolation

During a controlled trial the loaded harness and initial workspace are fixed.
Work produced inside a trial may inform later actions in that trial, but must
not silently enter another. Separate the identities:

```text
Harness  Genome + skills + extensions + loaded instruction files
Task     Prompt + initial workspace + permitted documentation
Environment  Solver + libraries + runtime configuration
Trial    Model configuration + resource limits + execution record
```

A digest records identity; it does not enforce isolation. Reset and access
controls do. Construct the worker environment explicitly rather than inheriting
it — context leakage has been observed through prior transcripts, notes,
candidate patches, git history, and shared memory stores.

## Proposer

The improvement agent is frozen **within a cycle**, not forever: cycle *k*'s
proposer harness produces a candidate that is evaluated in separate fresh
executions; an accepted change may join cycle *k+1*'s proposer. The proposer may
inspect candidate instructions as data, but never activate them while preparing
or assessing the same proposal. Separation of state and authority matters more
than assigning different model names.

## Module map

`packages/controller/src/` — the machinery described above. `episode.ts`
launches bounded agent runs; `fixtures.ts` materializes and resets executable
investigation tasks; `evidence.ts` records incidents; `gate.ts` enforces
authorization; `evaluate.ts` runs versioned checks; `select.ts` distinguishes
experimental use, provisional evidence, and default promotion.

`packages/rsih-adapter/` — the narrow integration with RSI-Harness: loading a
harness manifest, preparing a controlled worker environment, validating and
applying harness patches against the real schemas. Only changes genuinely
required in RSI-Harness itself go under `third_party/RSI-Harness/`.

## Rollout

1. Smoke-test the runtime and one solver environment.
2. Make the first fixture and complete its parent/candidate execution path. The
   result stays experimental.
3. Establish the fixture suite, repeated trials, reset isolation, and
   authorization failure tests.
4. Make the first supported promotion — or record that the candidate did not
   earn it.
5. Return to the case and assess whether the accepted capability helps real
   work. Exercise the second solver profile only after the first complete path
   functions.

This avoids both failure modes: two buildable solvers with no learning loop, and
an elaborate benchmark project that never reaches a real simulation.
