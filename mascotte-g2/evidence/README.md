# Validation evidence

This directory contains compact, traceable facts used to judge a MASCOTTE result. It does not contain publisher PDFs other than the explicitly CC-licensed pair in `papers/`. Rights and provenance for every cited source are recorded in `sources.yaml`; restricted and team-authorized sources are cited by DOI and hash but their bytes are not redistributed.

Directory layout:

- `targets.csv`: scalar operating conditions and acceptance landmarks.
- `sources.yaml`: bibliographic and rights provenance.
- `source-figures/`: selected CC-licensed figures/pages needed to reproduce digitization.
- `figures/cavalieri-2025/`: all 17 caption-linked Cavalieri figure crops with a machine-readable manifest.
- `papers/`: public CC-licensed paper PDFs retained at the user's request.
- `digitized/`: machine-readable field grids and manifests.
- `tools/`: deterministic digitization code.

The `singla-g2-ohstar-relative` bundle is the established experimental relative-OH* reference. `paper-field-manifest.json` describes new Cavalieri Figure 12 and De Giorgi Figure 5 raster inversions. CSV blank values are pixels rejected by the color-distance gate.

The gallery crops remain marked `unreviewed` because their bounds were generated automatically. Use the complete PDFs when a crop has a truncated caption, missing legend or uncertain panel boundary.

## Comparison hierarchy

1. **Experiment:** Candel et al. G2 operating conditions and time-averaged OH* Abel-transform structure.
2. **Geometry/thermophysics:** Cavalieri et al. for the square chamber, mesh-resolution expectations, SRK departure calorics, Chung transport and LES statistics.
3. **RANS comparison:** De Giorgi et al. for area-equivalent 2D modeling, combustion-model sensitivity, modified JL chemistry and the reported ~11-DO flame length.

These sources are not identical simulations. `targets.csv` labels whether a value is a boundary contract, a validation observable, or contextual literature guidance.

## Required result bundle

- center-plane or wedge-plane temperature with full inlet and chamber visible;
- OH mass fraction and, when available, a clearly labeled OH* proxy;
- axial velocity on the same physical coordinates used by references;
- axial/radial profiles at reported measurement planes;
- flame length with an explicit threshold definition;
- time histories of maximum temperature, integrated heat release, outlet/inlet mass balance and species-sum extrema;
- averaging interval in physical time and estimated flow-through times;
- common absolute color bars for side-by-side comparisons.

## Comparability warnings

- Candel’s observable is line-of-sight OH* processed by Abel inversion; OH mass fraction is related but not identical.
- Cavalieri uses a 3D square chamber and much finer LES meshes; this 5° wedge cannot reproduce square-corner or full 3D turbulent structures.
- De Giorgi’s axisymmetric area-equivalent model and SRK closure differ from this wedge/PR baseline.
- A numerical match produced by changing experimental mass flow, temperature or pressure is not accepted.
