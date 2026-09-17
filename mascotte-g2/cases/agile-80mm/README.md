# Agile 80 mm variant

This case is cut from the locked 200 mm target at `x = 80 mm`, retaining the complete inlet/feed topology and all cells whose centers lie at or upstream of the cut. The exposed cut faces are assigned to `outlet`. Fields are subset from the same explicit time-zero state.

Use it for fast startup, thermodynamics, chemistry, ignition, coupling and regression tests. Do **not** use it to claim experimental flame-length or downstream-field validation. The shorter outlet distance can influence pressure waves, recirculation and flame development.

The experimental inlet boundary contract is unchanged. `system/topoSetDict` records the deterministic selection used to make the mesh.

