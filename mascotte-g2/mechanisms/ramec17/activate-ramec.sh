#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 2 ]; then
    echo "usage: $0 SOURCE_CASE NEW_CHILD_CASE" >&2
    exit 2
fi

source_case=$(realpath "$1")
target_parent=$(realpath "$(dirname "$2")")
target_case="$target_parent/$(basename "$2")"
profile_dir=$(cd "$(dirname "$0")" && pwd)

test -d "$source_case/0"
test -d "$source_case/constant/polyMesh"
if [ -e "$target_case" ]; then
    echo "refusing to overwrite existing target: $target_case" >&2
    exit 1
fi

cp -a "$source_case" "$target_case"
cp "$profile_dir/openfoam8/thermo.inputData" "$target_case/constant/thermo.inputData"
cp "$profile_dir/openfoam8/reactions" "$target_case/constant/reactions"
cp "$profile_dir/openfoam8/property-assumptions.json" \
   "$target_case/constant/ramec17-property-assumptions.json"

for species in HO2 H2O2 CH3 HCO CH2O CH3O C2H6 CH3O2; do
    field="$target_case/0/$species"
    if [ -e "$field" ]; then
        continue
    fi
    cat >"$field" <<EOF
FoamFile
{
    version 2.0;
    format ascii;
    class volScalarField;
    location "0";
    object $species;
}

dimensions [0 0 0 0 0 0 0];
internalField uniform 0;

boundaryField
{
    loxinlet { type fixedValue; value uniform 0; }
    ch4inlet { type fixedValue; value uniform 0; }
    outlet { type zeroGradient; }
    #include "include/scalarWallsWedges"
}
EOF
done

cat >"$target_case/MECHANISM" <<EOF
profile: CNF-RAMEC-17S-44R
source_sha256: d6ffacadde8a1cc8965798d113014a7e0f310099fc349f6e9cb16b55cbef14bf
species: 18 total; 17 reactive plus N2
reactions: 44
created_from: $source_case
EOF

echo "Created RAMEC17 child case: $target_case"

