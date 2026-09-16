# of8-environment-001 — the OF8/realFluid solver, build and runtime inventory

**Bundle id:** `of8-environment-001`
**Type:** environment inventory (no agent episode; no LLM behaviour in this bundle)
**Tested code commit:** `c2e0aa5f861a65ebf7df8ef0c78154e62fa3a26c` (evo-cfd `main`)
**Status:** OpenFOAM-8 built and functionally verified. The `realFluidReactingFoam`
modification is **not** applied yet — this bundle establishes the base it will
modify, so that the modification is a change against a known state rather than
against "whatever was installed".

---

## Question

Can a reproducible, identity-carrying OF8 toolchain exist on an air-gapped host
that cannot reach any registry — and can we prove which source produced which
executable, rather than asserting it?

This is the reviewer's requested second bundle, and it exists because the first
priority (`candidate-build-integration-001`) proved the agent loop works but
says nothing about the physical layer. The CFD pivot has to start from a base
whose identity is recorded before any solver modification is made.

## Code tested

Not evo-cfd code. This bundle tests the **external** OF8 toolchain that
evo-cfd's `of8-realfluid` profile will drive:

| Component | Identity |
|---|---|
| OpenFOAM source | GitHub `OpenFOAM/OpenFOAM-8`, master branch, **archive tarball** |
| Source archive sha256 | `42971595657a8426d4cf8e8b89372cd50e786b17dfc6996fe5fa6a6e84688acf` |
| ThirdParty | `OpenFOAM/ThirdParty-8`, archive tarball (built as dummy; not used) |
| Compiler | gcc 9.4.0 (Ubuntu 9.4.0-1ubuntu1~20.04.2), system |
| MPI | Open MPI 4.0.3, system, via `WM_MPLIB=SYSTEMOPENMPI` |
| Platform | `linux64GccDPInt32Opt` |

The evo-cfd side is `cfd-baseline/baseline.json` at the commit above, which now
carries these identities.

## Execution

1. Source downloaded where the network is reachable (the Windows host) as a
   **tarball**, never as a git checkout.
2. Transferred to `/data2/kexiao/of8/` on the compute host and extracted.
3. `source …/OpenFOAM-8/etc/bashrc`
4. `./Allwmake -j` (112 cores) in a detached `tmux` session, with `TMPDIR`
   redirected to `/data2` because the root filesystem was full.
5. Functional verification: the built-in
   `tutorials/combustion/reactingFoam/laminar/counterFlowFlame2D` case, meshed
   with `blockMesh` and run with the built `reactingFoam`, with `endTime`
   truncated from `0.5` to `0.001` to bound wall time. The case directory was
   deleted afterwards; only the numbers are kept.

## Expected

- `Allwmake` exits 0 with zero compile errors.
- Every header named in an `#include` resolves — specifically `PointHit.H`,
  which is the file that exposes a broken transfer.
- A real solver runs a real reacting case to the truncated end time and leaves
  a decreasing continuity residual.

## Observed

- `Allwmake` exit **0**, **0** compile errors, 7009 build-log lines.
- **201** executables and **100** shared libraries under
  `platforms/linux64GccDPInt32Opt/`.
- The smoke test ran to `Time = 0.000979683`, `Courant Number mean: 0.0817487`,
  `time step continuity errors : sum local = 5.73148e-08`, exit 0.
- `reactingFoam -help`, `simpleFoam -help` both print usage, i.e. the binaries
  load and their shared libraries resolve.

The executive identity chain the reviewer asked for, measured not declared:

```
declared source     OpenFOAM-8 master, archive sha256 4297159565…
source file         reactingFoam.C        md5 36a7e7a1bcd94a374545042a762cfbc4
compiled executable reactingFoam (bin/)  md5 24b7472b872c5a5860bc0508002bd61e
loaded library      libOpenFOAM.so       md5 e8f9c47d9111e6d030692decdaf799e4
loaded library      libfiniteVolume.so   md5 77aa24a1c2e847acbb8e824aa24bd829
loaded library      libcombustionModels  md5 2cd3b20b8e67891ef62a8fa1ae61a57d
```

These five values are **not** derivable from one another, and that is the point:
the declared source, the compiled executable, and the loaded library are three
different objects, and a claim about any one of them is not a claim about the
others. The executable in the smoke test is the one whose md5 is listed here;
`ldd` confirms it resolves against the libraries listed here.

## Evidence

- `records/environment.json` — the machine-readable inventory.
- `records/identity-chain.json` — the source/exe/library md5 chain above.
- `records/verification.json` — build outcome and smoke-test numbers.
- `logs/build-tail.txt` — the last lines of the 7009-line `Allwmake` log,
  showing the final link commands and no errors.
- `logs/smoke-tail.txt` — the tail of the `reactingFoam` smoke-test log.
- `changes/nothing.md` — no source was modified. This is a deliberate record,
  not an omission.

## Human intervention

- **User decision:** do not touch the existing environment on the server.
  Everything was installed under `/data2/kexiao/`; the pre-existing OF7 and
  DeepFlame trees under `/opt` and `~` were not modified, and no package was
  installed.
- **User contribution:** rsync was installed locally for source syncing, which
  replaced the tar-based sync path.
- `endTime` was truncated to `0.001` to bound the smoke test's wall time. This
  is a divergence from the tutorial as shipped and is recorded as such.

## Limitations

- **This is not the target solver.** `reactingFoam` is stock OF8. The
  `realFluidReactingFoam` modification — the SRK/PR real-fluid equation of
  state, the Newton–Bisection density loop, Chung's transport, JANAF — is not
  applied. Proving stock OF8 builds and runs is necessary but far from
  sufficient; the modified solver is a separate build with its own identity
  chain to be recorded in a later bundle.
- **One smoke case, one solver, truncated.** The continuity residual reaching
  5.7e-08 over 0.001 s of a 2-D laminar counter-flow flame says the toolchain
  produces a running solver with sane numerics. It says nothing about
  accuracy, about trans- or super-critical regimes, or about the modified
  physics.
- **ThirdParty was not really used.** `libscotchDecomp`/`libptscotchDecomp`
  built as dummy; `metis` likewise. Decomposition is functional but these are
  not the real third-party libraries. If a real case needs genuine Scotch or
  Metis, that is a further build with its own identity.
- **The source has no git identity on the host.** It came from an archive, so
  provenance rests on the archive sha256 recorded above, not on a commit hash.
  That is a deliberate trade for correctness — see the incident below.
- **Host compiler, not containerised.** The build ran on the host with system
  gcc and system OpenMPI, not inside `evocfd-dev:node22`. The agent-side
  runtime remains containerised; this build is an external toolchain the
  container will invoke. That boundary needs to be made explicit before a
  trial can be said to have used this solver.
- **No agent episode.** No LLM was involved. Nothing here is evidence of agent
  behaviour.

## The incident this bundle exists because of

The first transfer attempt cloned the source with git onto the Windows working
tree. That filesystem is case-insensitive, so `PointHit.H` and `pointHit.H`
collapsed into one entry, and **65 distinct case-colliding groups of files were
silently lost**. The tree looked complete — 20,000 files, no error, no warning —
and the loss surfaced only at compile time, as `fatal error: PointHit.H: No
such file or directory` from `line.H`'s own include of that name.

The discriminating tests: `find src -name PointHit.H` returned nothing while
`pointHit.H` existed; re-cloning reproduced the loss deterministically;
auditing the archive tarball for lowercased-path duplicates found all 65 groups
including the one that mattered.

The fix is to take the source as an archive tarball, which never passes through
a case-insensitive working tree, and to audit the case collisions rather than
trust the file count. This generalises to any Linux source tree transferred
through this host, and it is recorded in full in `docs/EXPERIMENTS.md`.

## Review requested

1. Is the identity chain sufficient to bind a future `realFluidReactingFoam`
   build to the source that produced it? Specifically: md5 of the executable
   and the sources is recorded, but **the compile flags and the compiler
   version are recorded as strings, not as inputs to a reproducible hash.**
   Should the environment record a build-settings digest as well, so that the
   same sources built with different flags are a different environment?
2. The smoke test used a **stock** tutorial with a stock solver. Should the
   baseline require a second, independent verification case, so that the
   "it runs" claim rests on more than one data point before modification begins?
3. The boundary between the containerised agent runtime and this host-built
   toolchain is currently a convention. Should `baseline.json` record the
   solver's *invocation contract* (which paths, which environment sourcing)
   explicitly, so a trial cannot be said to have used the profile unless the
   contract held?
