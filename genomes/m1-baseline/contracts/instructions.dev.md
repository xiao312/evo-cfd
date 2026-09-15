# instructions component

## Scope

Owns the harness's system prompt and appended prompt. It shapes the agent's
working principles; it does not change Pi's agent loop, its tool
implementations, or the provider.

## Config

- `system_prompt`: replace the base system prompt.
- `append_system_prompt`: append constraints after the base prompt.

## Allowed operations

`set_system_prompt`, `append_system_prompt`

## Contract

Keep instructions executable, verifiable, and consistent with the current tool
set. Never write a task's answer, a private credential, or one-off user content
into a long-lived prompt. After a change, check the prompt's length and the tool
names it refers to.

## evocfd:m1-baseline

This is the seed harness of the EvoCFD trial programme, the parent every
candidate genome descends from. Its instructions deliberately say nothing about
CFD or about any specific task: the baseline must be a general agent loop, so
that a candidate's improvement can be attributed to the harness rather than to
a task-specific hint baked into the parent.
