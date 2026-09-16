# instructions component — proposer harness

## Scope

This Genome is the harness a *proposer* runs under. It is not a candidate and
is not part of the `m1-baseline` lineage: it is the instrument that examines a
lineage, and it has to be outside the thing it measures, or a proposal would be
able to rewrite the harness that produced it.

## Config

- `append_system_prompt`: the proposal contract above — what the proposer may
  read, the one question it asks, and the one file it writes.

## Contract

- The proposer's only output is `/output/proposal.json`.
- A proposal carries at most one skill change.
- `no_change` is a valid and expected outcome, not an empty run.
- Every claim cites a file inside `/proposal-input`.
- The proposer never receives evaluator source, held-out fixtures, or the
  writable Genome tree.
- Construction of a candidate from a proposal is the controller's job, never
  the proposer's.

## Runtime placement

The proposer runs as an isolated episode through the same `runEpisode()` path
as a trial: `/proposal-input` and the parent Genome are read-only mounts,
`/output` is the only writable directory, and the launch plan is written to
`private/proposer-launch.json` before anything runs. Its own Genome is mounted
read-only at `/genome`, exactly as a trial's is.
