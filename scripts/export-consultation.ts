/**
 * Export a frozen consultation request as a package an operator can submit.
 *
 * The transport is deliberately manual and deliberately outside this project:
 * the operator opens their own authenticated web session and pastes the
 * briefing. Nothing here holds a password, a cookie or a session token, and no
 * part of this script reaches the network.
 *
 * What the export produces:
 *
 *   - <export-dir>/QUESTION.md  the briefing, to paste as the prompt
 *   - <export-dir>/request.json the structured request, for an advisor that
 *                               accepts structured input
 *   - <export-dir>/attachments/  the evidence, case inputs and source excerpts
 *                                the briefing refers to
 *   - <export-dir>/identity.txt  the request id and digest, which must come
 *                                back with the answer
 *
 * A tarball is produced alongside, because a web chat takes attachments rather
 * than a directory.
 *
 * Usage: node scripts/export-consultation.ts <run-root> <export-dir>
 */
import { cp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { argv, exit } from "node:process";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

import { activeRequestDir } from "../packages/controller/src/consultation.ts";

async function main(): Promise<void> {
  const runRoot = argv[2];
  const exportDir = argv[3];
  if (!runRoot || !exportDir) {
    console.error("usage: export-consultation.ts <run-root> <export-dir>");
    exit(2);
  }

  const active = await activeRequestDir(runRoot);
  if (!active) {
    console.error(`no consultation request at ${runRoot}; prepare one first`);
    exit(1);
  }

  await rm(exportDir, { recursive: true, force: true });
  await mkdir(exportDir, { recursive: true });

  // The briefing is the prompt. It is already written by the preparer and is
  // copied rather than recomposed, so what the advisor reads is what the digest
  // covers.
  for (const name of ["QUESTION.md", "request.json"]) {
    const from = join(active.dir, name);
    if (existsSync(from)) {
      await cp(from, join(exportDir, name));
    }
  }

  // Attachments, flattened only in the sense that the request package's own
  // structure is preserved verbatim.
  for (const sub of ["evidence", "source-excerpts", "case-inputs"]) {
    const from = join(active.dir, sub);
    if (existsSync(from)) {
      await cp(from, join(exportDir, "attachments", sub), { recursive: true });
    }
  }

  // The identity an answer must declare. This is the part that closes the
  // association gap: the importer refuses an answer that does not carry it.
  await writeFile(
    join(exportDir, "identity.txt"),
    [
      `request_id=${active.requestId}`,
      `request_digest=${active.digest}`,
      `request_revision=${active.revision}`,
      "",
      "An answer to this consultation must declare the request_id and the",
      "request_digest above. Without them the importer cannot verify that the",
      "answer belongs to this request rather than to the request the importer",
      "happens to find active, and it will be refused.",
      "",
    ].join("\n"),
    "utf8",
  );

  const tarball = `${exportDir.endsWith("/") ? exportDir.slice(0, -1) : exportDir}.tar.gz`;
  try {
    execFileSync("tar", ["-czf", tarball, "-C", exportDir, "."], { stdio: "pipe" });
  } catch (err) {
    console.error(`warning: could not build the tarball: ${(err as Error).message}`);
  }

  const manifest = await readFile(join(active.dir, "manifest.json"), "utf8").catch(
    () => "(no manifest)",
  );
  const denied = JSON.parse(manifest === "(no manifest)" ? "{}" : manifest);

  console.log(`ok consultation exported to ${exportDir}`);
  console.log(`   request ${active.requestId}, revision ${active.revision}`);
  console.log(`   digest  ${active.digest}`);
  console.log(`   tarball ${tarball}`);
  console.log("");
  console.log("To submit through an authenticated web session:");
  console.log(`  1. paste ${join(exportDir, "QUESTION.md")}`);
  console.log(`  2. attach ${tarball}, or the files under ${join(exportDir, "attachments")}`);
  console.log("  3. copy the answer back, then import it with the identity above");
  if (denied?.denied_files?.length) {
    console.log("");
    console.log(`   ${denied.denied_files.length} file(s) were denied by the export policy and are not in this package`);
  }
}

await main();
