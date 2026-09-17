/**
 * Import an advisor's response into a consultation.
 *
 * The response is recorded verbatim as an input, never as a command. What
 * happens afterwards is a controller decision, made separately and recorded
 * separately: an advisor may propose changing a boundary condition or a
 * physical assumption, but proposing it does not authorise it.
 *
 * The mode is not a label. `self_review` is a local integration test;
 * `external_web_manual` is a genuine external consultation carried by a human;
 * `external_api` is an official API call. They are different evidence about
 * different hypotheses, and an external mode requires a conversation reference
 * the operator can resolve. There is deliberately no route by which an
 * unavailable external advisor falls back to the executor while still being
 * recorded as a successful external consultation.
 *
 * Usage:
 *   node scripts/import-consultation.ts <run-root> <answer-file> \
 *     --mode external_web_manual --provider "ChatGPT" --model "GPT-5" \
 *     --conversation-ref "https://chat.openai.com/c/abc" [--human "..."]
 *
 * The freshness check re-measures the state recorded in the *request* itself,
 * not a hard-coded path, so the importer is not tied to one case.
 */
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { argv, exit } from "node:process";

import {
  activeRequestDir,
  digestPath,
  readRequest,
  recordDecision,
  recordResponse,
  type AdvisorMode,
  type AdvisorResponse,
  type ConsultationState,
} from "../packages/controller/src/consultation.ts";

function arg(name: string): string | undefined {
  const i = argv.indexOf(name);
  return i > -1 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

async function sha256(file: string): Promise<string> {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

async function main(): Promise<void> {
  const runRoot = argv[2];
  const answerFile = argv[3];
  if (!runRoot || !answerFile) {
    console.error(
      "usage: import-consultation.ts <run-root> <answer-file> --request-id <id> --request-digest <hex> --mode <m> --provider <p> --model <m> [--conversation-ref <url>] [--human <h>]",
    );
    exit(2);
  }
  const active = await activeRequestDir(runRoot);
  if (!active) {
    console.error(`no consultation request at ${runRoot}; prepare one first`);
    exit(1);
  }
  const request = await readRequest(runRoot);
  if (!request) {
    console.error(`the active request at ${active.dir} has no readable request.json`);
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

  // The request identity is supplied by the caller and verified, never
  // manufactured from the destination. Without this the importer could attach an
  // unrelated answer to the current request by filling in the expected identity
  // itself: the digest check would then pass against a value the same caller
  // supplied. An answer carried back from an external advisor must declare the
  // identity it was prepared against.
  const suppliedId = arg("--request-id");
  const suppliedDigest = arg("--request-digest");
  if (!suppliedId || !suppliedDigest) {
    console.error(
      "an imported answer must declare the request identity it was prepared against; pass --request-id and --request-digest with the values the export printed",
    );
    exit(2);
  }
  if (suppliedId !== request.requestId) {
    console.error(
      `the answer declares request id ${suppliedId} but the active request is ${request.requestId}; refusing to attach an answer to a request it was not prepared for`,
    );
    exit(1);
  }
  if (suppliedDigest !== active.digest) {
    console.error(
      `the answer declares request digest ${suppliedDigest.slice(0, 16)}... but the active request payload hashes to ${active.digest.slice(0, 16)}...; the request changed after this answer was prepared, so the answer is stale`,
    );
    exit(1);
  }
  const mode = (arg("--mode") ?? "self_review") as AdvisorMode;
  const provider = arg("--provider") ?? "unknown";
  const displayedModel = arg("--model") ?? "unknown";
  const conversationRef = arg("--conversation-ref") ?? "";
  const toolsUsed = arg("--tools") ? arg("--tools")!.split(",") : [];
  const humanContribution =
    arg("--human") ??
    (mode === "self_review"
      ? "same-model self-review; no external participation"
      : "operator-attested transport; the metadata records what was displayed, not a proof of backend identity");

  // The digest the exporter measured, taken from the request package and
  // re-hashed on import. This is what binds the answer to bytes.
  const response: AdvisorResponse = {
    requestId: request.requestId,
    answerText,
    mode,
    provider,
    displayedModel,
    toolsUsed,
    conversationRef,
    humanContribution,
    requestDigest: active.digest,
    receivedAt: new Date().toISOString(),
  };

  const { responseId } = await recordResponse({ runRoot, response });
  console.log(`ok response ${responseId} recorded for ${request.requestId}`);
  console.log(`   mode ${mode}, provider ${provider}, displayed model ${displayedModel}`);
  if (conversationRef) console.log(`   conversation ${conversationRef}`);
  console.log(`   original answer ${join(runRoot, "response", responseId, "original-answer.md")}`);

  // Freshness is measured, not assumed, and the paths come from the request's
  // own recorded state. Where the solver or case cannot be reached the result
  // is `unmeasured`, which is a different fact from `fresh`.
  let currentState: (() => Promise<ConsultationState>) | null = null;
  const unreachable: string[] = [];
  const measured: ConsultationState = {
    ...request.state,
    libraryFiles: [],
    solverDigest: "",
    caseDigest: "",
  };
  try {
    measured.solverDigest = await sha256(request.state.solverExecutable);
  } catch {
    unreachable.push(request.state.solverExecutable);
  }
  try {
    measured.caseDigest = await digestPath(request.state.caseDir);
  } catch {
    unreachable.push(request.state.caseDir);
  }
  const libraries = [];
  for (const lib of request.state.libraryFiles ?? []) {
    try {
      libraries.push({ path: lib.path, digest: await sha256(lib.path) });
    } catch {
      unreachable.push(lib.path);
    }
  }
  measured.libraryFiles = libraries;

  if (unreachable.length > 0) {
    console.log(`   note: could not measure ${unreachable.length} state path(s), so`);
    console.log("         freshness will be recorded as unmeasured, not fresh:");
    for (const p of unreachable) console.log(`           ${p}`);
    currentState = null;
  } else {
    currentState = async () => measured;
  }

  await recordDecision({
    runRoot,
    decision: {
      requestId: request.requestId,
      responseId,
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
  console.log("and record the decision with the same request and response id.");
}

await main();
