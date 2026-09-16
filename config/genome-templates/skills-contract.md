# skills component — EvoCFD candidate contract

## Scope

Owns workflow knowledge that loads on demand. A skill must not push its whole
body into context at startup: the description in its frontmatter is what the
model sees first, and the body is read only when the task matches it.

This contract is what the first candidate from `evocfd:m1-baseline` installs,
because that seed carries no skills component. A candidate cannot add a skill
without adding the component that registers it.

## Config

- `skills`: an array of `{ source, enabled }` entries, where `source` is a
  skill directory inside the bundle.

## Allowed operations

EvoCFD's candidate changes are bounded to two kinds, and both are what this
component exists to carry:

- `skill_upsert` — install a skill the parent does not register
- `skill_modify` — replace the body of a skill the parent already registers

A skill cannot touch the model, the tools, the provider, the evaluator, or the
task, so a deficiency that needs any of those is not a skill's to fix.

## Contract for a candidate skill

A skill must state:

- its **trigger** — the situation in which loading it is correct,
- its **inputs** — what it needs to have been given,
- its **steps** — what it directs, in an order that is executable,
- what **done** looks like — how the agent knows to stop.

The content has to be reusable: never bind it to one task's answer, to a
credential, or to a path that only exists in one trial. Prefer short executable
instructions over explanation; a skill that argues its own case has already
been loaded too late to help.

A skill is not a place to put instructions the harness already gives. If the
parent Genome's instructions already say it, a skill that repeats it adds a
second, divergent copy.

## Candidate construction

Only these files may change when a skill is added to a bundle with no skills
component:

```text
genome.json                    the component is registered
components/skills.json         the component config
contracts/skills.dev.md        this contract
skills/<name>/SKILL.md         the skill itself
```

Everything else must remain byte-identical to the parent, and the builder
verifies that rather than assuming it.
