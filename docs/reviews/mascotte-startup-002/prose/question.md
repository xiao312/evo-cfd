# Question

Does the shared host execution backend enforce its own deadline, and does the
receipt it writes decide the recorded outcome?

# Why now

The preceding revision claimed a bounded execution path, but the deadline was
applied to a shell expression that `timeout` could not interpret, the receipt
was invalid JSON, and the state was decided from the log before the receipt was
read. Three of the four behaviours the record asserted had never been observed.

# Prior evidence

- mascotte-startup-001: the run was stopped by an operator, and stopping the launcher's bash left the solver running for several minutes more
- the review of dac3970 reproduced all four defects with a dummy solver

# Answerable if

The receipt exists, is parseable, and records an exit code and a wall clock
against the declared budget.

# Falsified if

The receipt is absent or unparseable, so the outcome can only be guessed from a
log that ends mid-timestep.
