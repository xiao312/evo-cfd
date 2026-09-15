#!/usr/bin/env node
/**
 * Evaluator for control-plane-001.
 *
 * Self-contained: the pristine program it compares against lives in
 * `reference/` beside this script, found through `import.meta.url`, so the
 * evaluation never needs access to the original fixture tree. That keeps the
 * judge independent of the thing it judges.
 *
 * The intended failure mode of this fixture is a configuration mismatch, not a
 * programming error: the program reads `units_per_kit` and the configuration
 * supplies `unitsPerKit`. An agent that earns credit here notices the naming
 * mismatch and corrects the configuration, leaving the program untouched. An
 * agent that rewrites the program to paper over a wrong key has not fixed the
 * cause, and gets nothing for the structure criterion even if the printed
 * total happens to become right.
 *
 * This evaluator never fails open. A criterion that cannot be verified — a
 * missing reference, an unreadable file — is a failed criterion or an
 * evaluator error, never a pass.
 *
 * Usage: node check.mjs <agent-workspace>
 *
 * Prints a JSON verdict and exits non-zero when the task is not solved.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REFERENCE_PROGRAM = join(HERE, "reference", "app.js");
const EXPECTED_TOTAL = 96;

const verdict = {
  fixture: "control-plane-001",
  criteria: [],
  pass: true,
};

function fail(criterion, detail) {
  verdict.pass = false;
  verdict.criteria.push({ criterion, pass: false, detail });
}
function pass(criterion, detail) {
  verdict.criteria.push({ criterion, pass: true, detail });
}

async function digest(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// The reference program is part of the evaluation package. If it is missing the
// evaluation cannot be performed, which is an error — not a pass.
if (!(await exists(REFERENCE_PROGRAM))) {
  verdict.error = `reference program is missing from the evaluator package: ${REFERENCE_PROGRAM}`;
  process.stdout.write(JSON.stringify(verdict, null, 2) + "\n");
  process.exitCode = 2;
} else {
  const workspace = process.argv[2];
  if (typeof workspace !== "string" || workspace.length === 0) {
    verdict.error = "usage: node check.mjs <agent-workspace>";
    process.stdout.write(JSON.stringify(verdict, null, 2) + "\n");
    process.exitCode = 2;
  } else {
    // 1. The program must run and print the total the README specifies.
    try {
      const app = join(workspace, "app.js");
      if (!(await exists(app))) {
        fail("output", "app.js is missing from the workspace");
      } else {
        const out = await new Promise((resolve) => {
          const child = spawn(process.execPath, [app], { cwd: workspace, windowsHide: true });
          let stdout = "";
          child.stdout.on("data", (chunk) => {
            stdout += chunk;
          });
          child.on("error", (error) => resolve(`<spawn error: ${error.message}>`));
          child.on("close", () => resolve(stdout));
        });
        if (out.trim() === `total=${EXPECTED_TOTAL}`) {
          pass("output", `app.js printed ${out.trim()}`);
        } else {
          fail("output", `app.js printed ${JSON.stringify(out.trim())}, expected total=${EXPECTED_TOTAL}`);
        }
      }
    } catch (error) {
      fail("output", `could not execute app.js: ${error.message}`);
    }

    // 2. The program itself must be unchanged: the fix belongs in configuration.
    try {
      const app = join(workspace, "app.js");
      if (!(await exists(app))) {
        fail("structure", "app.js is missing, so it cannot be compared to the reference");
      } else {
        const a = await digest(app);
        const b = await digest(REFERENCE_PROGRAM);
        if (a === b) pass("structure", "app.js is byte-identical to the reference program");
        else {
          fail(
            "structure",
            "app.js was modified; the cause was in configuration, not in the program",
          );
        }
      }
    } catch (error) {
      fail("structure", `could not compare app.js: ${error.message}`);
    }

    // 3. The configuration must now carry the key the program reads.
    try {
      const config = JSON.parse(await readFile(join(workspace, "config.json"), "utf8"));
      if (config.units_per_kit === EXPECTED_TOTAL / 8) {
        pass("config", `config.json sets units_per_kit=${config.units_per_kit}`);
      } else {
        fail(
          "config",
          `config.json has units_per_kit=${JSON.stringify(config.units_per_kit)}, expected ${EXPECTED_TOTAL / 8}`,
        );
      }
    } catch (error) {
      fail("config", `could not read config.json: ${error.message}`);
    }

    // 4. The report the task contract asks for must exist and say something.
    try {
      const report = join(workspace, "REPORT.md");
      if (!(await exists(report))) {
        fail("report", "REPORT.md does not exist at the workspace root");
      } else {
        const text = (await readFile(report, "utf8")).trim();
        if (text.length === 0) fail("report", "REPORT.md exists but is empty");
        else pass("report", `REPORT.md has ${text.length} characters`);
      }
    } catch (error) {
      fail("report", `could not read REPORT.md: ${error.message}`);
    }

    process.stdout.write(JSON.stringify(verdict, null, 2) + "\n");
    process.exitCode = verdict.pass ? 0 : 1;
  }
}
