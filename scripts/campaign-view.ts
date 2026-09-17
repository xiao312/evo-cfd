/**
 * The campaign view.
 *
 * Generated entirely from investigation and attempt records, so what a human
 * sees and what the system recorded cannot drift apart. For each attempt it
 * shows the question asked, what the plan expected, what actually changed, what
 * the evidence established, what remains open, and which experience was
 * selected to govern the next decision.
 *
 * Read-only. It never mutates a record, and it never decides anything: a
 * campaign view that could also act would be a second path to the same outcome
 * with weaker evidence.
 *
 * Usage: node scripts/campaign-view.ts <runs-root>
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { argv, exit } from "node:process";

import { campaignRow, readInvestigation } from "../packages/controller/src/investigation.ts";

interface AttemptSummary {
  attempt_id: string;
  prepared_attempt?: { digest: string };
  required_case_adaptation: string[];
  other_changes: string[];
}

async function readAttempt(dir: string): Promise<AttemptSummary | null> {
  try {
    const raw = await readFile(join(dir, "attempt-record.json"), "utf8");
    return JSON.parse(raw) as AttemptSummary;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
}

function line(ch: string, n = 78): string {
  return ch.repeat(n);
}

async function main(): Promise<void> {
  const runsRoot = argv[2];
  if (!runsRoot) {
    console.error("usage: campaign-view.ts <runs-root>");
    exit(2);
  }

  let entries: string[];
  try {
    entries = await readdir(runsRoot);
  } catch (err) {
    console.error(`cannot read ${runsRoot}: ${(err as Error).message}`);
    exit(1);
  }

  const rows = [];
  for (const name of entries.sort()) {
    const dir = join(runsRoot, name);
    const attempt = await readAttempt(dir);
    if (!attempt) continue;
    rows.push({ name, dir, row: await campaignRow(dir, attempt) });
  }

  if (rows.length === 0) {
    console.log(`no attempts with a readable record under ${runsRoot}`);
    return;
  }

  console.log(line("="));
  console.log(`Campaign view: ${runsRoot}`);
  console.log(`${rows.length} attempt(s), generated from their own records`);
  console.log(line("="));
  console.log();

  for (const { name, row } of rows) {
    console.log(line("-"));
    console.log(`${row.investigation_id === "none" ? "[no question recorded]" : row.investigation_id}  ${name}`);
    console.log(line("-"));
    console.log(`status      ${row.status}`);
    console.log(`question    ${row.question}`);
    console.log(`intended    ${row.intervention}`);
    console.log(`digest      ${row.prepared_attempt_digest ?? "(not recorded)"}`);
    console.log();
    console.log("planned observations:");
    for (const o of row.planned_observations) console.log(`  + ${o}`);
    if (row.planned_observations.length === 0) console.log("  (none recorded)");
    console.log("actual changes:");
    for (const c of row.actual_changes) console.log(`  ~ ${c}`);
    if (row.actual_changes.length === 0) console.log("  (none recorded)");
    console.log();
    console.log(`completion  ${row.completion}`);
    console.log("established:");
    for (const e of row.established) console.log(`  = ${e}`);
    if (row.established.length === 0) console.log("  (nothing established)");
    console.log("remains open:");
    for (const o of row.remains_open) console.log(`  ? ${o}`);
    if (row.remains_open.length === 0) console.log("  (nothing open)");
    console.log("experience carried forward:");
    for (const e of row.experience) console.log(`  > ${e}`);
    if (row.experience.length === 0) console.log("  (none selected)");
    console.log();
  }

  // A closing summary of what the campaign has established and what it has not,
  // because a view that lists attempts without saying what they add is a log.
  const established = rows.flatMap((r) => r.row.established);
  const open = rows.flatMap((r) => r.row.remains_open);
  const lessons = rows.flatMap((r) => r.row.experience);
  const unrecorded = rows.filter((r) => r.row.investigation_id === "none").length;

  console.log(line("="));
  console.log("Summary");
  console.log(line("="));
  console.log(`established : ${established.length}`);
  for (const e of established) console.log(`  = ${e}`);
  console.log(`open        : ${open.length}`);
  for (const o of open.slice(0, 6)) console.log(`  ? ${o}`);
  if (open.length > 6) console.log(`  ? ... and ${open.length - 6} more`);
  console.log(`experience  : ${lessons.length}`);
  for (const l of lessons.slice(0, 6)) console.log(`  > ${l}`);
  if (lessons.length > 6) console.log(`  > ... and ${lessons.length - 6} more`);
  if (unrecorded > 0) {
    console.log();
    console.log(`${unrecorded} attempt(s) predate the investigation layer and carry no recorded question.`);
  }
}

await main();
