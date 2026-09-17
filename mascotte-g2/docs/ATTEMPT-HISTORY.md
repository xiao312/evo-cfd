# realFluidFoam-family attempt history

This is a compact decision record, not a replacement for the full project log. The records below are sanitized: internal host names, scheduler job identifiers and internal run paths are removed, and the scientific content is preserved unchanged.

## Installation and baseline, 2026-09-13

- Built upstream `danhnam11/realFluidFoam-8` commit `48506de20ce67f35279c5347b09dcd86865a4c39` against OpenFOAM 8 on an internal compute host. EvoCFD later rebuilt the same pinned commit with isolated outputs; see `../cfd-baseline/baseline.json` and the `realfluid-baseline-001` bundle.
- The first MASCOTTE start failed because the multi-species case needed a `YiFinal` solver entry. Adding it resolved this configuration error.
- A clean 20-step smoke case completed 10 µs. This proved startup only, not physical validity.
- A longer fixed-`dt=5e-7 s` attempt later crashed. Coworker-derived mass-flow ramps and more conservative tutorial-style settings were adopted instead.

## Chamber-fill comparison, 2026-09-13 to 2026-09-14

| Fill | Outcome |
|---|---|---|
| N2 | Cancelled after initial comparison; artificial displacement time and species behavior were undesirable. |
| O2, 300 K | Advanced, but species-sum/nonphysical-Y behavior worsened relative to CH4 fill. |
| CH4, 288 K | Best cold baseline; advanced to about 3.49 ms before wall time. Not stationary; pressure/temperature diagnostics still require caution. |

The present target uses the CH4-fill time-zero construction because it was the least problematic numerical initialization. The experiment does not prescribe this chamber-fill startup.

## Ignition screens, 2026-09-13 to 2026-09-16

- Direct hot patches generated strong pressure waves, especially into the low-velocity oxygen passage, and were rejected as the primary strategy.
- Finite-duration, energy-budgeted heat sources were screened at several axial locations and powers, restricted to mixed CH4/O2 cells.
- Weak/long pulses commonly decayed without a self-sustained OH-bearing flame.
- Stronger pulses commonly reached the 5000 K failure guard or produced nonphysical states.
- Zero-power reacting controls showed no spontaneous temperature rise on the sampled cold fields.
- JL9 and a larger RAMEC mechanism were both tried. Mechanism complexity did not remove the underlying ignition/coupling failure.
- No reacting realFluidFoam result is currently accepted as a sustained MASCOTTE flame.

## Failure modes worth retaining

1. **Species boundedness:** transient overshoot can smooth later, but O2-filled starts were worse; never accept a run solely because it continued.
2. **Pressure/species/energy coupling:** real-fluid property corrections, reaction heat release and pressure correction can amplify one another during ignition.
3. **Ignition placement:** heating too close to the injector sends a pressure disturbance upstream before the slow LOX passage can equilibrate.
4. **Ignition strength:** total injected energy alone is not sufficient; spatial concentration, duration, mixed-cell availability and post-pulse chemistry all matter.
5. **Cold-field maturity:** ignition from an underdeveloped mixing field can fail even with an adequate mechanism.
6. **Validation:** a hot field is not a flame. Require sustained heat release/OH after source removal plus experimental spatial comparison.

## Ignition strategy selected, 2026-09-17

The screens above converge on one distinction: heating the **inlet alone** has
not worked, because the hot gas must first travel through the feed passage.
Preheating the **entire CH4 passage** is more effective, since hot methane
reaches the injector lip immediately and mixes with LOX from the beginning.
Both hot-passage cases produced substantial temperature rise and OH.

The selected next baseline is a clean time-zero start with a moderately
preheated CH4 passage and a matching hot inlet, followed by a smooth inlet-
temperature reduction after a flame kernel forms: chamber pure CH4 at 288 K and
stationary, LOX passage pure O2 at 85 K, CH4 passage pure CH4 at about 1400 K,
inlet velocities derived from the prescribed mass flows and the local densities,
CH4 inlet held at 1400 K for about 30 µs then ramped to 288 K over about 200 µs,
JL9 finite-rate/no-TCI from the first step, fixed 0.5 µs. 1400 K rather than
1800 K because 1800 K is too aggressive for a clean start: at fixed mass flow
hot methane needs about 446 m/s initial velocity, and in r470 that gave strong
combustion with a steadily increasing pressure peak.

The hard constraint is thermodynamic consistency: temperature, density, enthalpy
and velocity must all be consistent with the prescribed pressure and mass flow.
A temperature-only patch retaining 288 K density and velocity is not a physical
initial condition.

The full prescription, including three reconciliation notes that must be read
before materializing, is in [`IGNITION-STRATEGY.md`](IGNITION-STRATEGY.md) and
the machine-readable [`ignition-baseline.yaml`](../ignition-baseline.yaml). The
three notes: the stated operating point (5.61 MPa, 0.0441 kg/s O2) differs from
the case lock (5.59 MPa, 0.0444 kg/s); a fixed 0.5 µs step has crashed before
and the advisor measured the adaptive startup step at 1.2e-8 to 3.0e-8 s; and
the advisor's chemistry-off conservation instrumentation remains open.

This is a prescribed next baseline, not a validated result. No reacting
realFluidFoam result is currently accepted as a sustained MASCOTTE flame.

## Next defensible attempts

- Materialize the preheated-passage baseline above as a child attempt, after
  reconciling its three notes against the case lock and the recorded history.
- Establish conservation and stationarity of a cold CH4-fill run at the
  case-lock operating point, with volume-integrated mass, per-species
  inventories and a complete energy ledger over completed steps.
- Quantify mixed-cell volume and residence time before choosing an ignition
  kernel.
- Continue every surviving kernel beyond source removal.
- Compare JL9 with a detailed/skeletal mechanism only after the same cold
  checkpoint and ignition energy budget are held fixed.
- Record mass, species-sum, pressure/density consistency, peak temperature, OH
  and integrated heat release at every written time.

Full records remain in the originating internal investigation package and are not redistributed here. EvoCFD keeps its own records in `../docs/reviews/` and `../runs/`.

