/**
 * Import an advisor's response into a consultation.
 *
 * The response is recorded verbatim as an input, never as a command. What
 * happens afterwards is a controller decision, made separately and recorded
 * separately: an advisor may propose changing a boundary condition or a
 * physical assumption, but proposing it does not authorise it.
 *
 * Usage:
 *   node scripts/import-consultation.ts <run-root> <answer-file> \
 *     --provider "..." --model "..." [--human "..."]
 *
 * The answer file is the advisor's response text. The provider, displayed model
 * and human-contribution fields are recorded as metadata, because "the model
 * that was shown" and "what the human added" are both part of the scientific
 * record and neither can be reconstructed later.
 */
import { join } from "node:path";
import { readFile, stat } from "node:fs/promises";
import { argv, exit } from "node:process";

import {
  readRequest,
  readRequestDigest,
  recordDecision,
  recordResponse,
  type AdvisorResponse,
  type ConsultationState,
} from "../packages/controller/src/consultation.ts";
import { digestPath } from "../packages/controller/src/consultation.ts";

const SOLVER_ROOT = process.env.EVOCFD_SOLVER_ROOT ?? "/data2/kexiao/of8";
const SOLVER = join(SOLVER_ROOT, "rf-profile", "bin", "realFluidReactingFoam");
const CASE_SOURCE = join(SOLVER_ROOT, "rf-cases", "1D_advection");

function arg(name: string): string | undefined {
  const i = argv.indexOf(name);
  return i > -1 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

async function sha256(file: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

async function main(): Promise<void> {
  const runRoot = argv[2];
  const answerFile = argv[3];
  if (!runRoot || !answerFile) {
    console.error(
      "usage: import-consultation.ts <run-root> <answer-file> --provider <p> --model <m> [--human <h>]",
    );
    exit(2);
  }
  const request = await readRequest(runRoot);
  if (!request) {
    console.error(`no consultation request at ${runRoot}; prepare one first`);
    exit(1);
  }
  const digest = await readRequestDigest(runRoot);
  if (!digest) {
    console.error(`no request digest at ${runRoot}`);
    exit(1);
  }

  let answerText: string;
  try {
    answerText = await readFile(answerFile, "utf8");
  } catch (err) {
    console.error(`cannot read the answer at ${answerFile}: ${(err as Error).message}`);
    exit(1);
  }
  if (!answerText.trim()) {
    console.error("the answer file is empty; a consultation with no answer stays pending");
    exit(1);
  }

  const provider = arg("--provider") ?? "unknown";
  const displayedModel = arg("--model") ?? "unknown";
  const toolsUsed = arg("--tools") ? arg("--tools")!.split(",") : [];
  const humanContribution =
    arg("--human") ??
    "not stated; treat the response as transported, and record any added guidance separately";

  const response: AdvisorResponse = {
    requestId: request.requestId,
    answerText,
    provider,
    displayedModel,
    toolsUsed,
    humanContribution,
    receivedAt: new Date().toISOString(),
  };

  await recordResponse({ runRoot, response, requestDigest: digest });
  console.log(`ok response recorded for ${request.requestId}`);
  console.log(`   provider ${provider}, displayed model ${displayedModel}`);
  console.log(`   original answer ${join(runRoot, "response", "original-answer.md")}`);

  // Staleness is measured, not assumed. Re-measure the state the request was
  // bound against, so advice that arrives after the solver or case changed is
  // flagged rather than silently applied.
  let currentState: (() => Promise<ConsultationState>) | null = null;
  try {
    await stat(SOLVER);
    currentState = async () => ({
      solverExecutable: SOLVER,
      solverDigest: await sha256(SOLVER),
      caseDir: CASE_SOURCE,
      caseDigest: await digestPath(CASE_SOURCE),
      profileId: "of8-realfluid",
      relatedRunIds: request.state.relatedRunIds,
    });
  } catch {
    console.log("   note: the solver is not reachable here, so staleness is not measured");
  }

  await recordDecision({
    runRoot,
    decision: {
      requestId: request.requestId,
      // The response is admitted as evidence, not as an instruction. Whether
      // it becomes an experiment is a separate decision the human makes next.
      disposition: "admit",
      outcome: "requires_human_decision",
      rationale:
        "the response is recorded as evidence pending a human decision about what to execute; nothing here authorises a change",
      experimentPlan: null,
      deviations: [],
    },
    currentState,
  });
  console.log(`ok decision recorded as admitted-pending-review at ${runRoot}`);
  console.log("");
  console.log("The response is an input, not a command. Decide what to execute next,");
  console.log("and record the decision with the same request id.");
}

await main();
