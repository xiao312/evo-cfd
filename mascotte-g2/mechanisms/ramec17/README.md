# CNF-RAMEC 17-species / 44-reaction profile

This optional mechanism is derived from Monnier and Ribert, “Simulation of high-pressure methane-oxygen combustion with a new reduced chemical mechanism,” *Combustion and Flame* (2021). The supplied source contains 18 total species: 17 reactive species plus inert N2, and 44 reactions.

## Contents

- `cantera/CNF_RAMEC_17S_44R.yaml`: unchanged supplied Cantera mechanism; SHA-256 `d6ffacadde8a1cc8965798d113014a7e0f310099fc349f6e9cb16b55cbef14bf`.
- `chemkin/`: Cantera 3.2 export used for the OpenFOAM conversion. The ideal-gas wrapper was used only to export kinetic/NASA coefficients; it is not the production EOS.
- `openfoam8/reactions`: all 44 reactions converted with OpenFOAM 8 `chemkinToFoam`.
- `openfoam8/thermo.inputData`: realFluidFoam species/property dictionary.
- `openfoam8/property-assumptions.json`: species-by-species property provenance and provisional estimates.
- `activate-ramec.sh`: creates a new RAMEC child case without modifying the source target.

## Important limits

- The source mechanism’s stated pressure range is 1–100 bar. MASCOTTE G2 at 55.9 bar is within that pressure range, but this alone is not validation.
- Source O2/CH4 NASA polynomials begin at 300 K. The 85 K LOX inlet therefore requires extrapolation; Peng–Robinson density does not validate low-temperature calorics.
- Major-species real-fluid data are inherited. Radical/intermediate critical and transport properties include provisional estimates reconstructed from the supplied PR/Lennard-Jones data.
- Prior realFluidFoam RAMEC ignition screens loaded and advanced the mechanism, but did not yield an accepted sustained MASCOTTE flame.
- This mechanism is a comparison branch, not the new default.

## Activation

From the package root:

```bash
./mechanisms/ramec17/activate-ramec.sh \
  cases/agile-80mm \
  $PWD/../../runs/mascotte-ramec17-agile-001
```

The target directory must not already exist. The script copies the source case, replaces `thermo.inputData` and `reactions`, and creates zero initial fields for RAMEC-only species. Run `Allcheck` against the child afterward.

