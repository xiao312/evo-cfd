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

The `agent` and `private` split is a structural classification, not an enforced
boundary. The agent process shares the container with the evaluator, and a
current working directory is not a sandbox, so a capable agent may read outside
its workspace. Enforcing that is a later change.

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
