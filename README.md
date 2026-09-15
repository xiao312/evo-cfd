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
