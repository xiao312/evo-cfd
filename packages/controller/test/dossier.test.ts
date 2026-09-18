/**
 * Dossier tests.
 *
 * The property that matters is that the dossier cannot silently diverge from the
 * code. So the tests verify a dossier against a *synthetic* source tree built
 * from the real witnesses, and then deliberately corrupt one to confirm the
 * verifier reports drift rather than passing.
 *
 * The real dossier is verified against the pinned package on the compute host by
 * a separate script, not here: the pinned source is not present on the editing
 * machine, and a test that cannot reach the source would only test the fixture.
 */
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
const expect = assert;

import {
  verifyDossier,
  readDossier,
  renderDossierBriefing,
  DOSSIER_SCHEMA_VERSION,
  type Dossier,
  type SourceAnchor,
} from "../src/dossier.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "evocfd-dossier-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A minimal dossier with two anchored entries, for the synthetic tests. */
function tinyDossier(): Dossier {
  return {
    schema_version: DOSSIER_SCHEMA_VERSION,
    dossier_id: "tiny",
    solver_profile_id: "p",
    source_package: "pkg @ abc",
    source_digest: "0".repeat(64),
    generated_at: "2026-09-17T00:00:00Z",
    primary_variables: [{ name: "rho", advanced: false, recovered_from: "the equation of state" }],
    stages: [
      {
        id: "a",
        name: "Stage A",
        role: "does a thing",
        anchor: { file: "a.H", witness: "reaction->correct();" },
        advances: ["Y"],
        lags: ["rho"],
        implicit_terms: ["fvm::ddt(rho, Y)"],
        explicit_terms: ["source"],
        recomputes: [],
        convergence_check: "residual",
        clipping_or_fallback: null,
        used_by: ["b"],
        known_evidence: [{ claim: "c", source: "s", basis: "measured" }],
        unknown: ["not known"],
      },
      {
        id: "b",
        name: "Stage B",
        role: "does another thing",
        anchor: { file: "b.H", witness: "rho = thermo.rho();" },
        advances: [],
        lags: [],
        implicit_terms: [],
        explicit_terms: [],
        recomputes: ["rho"],
        convergence_check: null,
        clipping_or_fallback: null,
        used_by: [],
        known_evidence: [],
        unknown: [],
      },
    ],
    interfaces: [
      {
        id: "thermo",
        name: "Thermo",
        role: "recovers state",
        anchor: { file: "c.H", witness: "PengRobinson" },
        inputs: ["p"],
        outputs: ["rho"],
        used_by: ["a"],
        known_evidence: [],
        unknown: [],
      },
    ],
    diagnostics: [
      {
        id: "mesh",
        name: "checkMesh",
        measures: "mesh validity",
        does_not_measure: ["solution quality"],
        how: "run Allcheck",
        known_evidence: [],
      },
    ],
    unknown: ["nothing is profiled"],
  };
}

/** Write the synthetic source tree the tiny dossier anchors resolve against. */
async function writeSource(root: string, dossier: Dossier): Promise<void> {
  const anchors: SourceAnchor[] = [];
  for (const s of dossier.stages) anchors.push(s.anchor);
  for (const i of dossier.interfaces) anchors.push(i.anchor);
  for (const d of dossier.diagnostics) if (d.anchor) anchors.push(d.anchor);
  for (const a of anchors) {
    const path = join(root, a.file);
    await mkdir(join(path, ".."), { recursive: true });
    // Surround the witness with plausible context, so the test verifies a
    // search rather than a whole-file equality.
    await writeFile(path, `// prologue\n    ${a.witness}\n// epilogue\n`, "utf8");
  }
}

test("a dossier whose witnesses are all present verifies clean", async () => {
  const dossier = tinyDossier();
  await writeSource(dir, dossier);
  const v = await verifyDossier(dossier, dir);
  expect.equal(v.ok, true);
  expect.deepEqual(v.failures, []);
  expect.equal(v.checked, 3);
});

test("a dossier whose witness has drifted reports the drift", async () => {
  const dossier = tinyDossier();
  await writeSource(dir, dossier);
  // Simulate the code changing while the dossier is not re-derived.
  await writeFile(join(dir, "a.H"), "// the routine was renamed\n    reaction->update();\n", "utf8");
  const v = await verifyDossier(dossier, dir);
  expect.equal(v.ok, false);
  expect.equal(v.failures.length, 1);
  expect.equal(v.failures[0].entry, "stage:a");
  expect.equal(v.failures[0].file, "a.H");
  expect.ok(v.failures[0].reason.includes("drift"));
});

test("a dossier anchored at an absent file reports absence", async () => {
  const dossier = tinyDossier();
  await mkdir(join(dir, "applications"), { recursive: true });
  const v = await verifyDossier(dossier, dir);
  expect.equal(v.ok, false);
  expect.ok(v.failures.every((f) => f.reason.includes("absent")));
});

test("verification is insensitive to CRLF in the source", async () => {
  const dossier = tinyDossier();
  await writeSource(dir, dossier);
  // A host that checks the source out with CRLF must still verify.
  await writeFile(join(dir, "a.H"), "// prologue\r\n    reaction->correct();\r\n// epilogue\r\n", "utf8");
  const v = await verifyDossier(dossier, dir);
  expect.equal(v.ok, true);
});

test("readDossier refuses a file with the wrong schema version", async () => {
  const path = join(dir, "d.json");
  const bad = tinyDossier();
  bad.schema_version = 7 as Dossier["schema_version"];
  await writeFile(path, JSON.stringify(bad), "utf8");
  await expect.rejects(() => readDossier(path), /schema version/);
});

test("readDossier refuses a dossier not bound to a pinned package", async () => {
  const path = join(dir, "d.json");
  const bad = tinyDossier();
  bad.source_package = "";
  await writeFile(path, JSON.stringify(bad), "utf8");
  await expect.rejects(() => readDossier(path), /pinned source package/);
});

test("readDossier reports a missing file without throwing", async () => {
  await expect.rejects(() => readDossier(join(dir, "nope.json")), /no dossier/);
});

test("the briefing names every stage, its anchor and its unknowns", async () => {
  const dossier = tinyDossier();
  const text = renderDossierBriefing(dossier);
  expect.ok(text.includes("Stage A"));
  expect.ok(text.includes("reaction->correct();"));
  expect.ok(text.includes("not known"));
  // An unknown at the top level is a gap the model can ask about, so it must be
  // visible rather than compressed away.
  expect.ok(text.includes("nothing is profiled"));
  // The evidence basis is rendered, so a measured claim is distinguishable from
  // an advisor proposal in the briefing itself.
  expect.ok(text.includes("(measured)"));
});

test("the briefing distinguishes what a diagnostic does not measure", async () => {
  const text = renderDossierBriefing(tinyDossier());
  expect.ok(text.includes("does not measure: solution quality"));
});

test("the real dossier is well-formed and self-consistent", async () => {
  // Read the committed dossier and confirm it satisfies its own schema. The
  // anchor verification against the pinned package happens on the compute host.
  const dossier = await readDossier(join(process.cwd(), "dossiers", "realfluid-reacting-001.json"));
  expect.equal(dossier.dossier_id, "realfluid-reacting-001");
  expect.ok(dossier.stages.length >= 7);
  expect.ok(dossier.stages.every((s) => s.anchor.witness.length > 0));
  expect.ok(dossier.stages.every((s) => s.anchor.file.length > 0));
  // The cross-references between stages must resolve: a used_by entry names a
  // stage that exists.
  const ids = new Set(dossier.stages.map((s) => s.id));
  for (const s of dossier.stages) {
    for (const u of s.used_by) expect.ok(ids.has(u), `${s.id} refers to unknown stage ${u}`);
  }
  // Every stage states at least one unknown, or explicitly has none: the
  // field must be present, never omitted.
  expect.ok(dossier.stages.every((s) => Array.isArray(s.unknown)));
});
