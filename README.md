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
fixtures/                Reviewed, resettable investigation tasks
runs/                    Generated workspaces and results (not committed)
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
