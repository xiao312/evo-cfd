# Experiments

What has actually run, and what it showed. Every entry is a real episode or a
real construction on the compute host, not a unit test.

## M1 baseline trials

Three real episodes under `evocfd:m1-baseline`, driving RSI-Harness's own CLI
into Pi 0.84.3 and out through the egress relay to `Atria-Dawn-Preview`.

| Trial | Events | Malformed | Exit | Verdict |
|---|---|---|---|---|
| `m1-trial-001` | 650 | 0 | 0 | PASS, all four criteria |
| `m1-trial-002` | 386 | 0 | 0 | PASS, all four criteria |
| `m1-trial-003` | 330 | 0 | 0 | PASS, all four criteria |

Trial identity `6d6c9e12…` was identical across the first two (same fixture,
same harness, same environment) and the v2 identity `c3d4a764…` verified
consistent across the launch plan, the trial manifest and the result for the
third. `credential_ref: gateway-token:default` recorded on every result.

## M1 control trials

Three controls were built to put a real deficiency into real evidence, so a
proposer could be tested on the case where a deficiency *is* present. All three
trials passed anyway.

| Control | What it removes | Trial | Verdict |
|---|---|---|---|
| `m1-control-noverify` | "verify before you claim" | `noverify-trial-001` | PASS |
| `m1-control-noreport` | the `REPORT.md` requirement | `noreport-trial-001` | PASS |
| `m1-control-misdirect` | replaces it with an active misdirection | `misdirect-trial-001` | PASS |

Each is an honest negative result, and together they say something specific:
on this fixture with this model, an instruction the model follows unprompted is
not a deficiency the evidence can show. Removing "verify before you claim"
changed nothing, because the agent verifies from its own tendencies. Removing
the report requirement changed nothing, because the agent wrote a 300-character
report unprompted and the criterion only requires non-empty. Even an active
misdirection — instructions that assert the program has a config-reading bug and
must be corrected, when the real defect is a config-key mismatch and the program
must stay byte-identical — did not cause a failure: the agent read the code,
saw the mismatch, and fixed `config.json` anyway.

A deficiency that reaches the evidence has to be something the harness gets
*wrong* in a way the model cannot absorb, not merely something the harness
stops saying. This fixture absorbs a great deal, which is a finding about the
fixture as much as about the harness, and it is why the first real candidates
will come from harder fixtures, not from a stronger stomach for engineering a
failure.

## Proposals

| Run | Evidence | Decision | Built |
|---|---|---|---|
| `proposal-001` | `m1-trial-{001,002,003}` | `no_change` | none |
| `proposal-002` | `fail-trial-001` (synthetic) | refused | none |
| `proposal-003` | `misdirect-trial-001` | `no_change` | none |

**`proposal-001`** — 1811 events, 0 malformed, exit 0, over the three passing
trials. `no_change` with fourteen evidence refs. The rationale classified the
episodes' self-corrected slips (an `xxd` call against a read-only PATH, a
redundant config key left in place, a report line claimed before it was true
and then made true) as model behaviour rather than harness deficiency, and cited
the seed Genome's own contract that the baseline must carry no task-specific
hint. That is the correct answer for all-pass evidence, and it is the answer
that costs the most to get wrong: a proposer that invents a gap to justify
having been run produces a candidate that will be compared as though the gap
were real.

**`proposal-002`** — the synthetic-evidence route. A scripted trial record whose
event stream showed an agent claiming an unverified fix, judged `fail`, labelled
`synthetic: true`. The proposer refused it: evidence no model produced cannot
demonstrate a behaviour the harness lacks. The integrity labelling worked
backwards through the whole design — the label exists so synthetic data can
never be mistaken for a trial that ran, and it was the first thing the proposer
reached for. Scripted evidence is not evidence of a harness, so the control
Genomes are the honest way to obtain the same situation.

**`proposal-003`** — 963 events, 0 malformed, over the misdirect control. The
harness under review genuinely contained a misdirecting paragraph, and the
proposer named it as the one thing that looked like a deficiency — but the trial
passed every criterion, so the evidence carried no failure for a skill to
repair, and the decision was `no_change`. A proposer that proposed against
passing evidence because it disliked the instructions would be rating its own
taste over the recorded outcome.

## Reviewable evidence

The narrative above describes outcomes; the evidence behind a description is
published separately, in [`docs/reviews/`](reviews/).

- [`candidate-build-integration-001`](reviews/candidate-build-integration-001/) —
  the complete chain from a real `evaluateTrial()` result through evidence
  assembly to a built candidate. Its value is precisely that it exercises the
  boundary where the `pass`/`verdict` contract mismatch arose: one side wrote
  `pass: boolean`, the other read a nonexistent `verdict` string, and every
  isolated test on either side was green. The bundle ships the actual
  evaluation result and the construction record that consumed it.

## What the loop has proven, and what it has not

Proven: a proposer episode runs end to end, isolated, recorded through the same
evidence path as a trial; the evidence package excludes the evaluator and the
held-out files; the proposal schema bounds what may be asked for; a
deterministic builder constructs a candidate or refuses it, with identity,
allowlist and parent-untouched checks enforced by construction.

Not yet exercised by a real run: the `propose` path itself. Every real episode
so far has correctly concluded `no_change`, because every real trial so far has
passed. The construction path is covered by unit tests that build and validate
real bundles against the pinned RSI-Harness, but no real LLM proposal has yet
produced a candidate. The way to change that is a fixture where a
skill-addressable deficiency actually fails a criterion — not a stronger
misdirection, but a task the model does not already know how to do.

## Why we are not forcing a candidate out of this fixture

It would be easy to contrive one: a fixture whose evaluator only passes when
some skill fires, so the first proposal has something to build. That has not
been done, and the reason is that it would manufacture the result the loop
exists to discover. The three controls established the shape of the problem —
this model absorbs instruction-level deficiencies, follows verify and report
unprompted, and even reads past an active misdirection to fix the right thing —
so a candidate built on this fixture would be a change the model did not need,
judged against a criterion that was never really at risk. The comparison would
measure nothing, and worse, it would produce a green checkmark that reads as
progress.

The honest alternatives are the two the roadmap now commits to: compare a
control candidate against the baseline under PR 7A, which tests the comparison
machinery without pretending to test the harness; and move the loop to CFD,
where a solver that fails to converge or an inconsistent thermo state is a
deficiency the model cannot talk its way past. `propose` will be exercised by
a real failure, or not at all.

## Infrastructure incident: the OF8 source transfer lost 65 files to case collision

**Symptom.** The first OpenFOAM-8 build on the compute host failed immediately:
`fatal error: PointHit.H: No such file or directory`, from `line.H`'s own
`#include "PointHit.H"`.

**Root cause.** The source was cloned with git onto a Windows exFAT working
tree. That filesystem is case-insensitive, so `PointHit.H` and `pointHit.H`
collapsed into one entry and 65 distinct case-colliding groups were silently
lost. The tree looked complete — 20,000 files present, no error, no warning —
and was not. The failure appeared only at compile time, in a header whose name
differed from its on-disk spelling by one letter.

**Discriminating tests.**

- `find src -name PointHit.H` → nothing, while `pointHit.H` existed. A missing
  file, not a missing include path.
- Re-cloning changed nothing: git on a case-insensitive tree reproduces the
  same loss deterministically.
- Auditing the GitHub archive tarball for lowercased-path duplicates found all
  65 groups, `PointHit.H`/`pointHit.H` among them.

**Fix.** Take the source as an archive tarball
(`https://github.com/OpenFOAM/OpenFOAM-8/archive/refs/heads/master.tar.gz`),
which never passes through a case-insensitive working tree, and transfer that.
Verified on the server: both spellings present, build proceeds past the
failing header with zero errors.

**Generalisation.** Any transfer of a Linux source tree through this Windows
host must avoid a git checkout on exFAT. Tarball in, tarball out, and audit the
case-collisions rather than trusting the file count. This is the same class of
silent-corruption failure as the earlier `write`-tool newline bug: a medium
that quietly changes what it carries, with the damage surfacing far from the
cause.
