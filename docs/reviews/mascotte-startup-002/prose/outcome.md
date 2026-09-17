# Established

- The deadline fired and the receipt recorded it | execution-receipt.txt: exit_code 124, wall_clock_seconds 240 of budget 240
- The receipt decided the state, not the log | the assessment reported budget_exceeded, not solver_error, on a log ending mid-timestep
- The receipt is valid and parseable | the line-based key=value format replaced the JSON heredoc that carried a trailing comma

# Remains open

- whether the solver reaches the requested end time given a full budget
- whether the deadline also collects a solver that has forked children in the real case, as the dummy-solver test does

# Hypotheses

- The slow wall-clock advance is the coupled real-fluid solve rather than a pathology | untested

# Completion

cut_short

# Completion detail

The 240 s budget stopped the run at 240 s, as planned; the last reported time was 1.1869477e-7 of the requested 1e-5.
