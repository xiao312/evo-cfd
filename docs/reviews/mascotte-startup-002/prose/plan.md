# Intervention

Set the budget to 240 s against a case that needs far longer, so the deadline
must fire. Run the prepared MASCOTTE child through the same backend a generic
job uses, then assess from the receipt and the log together.

# Expected observations

- exit code 124, which is timeout's own code for a deadline stop
- wall clock equal to the budget, to the second
- no normal End in the solver log

# Evaluation method

The receipt decides the terminal state. The log is read only to report the last
physical time reached. A truncated log without a receipt would be an execution
error, not a budget stop.

# Budget seconds

240

# Requested end time

0.00001

# Bounds note

The point is the deadline, so the physical interval is deliberately unreachable
within the budget; a short interval is expected and is not a failure.
