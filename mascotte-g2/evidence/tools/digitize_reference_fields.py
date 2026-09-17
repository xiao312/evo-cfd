#!/usr/bin/env python3
"""Reproduce approximate field grids from two CC-licensed paper figures.

Requires numpy and Pillow. Pixel rectangles were manually reviewed against the
stored source figures. Values are nearest-colour inversions of the displayed
horizontal colour bars; they are not author-supplied numerical data.
"""

from __future__ import annotations

import csv
import hashlib
import json
from pathlib import Path

import numpy as np
from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
SOURCES = ROOT / "source-figures"
OUTPUT = ROOT / "digitized"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def inverse_colour_grid(
    source: Path,
    *,
    field_box: tuple[int, int, int, int],
    bar_box: tuple[int, int, int, int],
    value_range: tuple[float, float],
    x_range: tuple[float, float],
    y_range: tuple[float, float],
    shape: tuple[int, int],
    output_name: str,
    metadata: dict,
    max_rgb_distance: float = 35.0,
) -> dict:
    image = np.asarray(Image.open(source).convert("RGB"), dtype=float)
    fx0, fy0, fx1, fy1 = field_box
    bx0, by0, bx1, by1 = bar_box
    field = image[fy0:fy1, fx0:fx1]
    bar_region = image[by0:by1, bx0:bx1]
    bar = np.median(bar_region, axis=0)

    ny, nx = shape
    xi = np.linspace(0, field.shape[1] - 1, nx).round().astype(int)
    yi = np.linspace(0, field.shape[0] - 1, ny).round().astype(int)
    sampled = field[np.ix_(yi, xi)]
    flat = sampled.reshape(-1, 3)
    distances = np.linalg.norm(flat[:, None, :] - bar[None, :, :], axis=2)
    indices = np.argmin(distances, axis=1)
    minimum = distances[np.arange(len(flat)), indices]
    values = value_range[0] + (value_range[1] - value_range[0]) * indices / max(len(bar) - 1, 1)
    values[minimum > max_rgb_distance] = np.nan
    values = values.reshape(ny, nx)
    minimum = minimum.reshape(ny, nx)

    x = np.linspace(*x_range, nx)
    y = np.linspace(*y_range, ny)
    output = OUTPUT / f"{output_name}.csv"
    with output.open("w", newline="", encoding="utf-8") as stream:
        writer = csv.writer(stream)
        writer.writerow(["x", "y", "value", "rgb_distance"])
        for j, y_value in enumerate(y):
            for i, x_value in enumerate(x):
                value = values[j, i]
                writer.writerow(
                    [
                        f"{x_value:.9g}",
                        f"{y_value:.9g}",
                        "" if not np.isfinite(value) else f"{value:.12g}",
                        f"{minimum[j, i]:.7g}",
                    ]
                )

    record = {
        **metadata,
        "file": output.name,
        "source_figure": source.name,
        "source_sha256": sha256(source),
        "field_box_px": field_box,
        "colourbar_box_px": bar_box,
        "declared_value_range": value_range,
        "coordinate_ranges": {"x": x_range, "y": y_range},
        "grid_shape_ny_nx": shape,
        "maximum_accepted_rgb_distance": max_rgb_distance,
        "finite_fraction": float(np.isfinite(values).mean()),
        "csv_sha256": sha256(output),
        "method": "nearest RGB on displayed colour bar after reviewed raster crop",
        "quantitative_limit": "approximate figure-derived values; not raw author data",
    }
    return record


def digitize_degiorgi_centerline(source: Path) -> dict:
    """Digitize Figure 4b blue/red centerline-temperature curves."""
    image = np.asarray(Image.open(source).convert("RGB"), dtype=float)
    x0, y0, x1, y1 = 446, 519, 691, 742
    plot = image[y0:y1 + 1, x0:x1 + 1]
    output = OUTPUT / "de-giorgi-2014-fig4b-centerline-temperature.csv"
    rows = []
    for i in range(plot.shape[1]):
        column = plot[:, i, :]
        masks = {
            "case1_JL": (column[:, 2] > column[:, 0] + 18) & (column[:, 2] > column[:, 1] + 8),
            "case2_SKEL": (column[:, 0] > column[:, 2] + 18) & (column[:, 0] > column[:, 1] + 5),
        }
        x_m = 0.09 * i / max(plot.shape[1] - 1, 1)
        values = {}
        for name, mask in masks.items():
            indices = np.flatnonzero(mask)
            if len(indices):
                pixel_y = float(np.median(indices))
                values[name] = 3500.0 * (1.0 - pixel_y / max(plot.shape[0] - 1, 1))
            else:
                values[name] = None
        rows.append((x_m, values["case1_JL"], values["case2_SKEL"]))
    with output.open("w", newline="", encoding="utf-8") as stream:
        writer = csv.writer(stream)
        writer.writerow(["x_m", "case1_JL_temperature_K", "case2_SKEL_temperature_K"])
        for x_m, case1, case2 in rows:
            writer.writerow(
                [
                    f"{x_m:.9g}",
                    "" if case1 is None else f"{case1:.9g}",
                    "" if case2 is None else f"{case2:.9g}",
                ]
            )
    return {
        "source_id": "paper:de-giorgi-2014-combustion-models",
        "figure": "Figure 4b",
        "quantity": "centerline temperature",
        "file": output.name,
        "source_figure": source.name,
        "source_sha256": sha256(source),
        "plot_box_px": [x0, y0, x1, y1],
        "axis_calibration": {"x_m": [0.0, 0.09], "temperature_K": [0.0, 3500.0]},
        "experimental_peak_position_band_m_approx": [0.053, 0.061],
        "csv_sha256": sha256(output),
        "method": "colour-threshold trace with median curve pixel per axial column",
        "quantitative_limit": "approximate figure-derived curve; not raw author data",
    }


def main() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    records = []

    cavalieri = SOURCES / "cavalieri-2025-fig12.png"
    common_cavalieri = {
        "source_id": "paper:cavalieri-2025-pseudoboiling",
        "figure": "Figure 12a",
        "quantity": "displayed mean OH-star",
        "value_unit": "mol/m3 as plotted; experimental absolute calibration remains uncertain",
        "x_unit": "mm",
        "y_unit": "mm",
    }
    records.append(
        inverse_colour_grid(
            cavalieri,
            field_box=(148, 58, 639, 198),
            bar_box=(310, 40, 468, 51),
            value_range=(0.0, 8.0e-6),
            x_range=(0.0, 70.0),
            y_range=(20.0, 0.0),
            shape=(48, 112),
            output_name="cavalieri-2025-fig12a-sfm-numerical-ohstar",
            metadata={**common_cavalieri, "panel": "upper numerical SFM"},
        )
    )
    records.append(
        inverse_colour_grid(
            cavalieri,
            field_box=(148, 199, 639, 339),
            bar_box=(310, 40, 468, 51),
            value_range=(0.0, 8.0e-6),
            x_range=(0.0, 70.0),
            y_range=(0.0, -20.0),
            shape=(48, 112),
            output_name="cavalieri-2025-fig12a-experimental-ohstar",
            metadata={**common_cavalieri, "panel": "lower experimental Abel-transformed OH-star"},
        )
    )

    degiorgi = SOURCES / "de-giorgi-2014-page12.png"
    for case, ybox in (("case2", (331, 379)), ("case1", (383, 430))):
        records.append(
            inverse_colour_grid(
                degiorgi,
                field_box=(80, ybox[0], 336, ybox[1]),
                bar_box=(269, 296, 363, 310),
                value_range=(0.0, 1.0),
                x_range=(0.0, 18.0),
                y_range=(1.0, 0.0),
                shape=(28, 108),
                output_name=f"de-giorgi-2014-fig5a-{case}-o2",
                metadata={
                    "source_id": "paper:de-giorgi-2014-combustion-models",
                    "figure": "Figure 5a",
                    "panel": case,
                    "quantity": "oxygen mass fraction",
                    "value_unit": "mass fraction",
                    "x_unit": "oxygen-injector diameters",
                    "y_unit": "normalized raster height; no radial scale reported in panel",
                },
            )
        )

        records.append(
            inverse_colour_grid(
                degiorgi,
                field_box=(412, ybox[0], 668, ybox[1]),
                bar_box=(494, 296, 606, 310),
                value_range=(0.0, 3600.0),
                x_range=(0.0, 18.0),
                y_range=(1.0, 0.0),
                shape=(28, 108),
                output_name=f"de-giorgi-2014-fig5b-{case}-temperature",
                metadata={
                    "source_id": "paper:de-giorgi-2014-combustion-models",
                    "figure": "Figure 5b",
                    "panel": case,
                    "quantity": "temperature",
                    "value_unit": "K",
                    "x_unit": "oxygen-injector diameters",
                    "y_unit": "normalized raster height; no radial scale reported in panel",
                },
            )
        )

    records.append(
        digitize_degiorgi_centerline(SOURCES / "de-giorgi-2014-page11.png")
    )

    manifest = {
        "schema_version": 1,
        "generated_by": Path(__file__).name,
        "records": records,
        "review": [
            "Use field topology and approximate extents; do not treat raster values as author data.",
            "Blank CSV values failed the RGB-distance gate.",
            "De Giorgi radial coordinate is normalized because Figure 5 does not plot a radial scale.",
            "Cavalieri experimental OH-star is Abel transformed; its absolute scaling is less certain than spatial support.",
        ],
    }
    path = OUTPUT / "paper-field-manifest.json"
    path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(path)


if __name__ == "__main__":
    main()
