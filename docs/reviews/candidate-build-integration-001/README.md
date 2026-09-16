# Review: candidate-build-integration-001

## Question
Does the production candidate builder accept evidence produced by the actual
evaluator and publish a valid, bounded candidate?

## Code tested
- EvoCFD commit: `1f569e2c08e1fa62c4603c7c53194fcb1ce8e3b4`
- Working tree clean: **false** — but the dirtiness was only the bundle itself.
  At export time this directory was untracked, because a bundle is written
  after the experiment it describes. No source file was patched and no commit
  was amended: the tree's tracked content matched `1f569e2` exactly. The
  manifest records this as `working_tree_clean: false` with the reason in
  `working_tree_dirty_reason`.
- Uncommitted patch: none. Nothing modified a tracked file.

## Execution
- Trial id: integration-candidate-001
- Proposal run: integration-proposal-001
- Runtime: `evocfd-dev:node22` container on the compute host
- Exact commands:
  ```text
  bash /data2/kexiao/bin/evocfd 'node scripts/integration-candidate.ts --bundle /data2/kexiao/EvoCFD/docs/reviews/candidate-build-integration-001'
  ```
  The `--bundle` option takes the destination directory as its argument. The
  export writes into that directory in place, which is why the tree reads as
  dirty during the run and clean once the result is committed.

## Expected

- A genuine `EvaluationResult` written by `evaluateTrial()` is accepted as judged evidence.
- Exactly one skill is added, and the changed-file set is exactly the allowlist.
- Parent Genome contents remain unchanged.
- The pinned RSI-Harness validator accepts the candidate bundle.
- Candidate status remains `proposed`; nothing is activated.

**Scope of what is tested.** This script imports and calls the production
`buildCandidate()` API directly, with the real RSI-Harness installation root and
the pinned validator. It does **not** invoke `scripts/build-candidate.ts` as a
separate process, so the CLI's argument parsing, environment setup and error
reporting are **not** exercised here. The supported claim is:

> The actual evaluator output is successfully consumed through evidence
> assembly by the production candidate builder and the pinned RSI-Harness
> validator.

It is not a claim about autonomous improvement, and not a claim that the
standalone CLI works.

## Observed
- Outcome: `built` (see `records/construction-report.json`).
- Every check in `logs/verification.txt` printed `ok`; the process exited 0.
- Changed files: `genome.json`, `components/skills.json`, `contracts/skills.dev.md`, `skills/integration-test-skill/SKILL.md`.

## Evidence
- Trial manifest: `records/trial.json`
- Episode result: `records/episode-result.json`
- Evaluation result (the producer this review cares about): `records/evaluation-result.json`
- Proposal: `records/proposal.json`
- Construction: `records/construction-report.json`
- Logs: `logs/`
- Change: `changes/candidate.diff`
- Provenance of every file: `export-manifest.json`

## Human intervention
- None. The run is deterministic; no manual edits or retries.

## Limitations
- The proposal was supplied by a deterministic integration test, not an LLM.
- This is not evidence of a harness improvement, and the candidate was deleted
  after the bundle was written. It exercises a code path, nothing more.
- The episode ran the `fake-agent.mjs` stand-in, so `episode-events.jsonl`
  contains **no Pi JSON events**: no model call was made and no agent
  trajectory exists to inspect. The file is not empty — it holds the three
  plain-text lines the stand-in prints, which are its whole behaviour. Nothing
  in this bundle is an observed LLM action.
- The evaluation's criteria are those of the `control-plane-001` toy fixture.

## Review requested
- Is `records/evaluation-result.json` (the real producer output) consistent with
  what `records/construction-report.json` says consumed it?
- Does the recorded parent/candidate identity describe the inputs actually used?
