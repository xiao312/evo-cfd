# Consultation external-diagnostic-selection

## Decision requested

A chemistry-off child of the MASCOTTE G2 agile case initializes and advances under realFluidReactingFoam, but reaches only about 1.2e-7 s of a requested 1e-5 s before a deliberately short 240 s budget stops it. The real-fluid property path is active and the sampled temperature extrema are the two inlet values. Given this cold-start evidence and the fixed operating conditions, what should the next bounded diagnostic run measure to distinguish normal startup behaviour from a thermodynamic or coupling problem? Which conserved quantities or diagnostics would discriminate, and what would each outcome imply?

Why this matters now:

The execution machinery is now proven: a deadline stops a run and the receipt decides the outcome. What is not known is whether the slow physical-time advance and the sampled temperature behaviour are normal for this coupled real-fluid startup or indicate a thermodynamic inconsistency. Before spending a long run, the next diagnostic should be chosen by what would discriminate.

## Fixed problem definition

- The MASCOTTE G2 operating point is fixed: 5.59 MPa, LOX 44.4 g/s at 85 K, GCH4 143.1 g/s at 288 K, a 5-degree wedge, O/F 0.31
- The Peng-Robinson real-fluid property path is exercised: PRchungKineticMixture, chungKinetic transport, rfJanaf thermo, rfSpecie
- The imported target case is immutable; any change belongs in a disposable child attempt
- The stock OpenFOAM-8 installation must remain unchanged

Allowed changes:

- the case dictionaries in a disposable child attempt
- what is measured and sampled, including conserved sums and extrema
- whether chemistry is enabled, for a diagnostic that isolates the flow/thermo coupling

Outside the advisor's authority:

- the solver source
- the mandatory physical boundary conditions
- anything that promotes a change without execution evidence

Conventions in force:

- absolute pressure, not gauge
- mass fractions, species order as declared in the case
- sampled extrema are not a time history
- the solver's own term 'time step continuity errors' is kept, not read as a residual

## Observed evidence, hypotheses and open questions

**OBSERVATION O1**

A chemistry-off child of the agile MASCOTTE case initializes and advances under realFluidReactingFoam, reaching about 1.2e-7 s of a requested 1e-5 s before a 240 s wall-clock budget stopped it.

*Source: attempt-record.json and execution-receipt.txt of mascotte-agile-002, attached*

**OBSERVATION O2**

The receipt records exit code 124 with wall_clock_seconds equal to budget_seconds, so the stop was the deadline and not a solver crash; the log ends mid-timestep with no normal End.

*Source: execution-receipt.txt, attached*

**OBSERVATION O3**

The Peng-Robinson real-fluid property path is active throughout: PRchungKineticMixture, chungKinetic transport, rfJanaf thermo, rfSpecie.

*Source: the solver log, attached*

**OBSERVATION O4**

The last sampled temperature extrema are the two inlet values, 85 K and 288.26 K, which is what chemistry-off flow at this operating point should show; the maximum drifts slowly upward across the sampled window.

*Source: temperature-samples.txt, attached; sampled values, not a time history*

**OBSERVATION O5**

The adjustable time step grows during the run, from about 1.2e-8 to about 1.0e-7, so the solver is responding to the flow rather than stuck at the initial step.

*Source: deltat-history.txt, attached*

**WORKER HYPOTHESIS H1**

The slow advance in physical time is the coupled real-fluid startup at 5.59 MPa resolving the LOX/CH4 interface, not a pathology.

*Source: worker reading the logs; untested*

**WORKER HYPOTHESIS H2**

The slow upward temperature drift is wall or inlet coupling warming the domain.

*Source: worker reading the sampled series; untested, and the window is far too short to characterise a rate*

**NOT YET ESTABLISHED N1**

Whether the run would reach the requested end time given a full budget. Only about 1.2 percent of the interval was covered.

*Source: the budget stopped the run by design*

**NOT YET ESTABLISHED N2**

Whether the conserved sums hold: sum(Y), total enthalpy, and mass balance have not been examined in any run.

*Source: no conservation check has been made*

**NOT YET ESTABLISHED N3**

Whether the sampled temperature extrema verify both inlet boundary conditions; the extrema alone do not identify a cause for the drift.

*Source: only min/max(T) is sampled*

## Attempts so far

- imported the MASCOTTE G2 case and validated it on the pinned build
- materialised a chemistry-off child with the per-species scheme entries derived from the mechanism
- ran the child through the shared execution backend with a 240 s budget
- assessed the outcome from the receipt and the log together

## Worker's interpretation

The startup is real and the machinery is proven, but I have only sampled extrema and a very short window. I cannot tell whether the slow physical-time advance and the temperature drift are normal for this coupled real-fluid startup or indicate a thermodynamic inconsistency. Before spending a long run I want the next diagnostic chosen by what would discriminate.

## Available actions and limits

- edit the case dictionaries in a disposable child attempt
- choose what is sampled, including conserved sums and extrema over time
- run a bounded serial solver job through the controller
- enable chemistry for a diagnostic that isolates the flow/thermo coupling

Limits:

- the solver source is read-only for this consultation
- the imported target case is immutable; changes belong in a child
- the budget is one or two short serial runs
- the stock OpenFOAM-8 installation must not change

## Response requested

- which conserved quantities or diagnostics would discriminate normal startup from a coupling problem, and why those
- what each possible outcome would imply, so the diagnostic is informative either way
- the smallest bounded run that carries that discrimination
- any prerequisite or artifact I have not attached, rather than an inference

If you need an artifact that is not attached, say so rather than inferring its contents.

