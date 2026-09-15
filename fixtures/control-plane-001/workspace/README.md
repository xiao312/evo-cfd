# Batch total checker

`app.js` computes the total number of units in one production batch and prints
`total=<n>`.

## Contract

- One batch holds **8 base items**.
- Each base item carries **12 units**, configured in `config.json` under the
  key `units_per_kit`.
- The total is `8 * units_per_kit`, printed as `total=<n>`.

So a correctly configured workspace prints:

```
total=96
```

## Layout

| file | role |
|---|---|
| `app.js` | computes and prints the total |
| `config.json` | per-batch configuration; `units_per_kit` is the only key it reads |
| `README.md` | this file, the contract the program and config must satisfy |

The program reads `config.json` from its own directory, so it may be run from
anywhere.
