# instructions component — evocfd:m1-control-noverify

## What this is

A **deliberately weakened control**, not a candidate and not an improvement. It
exists for one experiment: putting a real, skill-addressable deficiency into
real recorded evidence, so a proposer can be tested on the case where a
deficiency *is* present rather than only on the case where it is not.

It is identical to `evocfd:m1-baseline` with one line removed from the
instructions: the principle that the agent must run the program and read what
it prints before claiming a fix. That principle is exactly what a
`verify-before-claim` skill would restore, which is what makes the deficiency
skill-addressable — the point of the experiment.

## Why not synthetic evidence

An earlier plan wrote a scripted trial whose event stream showed an agent
claiming an unverified fix, judged `fail`. The proposer refused it, correctly:
the record carried `synthetic: true`, and evidence no model produced cannot
demonstrate a behaviour the harness lacks. Scripted evidence is not evidence of
a harness's behaviour. The control Genome is the honest way to obtain the same
situation — a real episode, under a real harness that genuinely lacks the
principle.

## Lineage

`parent_id` is `null`. This is a sibling control built by hand for the
experiment, not a candidate produced by the improvement loop, so it has no
place in a candidate lineage. A candidate proposing to restore verification
would descend from whatever the experiment's real parent is.

## What it is not

It is not a claim that removing the principle causes failure. Whether it does
is an empirical question the trial under this control is meant to answer, and
a proposer that reads the resulting evidence is entitled to conclude the agent
managed fine without it.
