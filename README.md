# EvoCFD

An LLM-driven workbench for real-fluid combustion CFD: an agent that both
*operates* a solver and *develops* it, evaluated against a frozen experimental
case.

## What this is

EvoCFD runs a self-improvement loop over a CFD codebase. An agent attempts a
case, unresolved observations become bounded diagnostic tasks, and the results
are separated into three distinct kinds of improvement:

- **Case recipe** — permitted initialization, time-step policy, scheme and model
  selection. Evidenced by the revised recipe performing better under the task's
  checks.
- **Solver/model implementation** — a corrected interface, coupling, diagnostic,
  or new physical model. Evidenced by component tests, integration tests, and
  application evidence.
- **Agent harness** — a skill, extension, tool, or context policy. Evidenced by
  a **fresh agent episode** performing better because of the change.

These are related, but they are not the same event. The controller exists to
keep them separate.

## Layout

```text
packages/controller/     Campaign and improvement machinery
packages/rsih-adapter/   Narrow integration with RSI-Harness
third_party/RSI-Harness/ Upstream runtime (local only, see THIRD_PARTY.md)
cfd-baseline/            One baseline: harness + two solver profiles + task
mascotte-g2/             The target case and its evaluation evidence (layer 5)
fixtures/                 Reviewed, resettable investigation tasks
genomes/                  Genome bundles: the seed, candidates, the proposer
config/agent-seed/        Agent configuration (no credential in the repository copy)
config/genome-templates/  Contracts a candidate installs, e.g. the skills component
runs/                     Generated workspaces and results (not committed)
```

## Fixtures

A fixture is an executable environment, not a prompt. It bundles what an agent
needs and what will judge it:

```text
fixtures/<fixture_id>/
  fixture.json    schema version, sources, trial limits, network profile
  TASK.md         the prompt; placed beside the workspace, never inside it
  workspace/      what the agent sees and may change
  evaluator/      what judges the attempt; never copied into the agent view
```

`fixture.json` is intentionally small:

```json
{
  "fixture_id": "control-plane-001",
  "version": 1,
  "task": { "prompt": "TASK.md" },
  "workspace": { "source": "workspace" },
  "evaluation": { "source": "evaluator" },
  "trial": {
    "network_profile": "llm-only",
    "max_agent_turns": 20,
    "max_wall_seconds": 180
  }
}
```

The network profile is part of the environment, not a label: it decides which
egress forwards exist at all, and it enters trial identity, so a trial run with
`offline` and the same trial run with `llm+web` are not the same trial.

A fixture is loaded and validated by `packages/controller` before anything is
copied — unknown schema versions, missing fields, and sources that name paths
outside the fixture directory are all rejected at load time with every problem
listed. Materializing it produces a trial:

```text
runs/<trial_id>/
  agent/            TASK.md plus a copy of workspace/ — the agent's whole view
  private/evaluator/  the judging package, outside that view
  manifests/        fixture.json, task-identity.json,
                    environment-identity.json, trial.json
```

What identifies a trial is its content: digests run over file names and
contents only, never over where the fixture or the run directory happens to
sit, and never over credentials. Identity is built from structured inputs, not
from the process environment, so a token in the shell cannot reach a manifest.
The evaluation package has its own digest and enters trial identity, because
changing the evaluator changes what success means. The recorded identity is
the full digest; short forms exist for display only.

Reset discards the whole agent view and rebuilds it, then proves the rebuild by
re-deriving the digests recorded at materialization — a reset that cannot
reproduce the initial state fails loudly rather than drifting the baseline, and
it fails *before* replacing anything, so a drifted fixture is detected with the
previous state still intact. Materialization builds in a staging directory and
renames into place, so a crash mid-copy cannot leave a half-built trial.

A fixture is plain files and directories — symbolic links are refused at load,
because a link would make the reachable content differ from the content a
digest was recorded over. Fixture ids are flat identifiers, never paths.

The `agent` and `private` split used to be a structural classification: the
evaluator was simply not copied into the agent view, which holds only for an
agent that does not look. It is now an authority boundary.

`packages/controller/src/isolate.ts` builds the launch arguments for an agent
container that receives four mounts and nothing else — the read-only prompt,
the one writable workspace, the read-only harness runtime, and a writable
session directory outside the task. It does not receive the evaluation package,
the manifests, any sibling trial, the controller source, or the host's Docker
socket. The root filesystem is read-only, every capability is dropped,
`no-new-privileges` is set, and the process runs as a non-root uid, so the
container is a room with one desk on it rather than a machine the agent happens
to be sitting at.

Because that builder is a pure function, the boundary can be tested without
Docker. `packages/controller/test/isolate.test.ts` asserts the mount list, the
read-only and writable modes, that nothing named `private`, `manifests` or
`evaluator` appears in any mount, the hardening flags, and that a sibling trial
under the same runs root is not visible.

The check that matters more than the unit suite is
`scripts/verify-isolation.mjs`: it materializes a trial from the same fixture the
loop will use, builds the command from that same tested function, and runs the
container with a probe that looks for exactly what must be absent. It exits
non-zero on any `BAD-` marker. Run it on the compute host:

```sh
EVOCFD_HOST_ROOT=/data2/kexiao/EvoCFD evocfd 'node scripts/verify-isolation.mjs'
sh /data2/kexiao/EvoCFD/runs/isolation-probe/run-probe.sh
```

`EVOCFD_HOST_ROOT` is required: the controller runs inside a container where
the repository is mounted at a path the host does not use, and mount sources
must be host paths. Without it, Docker silently creates the missing source as an
empty root-owned directory, and the probe reports a writable-less workspace and
a missing prompt — a failure that looks like a broken boundary but is a broken
path.

## Evaluation

Evaluation is the moment the loop becomes answerable: it turns workspace
changes into a verdict that can be compared across trials. `evaluate.ts` is
written so that conversion cannot become optimistic.

The evaluator contract is small and deliberately awkward to satisfy by
accident:

```text
node check.mjs <agent-workspace>
```

It prints one JSON object — `{ pass, criteria: [{ criterion, pass, detail }] }`
— and exits zero when the task is solved. Wherever the controller cannot obtain
that object intact, the result records a failure and says which: the package is
missing, the output contains no verdict, the JSON is unparseable, or the process
exceeded its budget and was killed. A pass that survives an evaluator failure
would not be evidence of anything.

The verdict's own `pass` is authoritative, and the exit code is a witness that
may only contradict it in the optimistic direction. A verdict claiming success
from a process that exited non-zero has its pass withdrawn; a failure reported by
a process that exited 1 is the ordinary failing case and is recorded as a
judgement, not a fault.

A result is written once, by staging the file and renaming it, so a reader never
observes a half-written verdict and a judge cannot revise history after the
fact. Evaluating a trial that already has a result is an error rather than an
overwrite — and an existing but unparseable result is treated as a state fault
to investigate, not an opportunity to overwrite it. `resetTrial` clears the
recorded verdict along with the agent view it belonged to, so a pristine
workspace honestly has no result.

The result carries the identity of what judged what: the evaluator digest, the
workspace digest of the state that was judged, and the trial identity. It never
carries a credential.

## Running a trial

One trial is three commands in two places, because the controller container has
no Docker client by design: preparation and judging happen in the controller, and
the agent is launched where Docker actually lives.

```sh
# 1. prepare, in the controller container
node scripts/run-trial.ts control-plane-001 --prepare --trial-id m1-trial-001

# 2. execute, where Docker lives (EVOCFD_GATEWAY_TOKEN is the LLM gateway token)
node scripts/execute-trial.ts m1-trial-001

# 3. judge, back in the controller container
node scripts/run-trial.ts control-plane-001 --judge --trial-id m1-trial-001
```

`--prepare` materializes the fixture and writes `private/agent-launch.json` — a
complete description of how to run the agent, written before anything runs, so
what executes is exactly what is recorded. `--judge` refuses to run until an
episode has been recorded, because a verdict over a workspace no trajectory
produced is unattributable.

The launch plan drives RSI-Harness's own CLI rather than Pi directly, so the
harness layer is where turns are capped and where the Genome is applied — which
makes the harness the thing a trial varies. The executable is
`/rsih/src/cli.ts`, Pi 0.84.3 as vendored by the RSI-Harness checkout that `/rsih`
mounts; the Genome bundle is a separate read-only `/genome` mount, because an
agent that could rewrite its own harness would invalidate the comparison the
trial exists to make.

The agent's credential is the one thing not written down in advance. The gateway
token reaches the agent's config directory at execution time from
`EVOCFD_GATEWAY_TOKEN` and never enters the repository or the recorded plan; the
result records only `credential_ref: "gateway-token:default"`.

`--fake` swaps the agent for a deterministic prober that applies the intended
fix, which proves the pipeline without spending a model call.

`EVOCFD_HOST_ROOT` must be set when the controller runs in a container, since
mount sources have to be host paths. Without it Docker silently creates the
missing mount source as an empty root-owned directory, and the probe then reports
a missing prompt and an unwritable workspace while the real boundary is intact.

### Agent configuration the trial depends on

The agent reads its providers, models and settings from a config directory that
RSIH's CLI defaults to `$HOME/.rsih` — RSIH's vendored Pi resolves the agent
directory from `RSIH_CODING_AGENT_DIR`, not from `PI_CODING_AGENT_DIR`. Seeding
that directory one level too shallow leaves `models.json` where nothing reads
it, and the trial dies with `Unknown provider` before its first turn.
`config/agent-seed/` holds the repository copy — endpoints and model list, no
key — and `scripts/execute-trial.ts` merges the gateway token in at execution
time.

## Harness identity and candidates

The harness is what this programme varies, so it has an identity rather than an
implication. Every trial records which harness produced the work it judges.

A harness is more than `genome.json`: it is the whole Genome bundle — the
manifest plus every component, contract, skill and extension it reaches — the
agent configuration that declares the provider, model and reasoning level, and
the runtime the Genome is driven through, being the RSI-Harness revision and the
Pi version it vendors.

```text
genomes/m1-baseline/
  genome.json              ┐
  components/*.json        ├─ digested together: the whole bundle is the harness
  contracts/*.dev.md       │
  skills/<skill>/SKILL.md  ┘
config/agent-seed/         ─ digested; the repository copy carries no credential
third_party/RSI-Harness/   ─ revision recorded, not digested: upstream, not ours
```

An EvoCFD harness reaches the agent *only* through its Genome. `--no-context-files`
is part of the contract, so an `AGENTS.md` left in a workspace is never injected
into the prompt. A harness that wants to teach the agent something adds a skill
to its bundle — where the teaching is digested and compared — rather than
dropping a file into the workspace, where it is neither controlled nor recorded.

A candidate is a new Genome bundle plus a `candidate.json` that records its
parent by identity, the bounded change it applies, and the episode whose
evidence motivated it. Only skill changes are representable, on purpose: a
skill is the least invasive thing a harness can change, and it cannot touch the
model, the tools, the provider or the evaluator. `candidate.json` is excluded
from its own bundle's digest, because a record that contained its own identity
could not be written down without changing it.

Lineage walks from a candidate back to its seed and reports a break rather than
a truncated chain when an ancestor is missing, because a candidate with no
ancestry cannot be compared to anything. It also recomputes every identity on
the walk and rejects a record whose claim does not match the bundle it sits in:
a lineage is evidence, not a set of assertions.

## Proposing a candidate

A candidate starts as a proposal, and a proposal starts as evidence. The loop
is three commands in three places, like a trial, because a proposer is an agent
episode and is recorded the same way.

```text
recorded trial(s) ── assemble evidence ──┐
                                        ↓
                          proposer episode (isolated)
                                        ↓
                              private/output/proposal.json
                                        ↓
                          deterministic candidate builder
                                        ↓
                  no_change │ duplicate │ built │ rejected
```

Prepare, on the machine that edits the repository:

```bash
node scripts/run-proposer.ts --parent evocfd:m1-baseline \
  --trials m1-trial-001,m1-trial-002 --run-id proposal-001
```

This materializes a read-only evidence package at
`runs/proposal-001/private/proposal-input/` and writes the proposer's launch
plan. The package carries the trial manifests, the task the agent saw, the raw
event stream, the verdict, and the parent Genome — but never the evaluator that
produced the verdict and never the fixture's held-out files. The digest of the
package is recorded on the run, because a proposer that saw a different package
made a different proposal.

Execute where Docker lives, with `EVOCFD_GATEWAY_TOKEN` set:

```bash
node scripts/execute-proposer.ts proposal-001
node scripts/build-candidate.ts proposal-001 --parent evocfd:m1-baseline
```

The builder is deterministic and refuses more than it accepts. It validates the
proposal, snapshots the parent from its real bytes rather than trusting any
identity the proposal supplies, applies exactly one skill change, loads the
resulting bundle through RSI-Harness's own validator, and then checks that the
candidate's identity differs from its parent's, that the changed-file set is
exactly what the change kind permits, and that the parent is still untouched.
Only then is the bundle published and `candidate.json` written, as `proposed`.

`no_change` and `duplicate` are outcomes and not errors: a run that found
nothing to change produced the correct artifact, and so did one that found the
candidate already built. `rejected` says why nothing was built. Nothing in this
loop activates a candidate — that takes trials of its own, which is PR 7.

The proposer runs under its own Genome, `evocfd:proposer`, which is outside the
lineage it reviews. An instrument cannot be part of what it measures.

## Comparing two trials

`scripts/compare.ts` reads two judged trials and reports whether they differ and
in which criteria:

```bash
node scripts/compare.ts m1-trial-001 misdirect-trial-001 \
  evocfd:m1-baseline evocfd:m1-control-misdirect
```

The genome ids are needed only for trials that predate the manifest field that
records them. The comparison recomputes each arm's identity from its bundle
rather than trusting the manifest.

Three situations are reported as `incomparable` rather than silently compared:
arms over different fixtures, an arm with no recorded verdict, and arms whose
evaluators report different criteria. The last matters because a criterion
present on only one side would otherwise read as a gain.

The script is deliberately unable to say which harness is better. One trial per
arm has no power to support that, and the output says so. Replicates and a
promotion rule are PR 7B.

## Working in this repository

There is nothing to install. EvoCFD has no external dependencies, so running
`npm install` is unnecessary and will only fail on filesystems that cannot
link (exFAT has no reparse points). The workspace packages are wired into
`node_modules` by a script instead:

```sh
npm run check        # link the workspace packages, then run the test suite
npm run check:rsih   # additionally validate the local RSI-Harness checkout
npm run doctor       # report the environment (informational, never fails)
```

`npm run check` links before testing, so a checkout is ready to go as it
stands. On a filesystem that cannot link the package boundary cannot be
built locally; run the suite on the compute host or in CI instead.

## Status

Pre-alpha. Structure and contracts are being established; no complete
improvement cycle exists yet. See `docs/DESIGN.md`.

## Licensing

No license has been selected for EvoCFD's own code yet, and third-party
components retain their own terms. RSI-Harness is **not** redistributed here
pending an explicit license from its authors. See `LICENSE.md` and
`THIRD_PARTY.md`.
