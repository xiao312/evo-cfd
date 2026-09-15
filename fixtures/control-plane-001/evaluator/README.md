# Evaluator — control-plane-001

Checks that the batch total is correct **and** that the correction was made
where the cause was, in the four ways `TASK.md` asks for.

```
node check.mjs <agent-workspace>
```

The reference program it compares against lives in `reference/` beside this
script, so the check needs nothing but the agent workspace — not the original
fixture tree, not the manifests, not the controller. That is what keeps the
judge independent of the thing being judged.

| criterion | meaning |
|---|---|
| `output` | `node app.js` prints `total=96` |
| `structure` | `app.js` is byte-identical to `reference/app.js` — the program was not rewritten to paper over a bad key |
| `config` | `config.json` sets `units_per_kit` to the value the program reads |
| `report` | `REPORT.md` exists at the workspace root and is non-empty |

All four are required, and all four correspond to a requirement stated in
`TASK.md`. The task contract and the evaluator agree by construction; a stated
requirement that the evaluator ignores is a bug in one of the two.

The pair of `output` and `structure` is the point of this fixture: an agent can
make the number come out right by editing the program, and that is not the same
as fixing the configuration error. A real solver change is unnecessary here, so
this fixture seeds the class of task where the harness can later distinguish
diagnosis from reflexive rewriting.

This evaluator never fails open. A missing reference or an unreadable input is
a failed criterion or an evaluator error, never a pass.

This package is private to the trial. It is copied under `private/evaluator/`
and never into the agent view, but that placement is a structural
classification, not an enforced boundary: the agent process shares the
container, and `cwd` is not a sandbox. Enforced isolation is a later change.
