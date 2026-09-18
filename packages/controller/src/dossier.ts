/**
 * The solver dossier: a versioned, anchor-verified map of the algorithm.
 *
 * Why this exists. A directory of source files is not an understanding of the
 * computation. A model asked to improve a solver needs to know which variables
 * are advanced and which recovered, which quantities are lagged between
 * updates, where properties are recomputed, which terms are explicit or
 * implicit, and where clipping or fallback can occur. That is a *map of the
 * algorithm*, and it has to be derived from the code rather than maintained as
 * an independent story -- otherwise it silently diverges from what actually
 * runs, and a model reasoning from the dossier is reasoning about a solver that
 * no longer exists.
 *
 * So the dossier is anchored. Every entry names a source file and a *witness*:
 * a fragment of text that must appear in that file. Verification resolves each
 * anchor against the pinned source root and fails if the witness has drifted.
 * A line number is recorded too, for opening the file, but the witness is what
 * is checked, because a line number alone breaks on any edit while a witness
 * survives reformatting and still identifies the stage.
 *
 * The dossier is deliberately partial. It covers the active solver loop and the
 * operators relevant to the current question, not all of OpenFOAM. An entry that
 * cannot be anchored is not written; an entry whose evidence is missing says so
 * in `unknown` rather than being filled with a plausible inference. Unmeasured
 * information stays unmeasured -- an inferred hotspot is not presented as a
 * profile result.
 */

import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

export const DOSSIER_SCHEMA_VERSION = 1;

/** A location in the pinned source that can be opened and checked. */
export interface SourceAnchor {
  /** Path relative to the dossier's `source_root`. */
  file: string;
  /** Text that must appear in the file. This is what is verified. */
  witness: string;
  /** Line of the witness, recorded for opening. Verified loosely if at all. */
  line?: number;
  /** The symbol or include the anchor names, for retrieval and indexing. */
  symbol?: string;
}

/**
 * A stage of the update / outer-iteration loop.
 *
 * The fields are the ones a model needs to form a mechanism-level hypothesis:
 * not "this file exists" but what the stage advances, what it holds from an
 * earlier update, and which property computations it triggers.
 */
export interface StageEntry {
  id: string;
  name: string;
  role: string;
  anchor: SourceAnchor;
  /** Variables this stage advances. */
  advances: string[];
  /** Quantities held at an earlier value during this stage, and why. */
  lags: string[];
  /** Terms treated implicitly. */
  implicit_terms: string[];
  /** Terms treated explicitly. */
  explicit_terms: string[];
  /** Properties recomputed by or for this stage. */
  recomputes: string[];
  /** How convergence is checked, if it is. */
  convergence_check: string | null;
  /** Where clipping, limiting or a fallback can occur, if anywhere. */
  clipping_or_fallback: string | null;
  /** Downstream stages that consume this stage's output. */
  used_by: string[];
  /** Evidence tied to this stage, with the record it came from. */
  known_evidence: EvidenceLink[];
  /** What is not known about this stage. Explicit, never inferred. */
  unknown: string[];
}

/** A thermodynamic, transport or chemistry interface the solver calls into. */
export interface InterfaceEntry {
  id: string;
  name: string;
  role: string;
  anchor: SourceAnchor;
  inputs: string[];
  outputs: string[];
  used_by: string[];
  known_evidence: EvidenceLink[];
  unknown: string[];
}

/** A diagnostic or regression check that can be run and read. */
export interface DiagnosticEntry {
  id: string;
  name: string;
  /** What it measures, and what it does not measure. */
  measures: string;
  does_not_measure: string[];
  /** How to obtain it. */
  how: string;
  anchor?: SourceAnchor;
  known_evidence: EvidenceLink[];
}

/** A link from a dossier claim to the recorded evidence behind it. */
export interface EvidenceLink {
  /** The claim this evidence supports. */
  claim: string;
  /** Where the evidence is: a run id, a bundle, or a document path. */
  source: string;
  /**
   * Whether the claim was measured, inferred from a log, or asserted by an
   * advisor. The distinction is load-bearing: an inference is challengeable in
   * a way a measurement is not.
   */
  basis: "measured" | "inferred" | "advisor_proposal" | "operator_directive";
}

/** The dossier itself. */
export interface Dossier {
  schema_version: typeof DOSSIER_SCHEMA_VERSION;
  dossier_id: string;
  /** The solver profile this dossier describes, as recorded in the baseline. */
  solver_profile_id: string;
  /** The pinned package the anchors resolve against. */
  source_package: string;
  /** Digest of the pinned source, as recorded in the baseline. */
  source_digest: string;
  generated_at: string;
  /** What the solver advances and what it recovers from state. */
  primary_variables: { name: string; advanced: boolean; recovered_from: string }[];
  stages: StageEntry[];
  interfaces: InterfaceEntry[];
  diagnostics: DiagnosticEntry[];
  /** What the whole solver's evidence does not cover. */
  unknown: string[];
}

/** The result of verifying a dossier against a source root. */
export interface DossierVerification {
  ok: boolean;
  /** Anchors that failed, with the reason a model or operator can act on. */
  failures: { entry: string; file: string; reason: string }[];
  /** Anchors that resolved. */
  checked: number;
}

export class DossierError extends Error {
  readonly code = "EDOSSIER";
}

/**
 * Verify every anchor in a dossier against a source root.
 *
 * The source root is the *pinned* package the dossier was written against. A
 * failure means the dossier and the code have diverged, which is a defect in
 * the dossier rather than in the solver: the fix is to re-derive the entry, not
 * to relax the check.
 */
export async function verifyDossier(
  dossier: Dossier,
  sourceRoot: string,
): Promise<DossierVerification> {
  const failures: DossierVerification["failures"] = [];
  let checked = 0;

  const anchors: { entry: string; anchor: SourceAnchor }[] = [];
  for (const s of dossier.stages) anchors.push({ entry: `stage:${s.id}`, anchor: s.anchor });
  for (const i of dossier.interfaces) anchors.push({ entry: `interface:${i.id}`, anchor: i.anchor });
  for (const d of dossier.diagnostics) {
    if (d.anchor) anchors.push({ entry: `diagnostic:${d.id}`, anchor: d.anchor });
  }

  for (const { entry, anchor } of anchors) {
    checked++;
    const path = join(sourceRoot, anchor.file);
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (e) {
      failures.push({
        entry,
        file: anchor.file,
        reason:
          (e as NodeJS.ErrnoException).code === "ENOENT"
            ? "the anchored file is absent from the pinned source"
            : `the anchored file cannot be read: ${(e as Error).message}`,
      });
      continue;
    }
    // Witnesses are compared over LF-normalised text, so a file checked out on a
    // CRLF host verifies the same as on the build host.
    if (!raw.replace(/\r\n/g, "\n").includes(anchor.witness)) {
      failures.push({
        entry,
        file: anchor.file,
        reason:
          "the witness text is absent; the code has drifted from the dossier entry, re-derive it",
      });
    }
  }

  return { ok: failures.length === 0, failures, checked };
}

/** Read a dossier from a JSON file, refusing anything that is not one. */
export async function readDossier(path: string): Promise<Dossier> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    throw new DossierError(`no dossier at ${path}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new DossierError(`the dossier at ${path} is not valid JSON`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new DossierError(`the dossier at ${path} is not an object`);
  }
  const d = parsed as Partial<Dossier>;
  if (d.schema_version !== DOSSIER_SCHEMA_VERSION) {
    throw new DossierError(
      `the dossier at ${path} has schema version ${String(d.schema_version)}, expected ${DOSSIER_SCHEMA_VERSION}`,
    );
  }
  if (!Array.isArray(d.stages) || !Array.isArray(d.interfaces)) {
    throw new DossierError(`the dossier at ${path} has no stages or interfaces`);
  }
  if (!d.source_package || !d.source_digest) {
    throw new DossierError(
      `the dossier at ${path} is not bound to a pinned source package and digest`,
    );
  }
  return d as Dossier;
}

/**
 * Render a dossier as a compact briefing a model can read and challenge.
 *
 * This is the "algorithm map" as prose-with-anchors: each stage states what it
 * does, what it holds, and where it lives, so a model can open the
 * implementation and check the claim. Explicit unknowns are listed rather than
 * smoothed over, because a gap the model can see is a gap it can ask about.
 */
export function renderDossierBriefing(dossier: Dossier): string {
  const lines: string[] = [];
  lines.push(`# Solver dossier: ${dossier.dossier_id}`);
  lines.push(``);
  lines.push(`Describes solver profile \`${dossier.solver_profile_id}\`, pinned to package`);
  lines.push(`\`${dossier.source_package}\` (source digest ${dossier.source_digest.slice(0, 16)}…).`);
  lines.push(`Every entry names a file and a witness fragment so the claim can be checked`);
  lines.push(`against the code it describes.`);
  lines.push(``);
  lines.push(`## Variables`);
  for (const v of dossier.primary_variables) {
    lines.push(
      `- **${v.name}** — ${v.advanced ? "advanced by the solver" : `recovered from ${v.recovered_from}`}`,
    );
  }
  lines.push(``);
  lines.push(`## Update and iteration order`);
  for (const s of dossier.stages) {
    lines.push(`### ${s.name}`);
    lines.push(``);
    lines.push(`${s.role}`);
    lines.push(``);
    lines.push(`- implementation: \`${s.anchor.file}\` witnessing \`${s.anchor.witness.trim()}\``);
    if (s.advances.length) lines.push(`- advances: ${s.advances.join(", ")}`);
    if (s.lags.length) lines.push(`- lagged here: ${s.lags.join(", ")}`);
    if (s.implicit_terms.length) lines.push(`- implicit: ${s.implicit_terms.join(", ")}`);
    if (s.explicit_terms.length) lines.push(`- explicit: ${s.explicit_terms.join(", ")}`);
    if (s.recomputes.length) lines.push(`- recomputes: ${s.recomputes.join(", ")}`);
    if (s.convergence_check) lines.push(`- convergence: ${s.convergence_check}`);
    if (s.clipping_or_fallback) lines.push(`- clipping/fallback: ${s.clipping_or_fallback}`);
    if (s.used_by.length) lines.push(`- used by: ${s.used_by.join(", ")}`);
    if (s.known_evidence.length) {
      lines.push(`- evidence:`);
      for (const e of s.known_evidence) {
        lines.push(`  - (${e.basis}) ${e.claim} — ${e.source}`);
      }
    }
    if (s.unknown.length) {
      lines.push(`- not known:`);
      for (const u of s.unknown) lines.push(`  - ${u}`);
    }
    lines.push(``);
  }
  if (dossier.interfaces.length) {
    lines.push(`## Property, transport and chemistry interfaces`);
    for (const i of dossier.interfaces) {
      lines.push(`### ${i.name}`);
      lines.push(``);
      lines.push(`${i.role}`);
      lines.push(``);
      lines.push(`- implementation: \`${i.anchor.file}\` witnessing \`${i.anchor.witness.trim()}\``);
      if (i.inputs.length) lines.push(`- inputs: ${i.inputs.join(", ")}`);
      if (i.outputs.length) lines.push(`- outputs: ${i.outputs.join(", ")}`);
      if (i.used_by.length) lines.push(`- used by: ${i.used_by.join(", ")}`);
      if (i.unknown.length) {
        lines.push(`- not known:`);
        for (const u of i.unknown) lines.push(`  - ${u}`);
      }
      lines.push(``);
    }
  }
  if (diagnosticsListed(dossier)) {
    lines.push(`## Diagnostics`);
    for (const d of dossier.diagnostics) {
      lines.push(`- **${d.name}** — ${d.measures}`);
      if (d.does_not_measure.length) {
        lines.push(`  - does not measure: ${d.does_not_measure.join(", ")}`);
      }
      lines.push(`  - how: ${d.how}`);
    }
    lines.push(``);
  }
  if (dossier.unknown.length) {
    lines.push(`## What this dossier does not establish`);
    for (const u of dossier.unknown) lines.push(`- ${u}`);
    lines.push(``);
  }
  return lines.join("\n");
}

function diagnosticsListed(dossier: Dossier): boolean {
  return dossier.diagnostics.length > 0;
}

/** Confirm a source root looks like the pinned package, for early failure. */
export async function sourceRootLooksPinned(sourceRoot: string): Promise<boolean> {
  try {
    const s = await stat(sourceRoot);
    return s.isDirectory();
  } catch {
    return false;
  }
}
