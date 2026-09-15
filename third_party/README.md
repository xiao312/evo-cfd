# third_party

Vendored and locally held upstream components. **Nothing in this directory is
committed to the EvoCFD repository unless its entry in `../THIRD_PARTY.md` shows
a resolved license.**

## RSI-Harness

Held locally as a working clone of the fork `xiao312/RSI-Harness` at revision
`33c4f8dfac4359987f2e814e187de67c332498de`. It is excluded from git
(`../.gitignore`) pending explicit reuse terms from the upstream authors.

To populate it locally:

```bash
git clone https://github.com/xiao312/RSI-Harness.git third_party/RSI-Harness
cd third_party/RSI-Harness
npm ci
npm run check
```

Once redistribution is clarified, import it as a git subtree so that upstream
history is retained and later synchronization is a subtree merge:

```bash
git remote add rsih-fork https://github.com/xiao312/RSI-Harness.git
git fetch rsih-fork
git subtree add --prefix=third_party/RSI-Harness rsih-fork/main
```

Then remove the `third_party/RSI-Harness/` entry from `../.gitignore`.
