# Digitized data inventory

| Dataset | Quantity | Coordinate system | Best use |
|---|---|---|---|
| `singla-g2-ohstar-relative.npz` | relative experimental OH* | x/y in mm | primary experimental flame support/topology; 5% extent 0.35–62.65 mm |
| `cavalieri-2025-fig12a-sfm-numerical-ohstar.csv` | displayed mean numerical OH* | x/y in mm | topology and approximate plotted magnitude |
| `cavalieri-2025-fig12a-experimental-ohstar.csv` | displayed Abel-transformed experimental OH* | x/y in mm | experiment/paper spatial comparison; absolute calibration uncertain |
| `de-giorgi-2014-fig5a-case*-o2.csv` | O2 mass fraction | x in oxygen-injector diameters; normalized image height | liquid/core extent and topology |
| `de-giorgi-2014-fig5b-case*-temperature.csv` | temperature | x in oxygen-injector diameters; normalized image height | flame extent and topology |
| `de-giorgi-2014-fig4b-centerline-temperature.csv` | JL/SKEL centerline temperature | x in m; temperature in K | peak position and axial decay comparison |

Each CSV contains `x,y,value,rgb_distance`. Blank values failed the color-distance gate. `paper-field-manifest.json` contains crop coordinates, source hashes, ranges and finite-pixel fractions. Regenerate with:

```bash
python ../tools/digitize_reference_fields.py
```

These are approximate raster inversions. Do not use them as higher-precision data than the published figure supports.
