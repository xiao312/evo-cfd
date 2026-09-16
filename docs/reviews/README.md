# Review bundles

Published, reviewed evidence for individual experiments and incidents —
separate from the raw `runs/` tree, which stays local and gitignored.

Each bundle is a small directory that lets a reviewer check **what actually
ran, which inputs it used, what changed, and what the evaluation established**,
rather than only what the code says should happen.

## Layout of one bundle

```text
<name>/
  README.md              the question, the command, expected vs observed
  export-manifest.json   tested commit, tree state, and every file's digest
  records/               machine-readable outputs, in their original schemas
  logs/                  verification output, episode trace, stderr
  changes/               diffs of what the run changed
```

`records/evaluation-result.json` is a *copy* of the file `evaluateTrial()`
wrote, not a reconstruction with different field names. Where a file was
transformed — most often by credential redaction — the manifest says so and
records the **export** digest, not the original's: a redacted file has
different bytes, and claiming otherwise would be a forgery.

## Conventions

- `.txt` for curated log exports, because the repository ignores `*.log`.
- The tested commit is the one that **ran**, recorded at export time. A report
  is often committed after the experiment, so the bundle says which revision
  was executed rather than which revision ships the bundle.
- Human edits and retries are recorded in the bundle's README. A manually
  repaired run is legitimate development work; describing it later as an
  unassisted agent result is not.
- Synthetic or deterministic inputs are labelled as such, in the README and in
  the artefact itself. A plumbing test is not an observed LLM behaviour.
- Excerpts are marked, with the original line range or event ids named, and the
  full local trace retained.

## Protections

These bundles are public. Nothing in them may be genuinely secret:

- No runtime credentials, gateway or proxy tokens, authorization headers, or
  credential-bearing URLs. Raw event streams are redacted individually, because
  tool commands and tool output can carry a secret even when the structured
  environment record has been cleaned.
- `docs/reviews/` is **not** mounted into trial or proposer containers. A
  bundle can describe a previous solution, and an experimental agent must not
  be able to read it.
- Material published here is no longer held-out material. Private evaluation
  variants and unpublished reference data stay outside the public export.

## Index

| Bundle | Question |
| --- | --- |
| [`candidate-build-integration-001`](candidate-build-integration-001/) | Does the production candidate builder accept the *actual* evaluator output and publish a valid, bounded candidate? |
| [`of8-environment-001`](of8-environment-001/) | Is the OF8 toolchain reproducible on an air-gapped host, and can the executable be bound to the source that built it? |
| [`realfluid-baseline-001`](realfluid-baseline-001/) | Does the real-fluid solver build without touching stock OF8, and can a run be proven to use Peng-Robinson physics rather than ideal gas? |
