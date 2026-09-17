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

## Next defensible attempts

- Establish conservation and stationarity of a cold CH4-fill run at the corrected 5.59 MPa / 44.4 g/s / 143.1 g/s operating point.
- Quantify mixed-cell volume and residence time before choosing an ignition kernel.
- Perform a compact, energy-conserving ignition sweep and continue every surviving kernel beyond source removal.
- Compare JL9 with a detailed/skeletal mechanism only after the same cold checkpoint and ignition energy budget are held fixed.
- Record mass, species-sum, pressure/density consistency, peak temperature, OH and integrated heat release at every written time.

Full records remain in the originating internal investigation package and are not redistributed here. EvoCFD keeps its own records in `../docs/reviews/` and `../runs/`.

