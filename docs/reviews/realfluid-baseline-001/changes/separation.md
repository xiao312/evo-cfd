# changes/ — what this build changed, and what it did not

## Stock OpenFOAM-8: unchanged

The reviewer's central instruction was to treat the realFluid package as a
provenance artefact, not as an instruction to overwrite the pristine stock
tree. That held: nothing in
`/data2/kexiao/of8/OpenFOAM-8/` was modified by this build.

The proof is measurement, not assertion. Four stock artefacts were hashed
before the realFluid build and again after it. All four are identical:

| Stock artefact | md5 (before and after) |
|---|---|
| `platforms/.../bin/reactingFoam` | `24b7472b872c5a5860bc0508002bd61e` |
| `platforms/.../lib/libOpenFOAM.so` | `e8f9c47d9111e6d030692decdaf799e4` |
| `platforms/.../lib/libfiniteVolume.so` | `77aa24a1c2e847acbb8e824aa24bd829` |
| `platforms/.../lib/libcombustionModels.so` | `2cd3b20b8e67891ef62a8fa1ae61a57d` |

## realFluidFoam-8 source: unmodified

Built exactly as upstream ships at `48506de`. No compatibility patch was
needed, so there is no local patch to record. If a future build on a different
toolchain needs one, that patch becomes a separately identified artefact
layered on top of this baseline, not a silent edit of the source tree.

## What was created

Everything new lives under `/data2/kexiao/of8/`:

```
realFluidFoam-8/          extracted source (pristine)
rf-profile/bin/           the three profile executables
rf-profile/lib/           the 15 profile libraries
rf-profile-env.sh         the invocation contract
rf-cases/1D_advection/    the retained smoke case, inputs and full logs
rf-build.log              the complete build log
```

Notably **absent** from that list: anything in `/home/dfode/OpenFOAM/`, which
is where `FOAM_USER_APPBIN` and `FOAM_USER_LIBBIN` pointed by default. The
profile overrides both, so the build never wrote to the user's ambient
OpenFOAM tree at all — which is also why the package's `reactingFoam` cannot
shadow the stock one through that path.

## The shadowing hazard, and how the profile removes it

The package installs an executable **named `reactingFoam`**, and libraries
**named identically to stock ones** — `libcombustionModels.so`,
`libspecie.so`, `libreactionThermophysicalModels.so`, and others. Built to the
default locations, `reactingFoam` on `PATH` would silently become the modified
solver, and which `libspecie.so` a binary loads would depend on the order of
directories in `LD_LIBRARY_PATH`.

The profile makes this a non-issue by construction rather than by convention:

- stock outputs live only under `OpenFOAM-8/platforms/…/`
- profile outputs live only under `rf-profile/`
- the two directories never overlap

and the environment puts `rf-profile/lib` **first** on `LD_LIBRARY_PATH`, so
the modified physics is what loads. `ldd` on the executed binary confirms the
effect: the six modified-physics libraries resolve from `rf-profile`, the four
infrastructure libraries from stock. Both rows are recorded in
`records/identity-chain.json`, because an absolute executable path alone does
not establish which libraries were loaded.
