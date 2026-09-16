# changes/ — nothing was modified

This directory is intentionally present and intentionally empty of diffs.

`of8-environment-001` is an **inventory** bundle, not a modification. No file in
the OpenFOAM-8 or ThirdParty-8 source trees was edited. The only changes made
anywhere were:

- creating `/data2/kexiao/of8/` and extracting the two archives into it,
- `platforms/` and `wmake/platforms/` build output produced by `Allwmake`,
- `TMPDIR=/data2/kexiao/tmp` for compiler temporaries,
- a temporary copy of a built-in tutorial, with `endTime` truncated to `0.001`,
  deleted after the numbers were captured,
- `/data2/kexiao/EvoCFD/cfd-baseline/baseline.json`, which gained the recorded
  identities — that is the evo-cfd side of this bundle.

Recording this explicitly matters: the value of the bundle is that it
establishes a **known base state**. A future bundle that modifies
`reactingFoam.C` will diff against this state, and that diff is only meaningful
if the base is verifiably unmodified.

The pre-existing environment on the host was not touched either: the OF7 tree
under `/opt/OpenFOAM`, the DeepFlame trees under the home directory, and the
installed container images are all exactly as found. No system package was
installed. Everything new lives under `/data2/kexiao/`.
