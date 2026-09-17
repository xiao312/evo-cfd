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
