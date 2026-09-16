# instructions component — evocfd:m1-control-misdirect

## What this is

A **deliberately weakened control**, not a candidate and not an improvement. It
exists for one experiment: putting a real, skill-addressable deficiency into
real recorded evidence, so a proposer can be tested on the case where a
deficiency *is* present rather than only on the case where it is not.

It is identical to `evocfd:m1-baseline` with one paragraph replaced: instead of
"reason about the program before you change it... a program that already
computes the right thing is not something to touch", it tells the agent the
*program* has a bug reading its configuration and that correcting the program
is the fix.

The task's actual defect is a configuration key mismatch: `config.json` carries
`unitsPerKit` and the program reads `units_per_kit`. The correct fix is one line
in `config.json`; the program computes correctly and must stay byte-identical.
So this control sends the agent to edit the one file the evaluator requires to
be unchanged, and the structure criterion fails — a real failure caused by the
harness, not by the model's mood.

## Why the earlier controls did not work

Two earlier controls removed instructions and their trials still passed:

- `m1-control-noverify` removed "verify before you claim". The agent verified
  from its own tendencies, so no criterion failed.
- `m1-control-noreport` removed the `REPORT.md` requirement. The agent wrote a
  300-character report unprompted, and the criterion only requires non-empty.

Both are honest negative results: an instruction a model follows unprompted is
not a deficiency the evidence can show. A deficiency has to be something the
harness gets *wrong*, not merely something it stops saying, before the evidence
will carry it.

## Lineage

`parent_id` is `null`. This is a sibling control built by hand for the
experiment, not a candidate produced by the improvement loop, so it has no
place in a candidate lineage.

## What it is not

It is not a prescription. Whether the proposer proposes a skill for this — and
whether a skill is even the right remedy for a misdirecting instruction, when
the honest fix is to correct the instruction — is the finding, not a foregone
conclusion. A proposer that proposes a skill to counteract an instruction that
should simply be corrected is a proposer worth hearing from, and a proposer
that says `no_change` because the remedy is not a skill is a correct one.
