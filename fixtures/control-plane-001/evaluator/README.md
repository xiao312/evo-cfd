# Evaluator — control-plane-001

Checks that the batch total is correct **and** that the correction was made
where the cause was.

```
node check.mjs <agent-workspace> [source-workspace]
```

Three criteria, all required:

| criterion | meaning |
|---|---|
| `output` | `node app.js` prints `total=96` |
| `structure` | `app.js` is byte-identical to the original — the program was not rewritten to paper over a bad key |
| `config` | `config.json` sets `units_per_kit` to the value the program reads |

The pair of `output` and `structure` is the point of this fixture: an agent can
make the number come out right by editing the program, and that is not the same
as fixing the configuration error. A real solver change is unnecessary here, so
this fixture seeds the class of task where the harness can later distinguish
diagnosis from reflexive rewriting.

This package is private to the trial. It is copied under `private/evaluator/`
and never into the agent view, but that placement is a structural
classification, not an enforced boundary: the agent process shares the
container, and `cwd` is not a sandbox. Enforced isolation is a later change.
