# Ignition strategy — preheated methane passage with a matching hot inlet

This is the selected strategy for obtaining a sustained reacting MASCOTTE G2
flame. It is recorded here because it is the conclusion of the ignition screens
in [ATTEMPT-HISTORY.md](ATTEMPT-HISTORY.md), and because it is a *child-attempt
configuration*: it changes nothing in the immutable target.

Under `case-lock.yaml`, `ignition method and energy budget` and `documented
time-zero chamber fill` are both **tunable**. The target's shipped `0/` fields,
operating point and physical models are unchanged by this document. A preparer
materializes this as a derived initialization in a disposable child attempt,
exactly as the child-attempt contract requires.

## What was tried, and what it showed

Observed outcomes of the ignition screens, recorded as observations and not as
interpretations:

| Approach | Outcome |
|---|---|
| Direct hot patch on a developed cold flow | Strong pressure waves, especially into the low-velocity oxygen passage. Rejected as a primary strategy. |
| Inlet-only heating, CH4 inlet at 1200 K | No meaningful OH produced. |
| Inlet-only heating, CH4 inlet at 1800 K | No meaningful OH produced. |
| Preheated CH4 feed **passage**, 1200 K | Substantial temperature rise and OH. |
| Preheated CH4 feed **passage**, 1800 K | Substantial temperature rise and OH; strong combustion, but a steadily increasing pressure peak (run r470). |
| Finite-duration energy-budgeted sources | Weak pulses decay without a self-sustained kernel; strong pulses reach the 5000 K failure guard. |
| Zero-power reacting controls | No spontaneous temperature rise on the sampled cold fields. |

The distinction that matters: heating the **inlet alone** has not worked, because
the hot gas must first travel through the feed passage. Preheating the **entire
CH4 passage** is more effective — hot methane reaches the injector lip
immediately and mixes with LOX from the beginning.

## The selected baseline

Clean time-zero initialization, moderately preheated methane passage, matching
hot inlet, then a smooth inlet-temperature reduction once a flame kernel forms.

**Chamber at t = 0**

- Pure CH4
- T = 288 K
- p = 5.61 MPa (see the reconciliation note below)
- U = 0 (initially stationary)

**LOX passage at t = 0**

- Pure O2
- T = 85 K
- Mass flow 0.0441 kg/s (full-injector basis)
- Inlet velocity consistent with the local density at 85 K

**CH4 passage at t = 0**

- Pure CH4
- T ≈ 1400 K
- Mass flow 0.1431 kg/s (full-injector basis)
- Inlet velocity consistent with the local density at 1400 K

**CH4 inlet temperature schedule**

1. Hold at 1400 K for ≈ 30 µs
2. Ramp from 1400 K to 288 K over ≈ 200 µs
3. Remain at 288 K thereafter

**Chemistry and time step**

- JL9, finite-rate with no turbulence-chemistry interaction, enabled from the
  first time step
- Fixed time step of 0.5 µs

1400 K is chosen because 1800 K is too aggressive for a clean start: at fixed
mass flow, hot methane has a much lower density, so maintaining 0.1431 kg/s at
1800 K requires an initial velocity of about 446 m/s, and in r470 that produced
strong combustion together with a steadily increasing pressure peak.

## The hard constraint: thermodynamic consistency

Temperature, density, enthalpy and velocity must all be consistent with the
prescribed pressure and mass flow.

> We must not patch only the temperature while retaining the density and
> velocity associated with 288 K methane.

This is the failure mode the strategy is designed to avoid. Raising the passage
temperature without recomputing density, enthalpy and inlet velocity creates an
inconsistent state — a hot field with a cold-field momentum and energy inventory
— which is not a physical initial condition and cannot be attributed to any
property package.

In practice the preparer must:

- set the passage composition and temperature;
- **derive** the passage density and specific enthalpy from the pinned
  Peng-Robinson / rfJanaf property package at the prescribed pressure, not
  overwrite them by hand;
- **derive** the inlet velocity from the prescribed mass flow and the derived
  density;
- record the derived values in the attempt record so the initialization is
  reproducible and auditable.

## Reconciliation notes — read before materializing

Three open tensions between this prescription and the recorded evidence. They
are recorded, not silently resolved.

**1. The operating-point numbers differ from the case lock.** This prescription
states 5.61 MPa and 0.0441 kg/s oxygen. `case-lock.yaml` records the operating
point as 5.59 MPa and 0.0444 kg/s oxygen (methane 0.1431 kg/s in both), sourced
from Candel et al. 2006 Table 1. The case lock is the immutable physical
contract; this document does not re-lock it. A child attempt must either run on
the case-lock operating point, or the operator must explicitly re-lock the case.
Decide before materializing.

**2. A fixed 0.5 µs time step has crashed before.** ATTEMPT-HISTORY.md records
that "a longer fixed-dt = 5e-7 s attempt later crashed," after which ramped and
more conservative settings were adopted. 5e-7 s is exactly 0.5 µs. Independently,
the external advisor measured the chemistry-off startup advancing at an
adaptive Δt of about 1.2e-8 to 3.0e-8 s with a largest printed Courant number of
7.3e-6 against a configured maxCo of 0.3. A fixed 0.5 µs is roughly 17 to 40
times larger than that, and once the hot methane reaches the injector the
velocities are far higher — at 446 m/s and 0.5 µs, satisfying maxCo 0.3 requires
cell sizes above roughly 0.7 mm, which the near-injector mesh does not have.
Reconcile before materializing: either verify that the preheated passage changes
the stability regime enough to sustain 0.5 µs, or begin with an adjustable
run-time step capped at maxCo and treat 0.5 µs as the target.

**3. The advisor's chemistry-off instrumentation is still open.** The external
consultation `external-diagnostic-selection` recommended instrumenting a
chemistry-off run with volume-integrated mass, per-species inventories and a
complete energy ledger over a few completed steps, before attributing any
result to a property package. This ignition strategy is a separate thread and
does not bypass that recommendation. A reacting baseline whose conservation has
not been measured cannot be distinguished from a conservative-but-inconsistent
one by temperature or OH alone — the advisor was explicit that a species sum
near one is partly algebraically enforced by the inert-species closure.

## Status

This is a **prescribed next baseline, not a validated result.** No reacting
realFluidFoam result is currently accepted as a sustained MASCOTTE flame. The
acceptance gate in [README.md](README.md) — sustained heat release after the
external ignition source is removed, conservation and boundedness, and
experimental spatial comparison — applies unchanged.
