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

Identity composition is layered, and the layer implemented so far is partial.
What `packages/controller` records today covers fixture, task, evaluator,
network profile and resource limits; harness and model identity are still to
come. Until they exist, the value called `trial_identity` is really a
*fixture-execution identity* and must not be mistaken for the final trial
identifier. See `docs/ROADMAP.md` for the target composition and the order in
which the remaining layers arrive.

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

`packages/egress/` — the network boundary described under *Topology*. Owns
nothing else: no campaign orchestration, no RSIH launch logic, no CFD code.

## Topology

The runtime host owns the whole experiment — controller, harness, fixtures,
evaluator, solver — but holds no provider credential and offers no
unauthenticated internet access. This is not a convenience: an episode that
could reach the model while another could not was not run under the same
environment, so information access is part of the environment identity of every
trial, not merely a campaign label.

```text
┌─────────────────────────────┐
│ Windows development host    │
│                             │
│ source editing, git         │
│ real provider credentials   │
│ LLM relay            :18080 │
│ authenticated proxy   :18081 │
└──────────────┬──────────────┘
               │ persistent SSH reverse forwarding
               │ forwarding-only account, scoped to 172.17.0.1
               ▼
┌─────────────────────────────┐
│ runtime host, docker bridge │
│ 172.17.0.1                  │
└──────────────┬──────────────┘
               │ bridge network, host-gateway mapping
               ▼
┌─────────────────────────────┐
│ EvoCFD runtime container    │
│                             │
│ controller, RSIH / Pi       │
│ fixtures, evaluator         │
│ solver source, CFD runs     │
└─────────────────────────────┘
```

The two services have fixed identities: `18080` is the LLM relay, `18081` is
the proxy, and only those two ports are forwarded. The relay accepts an
OpenAI-completions request, injects the real provider key, and streams the
response back; the host carries only a gateway token. The proxy speaks CONNECT
only and demands its own credential, so plain http:// traffic is never relayed
and unauthenticated egress does not exist.

Three capability profiles are operational, not nominal. The profile decides
which forwards exist at all:

- **offline** — nothing forwarded. CFD, builds, and post-processing only.
- **llm-only** — the relay only. The agent can reason but cannot browse.
- **llm+web** — relay and authenticated proxy. Search and documentation
  retrieval work.

Container isolation is normal bridge networking with
`--add-host=host.docker.internal:host-gateway`; `--network host` was a spike
mechanism and is not the runtime. The forwarding account is a dedicated
forwarding-only identity whose `sshd_config` match block pins `PermitListen`
to exactly the two bridge addresses above and disables shell, tty, agent and
X11 forwarding.

Secrets never become evidence. Provider keys and both tokens are read from the
environment at process start; recorded results carry a `credential_ref` name
(`gateway-token:default`) rather than any value, and the environment identity
is derived from profile, upstream hostname, service versions and container
identity — never from the secrets themselves.

### Launcher placement

The workstation-side launcher is a batch file, and it must live on an NTFS
volume. `cmd.exe` reading a batch file from the exFAT `D:` drive hangs
indefinitely on a hidden console: the identical script, run with the same
arguments in the same hidden window from both volumes, reached its third
command from `C:` in under three seconds and never reached its first from
`D:`. The hang consumes CPU and produces no log at all, so it presents as a
silent dead service rather than a readable failure.

This is why the launcher lives in `C:\Users\<user>\.evocfd\bin\` while
everything else — the repo, the tarballs, the helper scripts — stays on `D:`.
Node and bash read from the exFAT volume without trouble; only the cmd
batch-file reader is affected. Should the launcher ever need to move, this is
the constraint, not disk space or tidiness.

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
