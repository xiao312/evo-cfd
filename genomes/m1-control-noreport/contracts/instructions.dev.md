# instructions component — evocfd:m1-control-noreport

## What this is

A **deliberately weakened control**, not a candidate and not an improvement. It
exists for one experiment: putting a real, skill-addressable deficiency into
real recorded evidence, so a proposer can be tested on the case where a
deficiency *is* present rather than only on the case where it is not.

It is identical to `evocfd:m1-baseline` with one line removed from the
instructions: the requirement to write `REPORT.md` at the workspace root when
the task is done. The fixture's evaluator scores the report as one of four
criteria, so under this control a trial that does everything else right still
fails one criterion — and the missing report is exactly what a skill loaded on
task completion would supply, which is what makes the deficiency
skill-addressable.

## Why the report and not the verify principle

An earlier control, `m1-control-noverify`, removed the "verify before you
claim" principle. That trial passed anyway: the agent verified its work from
its own tendencies, so the missing instruction caused no observable failure.
That is an honest negative result — an instruction a model follows
unprompted is not a deficiency the evidence can show — and it is why this
control targets a criterion the model will not satisfy by default. Writing a
report is not something a model does unprompted, so the deficiency manifests.

## Why not synthetic evidence

An earlier plan wrote a scripted trial whose event stream showed an agent
claiming an unverified fix, judged `fail`. The proposer refused it, correctly:
the record carried `synthetic: true`, and evidence no model produced cannot
demonstrate a behaviour the harness lacks. Scripted evidence is not evidence of
a harness's behaviour. The control Genome is the honest way to obtain the same
situation — a real episode, under a real harness that genuinely lacks the
requirement.

## Lineage

`parent_id` is `null`. This is a sibling control built by hand for the
experiment, not a candidate produced by the improvement loop, so it has no
place in a candidate lineage.

## What it is not

It is not a claim that removing the requirement causes failure, nor a
prescription that a report skill is the right fix. Whether it fails is what the
trial under this control answers, and a proposer reading the evidence is
entitled to conclude something else is wrong, or that a skill is the wrong
remedy.
