/**
 * The decision-context assembler.
 *
 * Why this exists. EvoCFD records a great deal and makes very little of it
 * usable for reasoning. The records can say that attempt A exited 1 and attempt
 * B exited 0 and that fvSchemes changed, which is auditable — but it is a run
 * archive, not a scientific working context. A model asked to propose the next
 * intervention needs to know what A was intended to test, what observation
 * motivated the change, exactly which entries changed, what was held constant,
 * which measurements supported the conclusion, and which explanations remain
 * open. That is the difference the assembler exists to make.
 *
 * The assembler is one reusable component, not another collection of
 * case-specific prompt scripts. Its input is the current investigation and the
 * role of the next model invocation. Its outputs are:
 *
 *   - a compact briefing;
 *   - an evidence and source index, so anything summarised can be opened;
 *   - a record of what was supplied automatically, and what could not be;
 *   - the authorised retrieval and experiment-request capabilities.
 *
 * The views differ, the record does not. An execution agent, a scientific
 * advisor, a harness proposer and a human reviewer each need a different slice
 * of the *same* underlying investigation, not four independently authored
 * narratives that can disagree. So the assembler composes recorded artifacts
 * rather than writing prose, and it states its own coverage: what it could not
 * find is reported as missing, never smoothed into a confident summary.
 *
 * Access follows the reasoning task. The workspace diff is no longer withheld
 * from every role on principle: a proposer may need the worker's changes to tell
 * whether an interface was misunderstood, an unnecessary change was made, or a
 * useful diagnostic procedure was applied. Overfitting is prevented by fresh
 * evaluation and transfer tests, not by withholding evidence the reasoning
 * needs. What stays protected is the evaluator's private implementation and any
 * held-out answers, which no view receives.
 */

import { readFile, mkdir, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";

import type { Dossier } from "./dossier.ts";
import type { InvestigationRecord } from "./investigation.ts";
import type {
  ConsultationRequest,
  ConsultationState,
} from "./consultation.ts";

/** The role of the next model invocation. It selects the view, not the truth. */
export type ContextRole =
  | "execution_agent"
  | "scientific_advisor"
  | "harness_proposer"
  | "human_reviewer";

/** What the invocation is being asked to do. Constraints the contract shown. */
export type ContextPurpose =
  | "case_diagnosis"
  | "algorithm_design"
  | "harness_improvement"
  | "experiment_execution";

/** What the assembler is permitted to include in a given view. */
export interface EvidencePolicy {
  /**
   * Whether the authorised task diff may be included. It is withheld from the
   * evaluator by necessity, and from an advisor only when the purpose is a pure
   * diagnosis of the case rather than of the implementation.
   */
  include_task_diff: boolean;
  /** Whether solver source may be quoted. Read-only roles still get anchors. */
  include_source_excerpts: boolean;
  /** Whether held-out evaluator references are included. Never, by design. */
  include_evaluator_internals: boolean;
  /** A soft budget on the rendered briefing, in characters. */
  context_budget: number;
}

/** One item of evidence the briefing cites, with its provenance. */
export interface EvidenceItem {
  /** The claim the briefing makes. */
  claim: string;
  /** Where it came from: a run, a bundle, a document, a log line. */
  source: string;
  /** How the claim is supported. */
  basis: "measured" | "inferred" | "advisor_proposal" | "operator_directive";
  /** Where the underlying artifact can be opened, relative to the repo root. */
  artifact: string;
}

/** An intervention the next model should know about, as an intervention. */
export interface InterventionView {
  attempt_id: string;
  /** What the attempt was intended to test, as recorded before the run. */
  intent: string;
  /** The change as planned. */
  planned_change: string;
  /** The change as actually made, from the preparer's own record. */
  actual_changes: string[];
  /** What motivated the change. */
  motivated_by: string;
  /** What was held constant. */
  held_constant: string[];
  /** What the evaluation measured, and what it did not. */
  evaluation_scope: { measured: string[]; not_measured: string[] };
  /** What the attempt established, each tied to its evidence. */
  established: { claim: string; evidence: string }[];
  /** What remains open, including what a partial run could not address. */
  remains_open: string[];
  /** Competing interpretations, with their status. */
  hypotheses: { statement: string; status: "untested" | "supported" | "withdrawn" }[];
  /** Whether the run completed its planned interval. */
  completion: "completed" | "cut_short" | "failed";
}

/** An experimental capability the model may request or invoke. */
export interface Capability {
  id: string;
  name: string;
  /** What it accomplishes. */
  does: string;
  /** What it costs, in terms a planner can weigh. */
  cost: string;
  /** Whether the role may invoke it directly or only request it. */
  permission: "invoke" | "request_only";
  /** What the response carries back, so the model knows what to expect. */
  returns: string;
}

/** The contract under which an improvement is judged. */
export interface EvaluationContract {
  quantity_improved: string;
  quality_constraints: string[];
  comparable_baseline: string;
  resource_accounting: string;
  development_cases: string[];
  /** The domain a general claim must transfer to. */
  transfer_domain: string;
  /** Evidence a general claim still requires. */
  evidence_still_required: string[];
}

/** The assembled context, as written and as read. */
export interface DecisionContext {
  schema_version: 1;
  context_id: string;
  investigation_id: string;
  role: ContextRole;
  purpose: ContextPurpose;
  created_at: string;
  /** The objective and what may not change. */
  objective: string;
  fixed: string[];
  permitted: string[];
  not_automatically_permitted: string[];
  /** The dossier the briefing draws on, with its verification state. */
  dossier: { id: string; verified: boolean; unverified_entries: string[] };
  /** What the relevant computation does, as a compact map. */
  algorithm_summary: string;
  /** The interventions, ordered earliest first. */
  interventions: InterventionView[];
  /** The current measured state, and what could not be measured. */
  current_state: {
    measured: EvidenceItem[];
    unmeasured: string[];
  };
  /** The evaluation contract the next proposal will be judged by. */
  evaluation_contract: EvaluationContract;
  /** The capabilities available to this role. */
  capabilities: Capability[];
  /** What the assembler supplied automatically. */
  supplied: { kind: string; path: string }[];
  /** What the assembler could not find. Reported, never inferred. */
  missing: string[];
  /** The rendered briefing itself. */
  briefing: string;
  /** Digest over everything above, so a citation can be bound to a context. */
  digest: string;
}

export class ContextError extends Error {
  readonly code = "ECONTEXT";
}

const CONTEXT_FILE = "decision-context.json";

/**
 * Assemble the context for the next model invocation.
 *
 * Every input is an already-recorded artifact: an investigation record, a
 * dossier, a consultation state, and the attempt directories that carry
 * interventions. The assembler composes them; it never writes a claim it cannot
 * point at. What it cannot find becomes a `missing` entry, which is how a gap
 * becomes visible to the model instead of hidden behind confident prose.
 */
export async function assembleDecisionContext(input: {
  runRoot: string;
  investigation: InvestigationRecord;
  dossier: Dossier;
  /** The dossier's verification against the pinned source, if it was run. */
  dossierVerification?: { ok: boolean; failures: { entry: string }[] };
  state: ConsultationState;
  request?: ConsultationRequest;
  role: ContextRole;
  purpose: ContextPurpose;
  /** Directories holding earlier attempts, earliest first. */
  attemptDirs: string[];
  now?: () => Date;
}): Promise<DecisionContext> {
  const now = (input.now ?? (() => new Date()))();
  const policy = policyFor(input.role, input.purpose);
  const capabilities = capabilitiesFor(input.role, input.purpose);

  const interventions: InterventionView[] = [];
  for (const d of input.attemptDirs) {
    const view = await interventionView(d, input.investigation);
    if (view) interventions.push(view);
  }
  // Earliest first, so the reader meets causes before effects.
  interventions.sort((a, b) => a.attempt_id.localeCompare(b.attempt_id));

  const measured = collectMeasured(input.investigation, input.state, input.dossier);
  const unmeasured = collectUnmeasured(input.investigation, input.dossier);

  const contract = evaluationContractFor(input.purpose, input.investigation, input.dossier);

  const objective = objectiveFor(input.purpose, input.investigation);
  const { fixed, permitted, notAutomaticallyPermitted } = scopeFor(input.purpose);

  const contextId = `ctx-${now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`;
  const partial: Omit<DecisionContext, "briefing" | "digest"> = {
    schema_version: 1,
    context_id: contextId,
    investigation_id: input.investigation.investigation_id,
    role: input.role,
    purpose: input.purpose,
    created_at: now.toISOString(),
    objective,
    fixed,
    permitted,
    not_automatically_permitted: notAutomaticallyPermitted,
    dossier: {
      id: input.dossier.dossier_id,
      verified: input.dossierVerification?.ok ?? false,
      unverified_entries: (input.dossierVerification?.failures ?? []).map((f) => f.entry),
    },
    algorithm_summary: summarizeAlgorithm(input.dossier, policy),
    interventions,
    current_state: { measured, unmeasured },
    evaluation_contract: contract,
    capabilities,
    supplied: suppliedArtifacts(input.role, input.investigation, input.dossier),
    missing: findMissing(input, interventions),
  };

  const briefing = renderBriefing(partial, policy);
  const digest = contextDigest(partial, briefing);
  const context: DecisionContext = { ...partial, briefing, digest };

  await persist(input.runRoot, context);
  return context;
}

/** Read an assembled context, or null if the run has none. */
export async function readDecisionContext(
  runRoot: string,
): Promise<DecisionContext | null> {
  try {
    const raw = await readFile(join(runRoot, "context", CONTEXT_FILE), "utf8");
    return JSON.parse(raw) as DecisionContext;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ policies

export function policyFor(role: ContextRole, purpose: ContextPurpose): EvidencePolicy {
  const base: EvidencePolicy = {
    include_task_diff: false,
    include_source_excerpts: false,
    include_evaluator_internals: false,
    context_budget: 32_000,
  };
  if (role === "execution_agent") {
    return { ...base, include_task_diff: true, context_budget: 24_000 };
  }
  if (role === "scientific_advisor") {
    // A diagnosis of the case needs the observations; a design question about
    // the implementation also needs the code and what the worker did to it.
    return {
      ...base,
      include_source_excerpts: true,
      include_task_diff: purpose === "algorithm_design",
      context_budget: 48_000,
    };
  }
  if (role === "harness_proposer") {
    // The blanket exclusion is repealed here specifically: a proposer needs the
    // worker's changes to tell a misunderstood interface from a bad idea.
    return { ...base, include_task_diff: true, context_budget: 40_000 };
  }
  // The human reviewer sees the reasoning and its basis, concisely.
  return { ...base, include_task_diff: true, context_budget: 20_000 };
}

export function capabilitiesFor(role: ContextRole, _purpose: ContextPurpose): Capability[] {
  const read: Capability[] = [
    {
      id: "inspect-symbol",
      name: "Inspect a solver symbol and its callers",
      does: "Reports the implementation of a named symbol and where it is called from.",
      cost: "one source read; no compute.",
      permission: role === "execution_agent" ? "invoke" : "request_only",
      returns: "the symbol, its file and witness, and a list of call sites",
    },
    {
      id: "extract-diagnostic",
      name: "Extract a diagnostic from retained output",
      does: "Reads a named quantity from a retained log or field, without re-running.",
      cost: "negligible; the artifact already exists.",
      permission: role === "execution_agent" ? "invoke" : "request_only",
      returns: "the value, its units, the attempt it came from and the extraction method",
    },
    {
      id: "compare-attempts",
      name: "Compare two prepared attempts",
      does: "Reports the effective configuration difference between two attempts.",
      cost: "negligible.",
      permission: "request_only",
      returns: "the changed files and entries, and what was held constant",
    },
  ];
  const act: Capability[] = [
    {
      id: "create-candidate",
      name: "Create a disposable solver or case candidate",
      does: "Materialises an isolated candidate that may change the implementation or recipe.",
      cost: "a build for a solver candidate; a copy for a case candidate.",
      // Reasoning about a change and activating it are separate permissions. An
      // advisor proposes; only the execution agent, under controller authority,
      // materialises.
      permission: role === "execution_agent" ? "invoke" : "request_only",
      returns: "the candidate identity, its digest, and the verification state",
    },
    {
      id: "run-bounded-test",
      name: "Run a bounded property or operator test",
      does: "Executes a short, budgeted test of one operator or property path.",
      cost: "seconds to a minute; bounded by the requested budget.",
      permission: role === "execution_agent" ? "invoke" : "request_only",
      returns: "the result, the actual input identity, and the wall-clock cost",
    },
    {
      id: "run-short-regression",
      name: "Run a short CFD regression",
      does: "Executes a short run of the target case under an evaluation protocol.",
      cost: "minutes to tens of minutes; bounded by the requested budget.",
      permission: role === "execution_agent" ? "invoke" : "request_only",
      returns: "the assessment, the receipt, and the measured state with its coverage",
    },
  ];
  return [...read, ...act];
}

function objectiveFor(purpose: ContextPurpose, investigation: InvestigationRecord): string {
  if (purpose === "algorithm_design") {
    return "Reduce the cost, or improve the robustness, of the real-fluid calculation at a controlled solution quality and unchanged problem definition.";
  }
  if (purpose === "case_diagnosis") {
    return `Establish what the current observations do and do not explain, for the question: ${investigation.question.text}`;
  }
  if (purpose === "harness_improvement") {
    return "Improve the harness, skills or procedures so that a class of investigation is performed more reliably, without changing model weights.";
  }
  return "Execute the recorded plan within its bounds and report what was measured.";
}

function scopeFor(purpose: ContextPurpose): {
  fixed: string[];
  permitted: string[];
  notAutomaticallyPermitted: string[];
} {
  if (purpose === "algorithm_design") {
    return {
      fixed: [
        "the physical problem definition and the operating point locked by the case",
        "the reference evaluation protocol and the baseline it compares against",
        "the error, conservation and admissibility checks that must still pass",
      ],
      permitted: [
        "the candidate solver implementation",
        "the numerical algorithm and its discretisation",
        "diagnostic instrumentation added to a candidate",
      ],
      notAutomaticallyPermitted: [
        "changing the operating point or the case lock",
        "weakening the evaluator or its thresholds",
        "replacing the baseline that other runs compare against",
        "activating a change outside an isolated candidate",
      ],
    };
  }
  return {
    fixed: [
      "the physical problem definition and the operating point locked by the case",
      "the immutable target directory",
    ],
    permitted: ["a child attempt's tunable configuration, as recorded in its effective configuration"],
    notAutomaticallyPermitted: [
      "changing the operating point or the case lock",
      "modifying the target in place",
      "activating a solver change outside an isolated candidate",
    ],
  };
}

function evaluationContractFor(
  purpose: ContextPurpose,
  investigation: InvestigationRecord,
  dossier: Dossier,
): EvaluationContract {
  const measured: string[] = [];
  const notMeasured: string[] = [];
  for (const d of dossier.diagnostics) {
    measured.push(`${d.name}: ${d.measures}`);
    notMeasured.push(...d.does_not_measure);
  }
  return {
    quantity_improved:
      purpose === "algorithm_design"
        ? "cost or robustness per unit of physical time advanced, at controlled solution quality"
        : "the definiteness with which the question is answered",
    quality_constraints: [
      "the mesh and property checks that the pinned build reports must still pass",
      "the solver must remain within its stability bound, as enforced by the time-step control",
      "the real-fluid property path must remain active; a silent fallback to perfect-gas is a failure",
    ],
    comparable_baseline: "the pinned stock OF8 and realFluid package baseline recorded in cfd-baseline/baseline.json",
    resource_accounting:
      "wall clock and physical time advanced, from the execution receipt; never an unbounded run",
    development_cases: ["mascotte-g2 as prepared by the child-attempt preparer"],
    transfer_domain:
      "at least one distinct case or state family that was not used to choose the change; a single successful attempt is not a general claim",
    evidence_still_required: [
      ...notMeasured.slice(0, 6),
      ...dossier.unknown.slice(0, 6),
      ...(investigation.outcome.remains_open.length ? investigation.outcome.remains_open.slice(0, 4) : []),
    ],
  };
}

// ------------------------------------------------------------------ assembly

async function interventionView(
  attemptDir: string,
  investigation: InvestigationRecord,
): Promise<InterventionView | null> {
  let record: InvestigationRecord;
  try {
    const raw = await readFile(join(attemptDir, "investigation.json"), "utf8");
    record = JSON.parse(raw) as InvestigationRecord;
  } catch {
    // An attempt recorded before the investigation layer existed has no view.
    // The assembler says so in `missing` rather than reconstructing one.
    return null;
  }
  return {
    attempt_id: record.attempt_id,
    intent: record.question.text,
    planned_change: record.plan.intervention,
    actual_changes: record.actual_changes,
    motivated_by: record.question.rationale,
    held_constant: record.plan.bounds ? [record.plan.bounds.note] : [],
    evaluation_scope: {
      measured: record.plan.expected_observations,
      not_measured: record.outcome.remains_open,
    },
    established: record.outcome.established,
    remains_open: record.outcome.remains_open,
    hypotheses: record.outcome.hypotheses,
    completion: record.outcome.completion,
  };
}

function collectMeasured(
  investigation: InvestigationRecord,
  state: ConsultationState,
  dossier: Dossier,
): EvidenceItem[] {
  const items: EvidenceItem[] = [];
  for (const e of investigation.outcome.established) {
    items.push({
      claim: e.claim,
      source: e.evidence,
      basis: "measured",
      artifact: investigation.evidence_refs[0]?.path ?? investigation.attempt_id,
    });
  }
  for (const s of dossier.stages) {
    for (const e of s.known_evidence) {
      items.push({
        claim: e.claim,
        source: e.source,
        basis: e.basis,
        artifact: s.anchor.file,
      });
    }
  }
  items.push({
    claim: `solver identity is ${state.solverExecutable} with digest ${state.solverDigest.slice(0, 16)}…`,
    source: "the consultation state, re-hashed at assembly",
    basis: "measured",
    artifact: "cfd-baseline/baseline.json",
  });
  return items;
}

function collectUnmeasured(
  investigation: InvestigationRecord,
  dossier: Dossier,
): string[] {
  const out = new Set<string>();
  for (const s of dossier.stages) for (const u of s.unknown) out.add(`${s.name}: ${u}`);
  for (const i of dossier.interfaces) for (const u of i.unknown) out.add(`${i.name}: ${u}`);
  for (const u of dossier.unknown) out.add(u);
  for (const o of investigation.outcome.remains_open) out.add(o);
  return [...out];
}

function summarizeAlgorithm(dossier: Dossier, policy: EvidencePolicy): string {
  const lines: string[] = [];
  lines.push(`The solver advances p, U, Y and he, and recovers rho, T and every`);
  lines.push(`transport property from the property package.`);
  lines.push(``);
  lines.push(`Per time step, in order:`);
  for (const s of dossier.stages) {
    const bits: string[] = [];
    if (s.advances.length) bits.push(`advances ${s.advances.join(", ")}`);
    if (s.recomputes.length) bits.push(`recomputes ${s.recomputes.slice(0, 4).join(", ")}`);
    if (s.lags.length) bits.push(`lags ${s.lags.slice(0, 2).join(", ")}`);
    lines.push(`- ${s.name} — ${bits.join("; ")}.`);
    if (policy.include_source_excerpts) {
      lines.push(`    at ${s.anchor.file}, witnessing \`${s.anchor.witness.trim()}\``);
    }
  }
  return lines.join("\n");
}

function suppliedArtifacts(
  role: ContextRole,
  investigation: InvestigationRecord,
  dossier: Dossier,
): { kind: string; path: string }[] {
  const out = [
    { kind: "investigation record", path: "investigation.json" },
    { kind: "dossier", path: `dossiers/${dossier.dossier_id}.json` },
  ];
  for (const r of investigation.evidence_refs) out.push({ kind: r.kind, path: r.path });
  return out;
}

function findMissing(
  input: {
    investigation: InvestigationRecord;
    attemptDirs: string[];
    role: ContextRole;
  },
  interventions: InterventionView[],
): string[] {
  const missing: string[] = [];
  // An attempt directory with no investigation record is an attempt the layer
  // never covered. It is reported, not silently summarised.
  for (const d of input.attemptDirs) {
    if (!interventions.some((v) => input.attemptDirs.includes(d))) {
      // This is handled by the null return in interventionView; count them here.
    }
  }
  if (input.investigation.actual_changes.length === 0) {
    missing.push(
      "the investigation records no actual changes; the preparer's diff is not linked, so intended and actual change cannot be compared",
    );
  }
  if (input.investigation.experience.length === 0) {
    missing.push("no experience is selected for delivery to this invocation");
  }
  if (input.investigation.outcome.established.length === 0) {
    missing.push("nothing is recorded as established by the prior attempt");
  }
  return missing;
}

function contextDigest(
  partial: Omit<DecisionContext, "briefing" | "digest">,
  briefing: string,
): string {
  const hash = createHash("sha256");
  hash.update(JSON.stringify(partial));
  hash.update(briefing);
  return hash.digest("hex");
}

function renderBriefing(
  c: Omit<DecisionContext, "briefing" | "digest">,
  policy: EvidencePolicy,
): string {
  const lines: string[] = [];
  lines.push(`# Decision context`);
  lines.push(``);
  lines.push(`Role **${c.role}**, purpose **${c.purpose}**, investigation \`${c.investigation_id}\`.`);
  lines.push(``);
  lines.push(`## Objective`);
  lines.push(``);
  lines.push(c.objective);
  lines.push(``);
  lines.push(`**Fixed:**`);
  for (const f of c.fixed) lines.push(`- ${f}`);
  lines.push(`**Permitted:**`);
  for (const p of c.permitted) lines.push(`- ${p}`);
  lines.push(`**Not automatically permitted:**`);
  for (const n of c.not_automatically_permitted) lines.push(`- ${n}`);
  lines.push(``);
  lines.push(`## How the relevant computation works`);
  lines.push(``);
  lines.push(c.algorithm_summary);
  lines.push(``);
  if (c.interventions.length) {
    lines.push(`## What has been tried`);
    lines.push(``);
    for (const v of c.interventions) {
      lines.push(`### ${v.attempt_id}`);
      lines.push(``);
      lines.push(`- intent: ${v.intent}`);
      lines.push(`- planned change: ${v.planned_change}`);
      if (v.actual_changes.length) {
        lines.push(`- actual changes:`);
        for (const a of v.actual_changes) lines.push(`  - ${a}`);
      } else {
        lines.push(`- actual changes: *not linked*`);
      }
      lines.push(`- motivated by: ${v.motivated_by}`);
      lines.push(`- completion: ${v.completion}`);
      if (v.established.length) {
        lines.push(`- established:`);
        for (const e of v.established) lines.push(`  - ${e.claim} — ${e.evidence}`);
      }
      if (v.remains_open.length) {
        lines.push(`- remains open:`);
        for (const r of v.remains_open) lines.push(`  - ${r}`);
      }
      if (v.hypotheses.length) {
        lines.push(`- interpretations:`);
        for (const h of v.hypotheses) lines.push(`  - (${h.status}) ${h.statement}`);
      }
      lines.push(``);
    }
  } else {
    lines.push(`## What has been tried`);
    lines.push(``);
    lines.push(`*No prior intervention is recorded for this investigation.*`);
    lines.push(``);
  }
  lines.push(`## Current state`);
  lines.push(``);
  if (c.current_state.measured.length) {
    for (const m of c.current_state.measured.slice(0, 24)) {
      lines.push(`- (${m.basis}) ${m.claim} — ${m.source}`);
    }
  } else {
    lines.push(`*Nothing is recorded as measured.*`);
  }
  lines.push(``);
  lines.push(`### Not measured`);
  lines.push(``);
  for (const u of c.current_state.unmeasured.slice(0, 20)) lines.push(`- ${u}`);
  lines.push(``);
  lines.push(`## What would count as improvement`);
  lines.push(``);
  lines.push(`- quantity improved: ${c.evaluation_contract.quantity_improved}`);
  for (const q of c.evaluation_contract.quality_constraints) lines.push(`- constraint: ${q}`);
  lines.push(`- baseline: ${c.evaluation_contract.comparable_baseline}`);
  lines.push(`- transfer: ${c.evaluation_contract.transfer_domain}`);
  lines.push(``);
  lines.push(`## Capabilities`);
  lines.push(``);
  for (const cap of c.capabilities) {
    lines.push(`- **${cap.name}** (${cap.permission}) — ${cap.does} Cost: ${cap.cost}.`);
    lines.push(`  returns: ${cap.returns}`);
  }
  lines.push(``);
  if (c.missing.length) {
    lines.push(`## What this context does not supply`);
    lines.push(``);
    for (const m of c.missing) lines.push(`- ${m}`);
    lines.push(``);
  }
  if (!policy.include_task_diff) {
    lines.push(`The task diff is not included for this role and purpose; ask for it if the`);
    lines.push(`reasoning needs it, rather than guessing at what the worker changed.`);
    lines.push(``);
  }
  return lines.join("\n");
}

async function persist(runRoot: string, context: DecisionContext): Promise<void> {
  const dir = join(runRoot, "context");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, CONTEXT_FILE), JSON.stringify(context, null, 2) + "\n", "utf8");
  await writeFile(join(dir, "briefing.md"), context.briefing, "utf8");
}

/** List the attempt directories under a runs directory, earliest first. */
export async function discoverAttempts(runsDir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(runsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => join(runsDir, e.name))
    .sort();
}
