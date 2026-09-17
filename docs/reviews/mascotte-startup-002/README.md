# mascotte-startup-002 — the deadline works, and the receipt decides

## Question

Does the repaired host execution backend actually behave when run for real?
Three specific things were unproven until this attempt, and all three had been
broken in the preceding revision:

1. does the wall-clock budget stop a run that would otherwise run on?
2. is the receipt written at all, and is it valid?
3. does the receipt drive the authoritative job state, rather than being printed
   as a footnote after the state was already decided?

This is deliberately **not** a longer solver run than `mascotte-startup-001`.
The point is the execution machinery, so the budget was set to 240 s against a
case that needs far longer — the deadline was expected to fire, and it did.

## Command

```bash
# materialise, in the campaign container
node --experimental-strip-types scripts/prepare-mascotte-attempt.ts \
  --job mascotte-agile-002 --variant agile-80mm --ranks 1 \
  --chemistry off --end-time 1e-5 --budget 240

# execute, on the host
cd /data2/kexiao/EvoCFD/runs/mascotte/mascotte-agile-002 && bash Allrun-child

# assess, back in the container
node --experimental-strip-types scripts/run-cfd-job.ts \
  assess runs/mascotte/mascotte-agile-002
```

The MASCOTTE attempt now uses the **same** backend as a generic job:
`prepare-mascotte-attempt.ts` is a case preparer that writes a job record and
generates `run.sh` through `packages/controller/src/runner.ts`. There is no
second shell template.

## Observed

The receipt, verbatim from `records/execution-receipt.txt`:

```text
job_id=mascotte-agile-002
started_at="2026-09-17T14:02:36+08:00"
finished_at="2026-09-17T14:06:36+08:00"
wall_clock_seconds=240
budget_seconds=240
budget_enforced_by=timeout -s TERM -k 30
exit_code=124
```

All three questions answer cleanly:

1. **The deadline fired.** `exit_code=124` is `timeout`'s own code for a
   deadline stop, and `wall_clock_seconds` equals `budget_seconds` exactly. The
   solver was stopped by the record, not by an operator — this is the behaviour
   that was missing from `mascotte-startup-001`, where stopping the launcher's
   `bash` left the solver running for several minutes more.
2. **The receipt exists and parses.** The earlier revision wrote a trailing
   comma after the last JSON property, so every receipt was rejected by any
   parser; a catch-all reader then reported "no receipt" and concealed the
   programming error. The receipt is now line-based key=value, which cannot be
   structurally malformed.
3. **The receipt decided the state.** The assessment output:

```text
job mascotte-agile-002: failed (budget_exceeded)
  the wall-clock budget (240s) stopped the run at 240s, not the solver;
  last reported time 1.1869477e-7
  requested endTime 0.00001, last reported 1.1869477e-7
```

Note what did *not* happen: the log ends mid-timestep with no normal `End`, and
under the old code that would have been `failed (solver_error)`. The receipt is
what distinguishes "the budget stopped it" from "the solver crashed", and the
distinction is now in the record rather than in an operator's recollection.

## What the solver did before the deadline

6 reported timesteps, reaching `Time = 1.1869477e-7` against a requested
`1e-5` — about **1.2%** of the requested interval. `deltaT` grew from
`1.1990408e-08` to `1.0363276e-07`. Last sampled `min/max(T) = 85, 288.26 K`.

These are sampled values, not a bound over the run, and "time step continuity
errors" remains the solver's own term rather than a residual. The run reached
less physical time than `mascotte-startup-001` because the budget was
deliberately small — the goal was exercising the deadline, not advancing the
physics.

## Two identities, both recorded

`records/attempt-record.json` now carries:

- `inputs`: 40 entries, each the digest of a file as **imported**, measured
  before any change;
- `prepared_attempt`: a digest measured **after** all documented changes were
  applied, covering the dictionaries that were modified and the change list
  itself.

Imported-input identity and prepared-case identity are therefore separate
facts, and the receipt's `plan_digest` binds to the case that actually ran
rather than to the case that was imported. The `prepared_attempt` digest is a
prepared-case identity, not a claim of bit-for-bit reproducibility from the
target.

## Incidents found while making this run

Four more, each found by executing rather than by reading:

1. **The completeness check compared against the wrong set.** Its first real
   run refused to ship a "partial case" because the manifest lists files that
   are not case inputs — the case README and the `checkMesh` log the target's
   own tooling writes. Correct instinct, wrong set: the expected set is now the
   manifest entries an admitted input directory can actually contribute.
2. **The generated preflight could not find `checkMesh`.** `Allrun-child` runs
   the target's `Allcheck` before invoking `run.sh`, and `checkMesh` is a
   host-built binary the profile puts on `PATH`. The preflight now sources the
   profile env itself, with errexit off while sourcing for the same reason as
   the runner.
3. **A helper constant was declared inside `main()`.** `allcheckRel` was
   referenced from a template that evaluated in the same scope, so the script
   failed at generation time with a `ReferenceError`. Hoisted.
4. **`run-cfd-job.ts` had a duplicated header and import block** — a leftover
   from an earlier splice — which surfaced as `Identifier 'join' has already
   been declared`. The file was rewritten clean.

## Records

- `records/execution-receipt.txt` — what the process did, in the runner's own
  line format
- `records/attempt-record.json` — both identities, the five documented changes,
  the effective configuration, the species list
- `records/job-record.json` — the plan and the terminal state as the assessor
  wrote them
- `records/log-head.txt`, `records/log-tail.txt` — the solver's own output
- `records/time-history.txt`, `deltat-history.txt`, `temperature-samples.txt` —
  the sampled series
- `records/runner-output.txt` — the runner's stdout/stderr

## Commit

`4b79290` — the attempt was materialised and executed at this revision.
