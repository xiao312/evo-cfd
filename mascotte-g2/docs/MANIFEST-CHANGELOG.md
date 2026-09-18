# Manifest changelog

`SHA256SUMS` is this package's integrity record: it is what lets anyone confirm
the package they hold is byte-identical to what was imported and authored. A
stale manifest is therefore a defect, not a formality — it is the same class as
the source project's own internally inconsistent `SHA256SUMS`, which mixed LF
and CRLF hashing and consequently proved nothing.

Any edit to a file the manifest covers must be followed by a regeneration, and
recorded here. Content is hashed as UTF-8 text with LF line endings, which is
how git stores it under `.gitattributes` and how it is verified on any platform.

Prior digests remain recoverable from git history; a regeneration here does not
lose the earlier record, it supersedes it openly.

## 2026-09-17

Regenerated four entries and added two.

- **Regenerated:** `README.md`, `AGENTS.md`, `project.yaml`,
  `docs/ATTEMPT-HISTORY.md`.
- **Added:** `docs/IGNITION-STRATEGY.md`, `ignition-baseline.yaml`.

Three of the four regenerations corrected a pre-existing break: the review
fixes to `README.md`, `AGENTS.md` and `project.yaml` had been committed without
regenerating, so the manifest at HEAD no longer described those files. The
fourth, `docs/ATTEMPT-HISTORY.md`, recorded the ignition-strategy decision.

`README.md` and `AGENTS.md` additionally had CRLF line endings introduced into
regions edited on Windows, mixed with the surrounding LF. They were normalized
to LF before hashing, so the manifest now describes the LF text as stored.

Entry count after this regeneration: 148.

## Regeneration 2026-09-18 — IGNITION-STRATEGY.md

Recomputed one entry: `./docs/IGNITION-STRATEGY.md`.

A fourth unresolved tension was added, recording that the **deltaT ramp's status
is not stated anywhere**: it is unknown whether the solver's per-step step growth
is part of this prescribed baseline — a tunable under the case lock, changeable
only by re-locking the case — or a solver-side default of `setDeltaT.H`, which
the numerical-algorithm scope permits a candidate to change.

This was surfaced by the information-interface probe: a model given the assembled
decision context formed a cost hypothesis that depends on that distinction, and
correctly refused to assume which side of it the ramp falls. The record now says
the gap exists, so a future proposer does not have to guess.

No other entry changed. Verification was re-run on the compute host after this
regeneration.
