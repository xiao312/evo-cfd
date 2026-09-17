/**
 * Record the investigation layer for a completed attempt.
 *
 * Usage:
 *   node scripts/record-investigation.ts <attempt-dir> \
 *     --question-file Q.md --plan-file P.md --outcome-file O.md \
 *     [--experience-file E.md]
 *
 * The prose is supplied as markdown so the human argument is authored by a
 * person and the record binds it; this script does not compose the argument
 * itself. Each file is a small markdown document whose headings the record
 * reads, so the readable artefact and the structured record are one document.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { argv, exit } from "node:process";

import {
  writeInvestigation,
  type InvestigationRecord,
  type InvestigationQuestion,
  type InvestigationPlan,
  type InvestigationOutcome,
  type SelectedExperience,
} from "../packages/controller/src/investigation.ts";

function arg(name: string): string | undefined {
  const i = argv.indexOf(name);
  return i > -1 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

function section(text: string, heading: string): string {
  const re = new RegExp(`^#{1,3}\\s*${heading}\\s*$`, "mi");
  const m = re.exec(text);
  if (!m) return "";
  const rest = text.slice(m.index + m[0].length);
  const next = /\n#{1,3}\s/.exec(rest);
  return (next ? rest.slice(0, next.index) : rest).trim();
}

function bullets(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("- ") || l.startsWith("* "))
    .map((l) => l.slice(2).trim())
    .filter(Boolean);
}

async function load(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    console.error(`cannot read ${path}: ${(err as Error).message}`);
    exit(1);
  }
}

async function main(): Promise<void> {
  const attemptDir = argv[2];
  const qFile = arg("--question-file");
  const pFile = arg("--plan-file");
  const oFile = arg("--outcome-file");
  if (!attemptDir || !qFile || !pFile || !oFile) {
    console.error(
      "usage: record-investigation.ts <attempt-dir> --question-file Q.md --plan-file P.md --outcome-file O.md [--experience-file E.md]",
    );
    exit(2);
  }

  const q = await load(qFile);
  const p = await load(pFile);
  const o = await load(oFile);

  let attempt: { attempt_id: string; prepared_attempt?: { digest: string } };
  try {
    attempt = JSON.parse(await readFile(join(attemptDir, "attempt-record.json"), "utf8"));
  } catch (err) {
    console.error(`no readable attempt-record.json at ${attemptDir}: ${(err as Error).message}`);
    exit(1);
  }

  const question: InvestigationQuestion = {
    text: section(q, "Question") || section(q, "question"),
    rationale: section(q, "Why now") || section(q, "Rationale"),
    prior_evidence: bullets(section(q, "Prior evidence") || ""),
    answerable_if: section(q, "Answerable if"),
    falsified_if: section(q, "Falsified if"),
  };

  const plan: InvestigationPlan = {
    intervention: section(p, "Intervention"),
    expected_observations: bullets(section(p, "Expected observations") || ""),
    evaluation_method: section(p, "Evaluation method"),
    bounds: {
      budget_seconds: Number(section(p, "Budget seconds") || "0"),
      requested_end_time: Number(section(p, "Requested end time") || "0"),
      note: section(p, "Bounds note") || "",
    },
  };

  const completionText = (section(o, "Completion") || "cut_short").trim();
  const completion: InvestigationOutcome["completion"] = [
    "completed",
    "cut_short",
    "failed",
  ].includes(completionText)
    ? (completionText as InvestigationOutcome["completion"])
    : "cut_short";

  const outcome: InvestigationOutcome = {
    established: bullets(section(o, "Established") || "").map((line) => {
      const sep = line.indexOf("|");
      return sep > -1
        ? { claim: line.slice(0, sep).trim(), evidence: line.slice(sep + 1).trim() }
        : { claim: line, evidence: "" };
    }),
    remains_open: bullets(section(o, "Remains open") || ""),
    hypotheses: bullets(section(o, "Hypotheses") || "").map((line) => {
      const sep = line.indexOf("|");
      const status = (sep > -1 ? line.slice(sep + 1).trim() : "untested") as
        | "untested"
        | "supported"
        | "withdrawn";
      return {
        statement: sep > -1 ? line.slice(0, sep).trim() : line,
        status: ["untested", "supported", "withdrawn"].includes(status)
          ? status
          : "untested",
      };
    }),
    completion,
    completion_detail: section(o, "Completion detail") || "",
  };

  let experience: SelectedExperience[] = [];
  const eFile = arg("--experience-file");
  if (eFile) {
    const e = await load(eFile);
    experience = bullets(section(e, "Experience") || "").map((line) => {
      const parts = line.split("|").map((s) => s.trim());
      return {
        lesson: parts[0] ?? "",
        drawn_from: parts[1] ?? "",
        affects_next_question: parts[2] ?? "",
      };
    });
  }

  const record: InvestigationRecord = {
    schema_version: 1,
    investigation_id: attempt.attempt_id,
    attempt_id: attempt.attempt_id,
    prepared_attempt_digest: attempt.prepared_attempt?.digest ?? "(not recorded)",
    question,
    plan,
    actual_changes: [],
    outcome,
    experience,
    evidence_refs: [
      { kind: "attempt record", path: "attempt-record.json" },
      { kind: "receipt", path: "execution-receipt.txt" },
      { kind: "solver log", path: "log.realFluidReactingFoam" },
    ],
    created_at: new Date().toISOString(),
  };

  try {
    await writeInvestigation(attemptDir, record);
  } catch (err) {
    console.error((err as Error).message);
    exit(1);
  }
  console.log(`ok investigation recorded for ${record.investigation_id} at ${attemptDir}`);
  console.log(`   established ${outcome.established.length}, open ${outcome.remains_open.length}, experience ${experience.length}`);
}

await main();
