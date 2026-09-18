/**
 * Probe the information interface with a live model.
 *
 * This is the acceptance test the reviewer defined: hand an assembled decision
 * context to an independent LLM and see whether it can reconstruct the
 * investigation, identify the missing evidence, and propose a bounded
 * hypothesis — without a human supplying the narrative.
 *
 *   node scripts/probe-context.mjs <run-root>
 *
 * The probe deliberately does NOT coach the model toward the right answer. It
 * presents the briefing and asks the reviewer's eight questions, then asks for
 * a bounded next intervention that cites its evidence. What comes back is
 * evaluated by a human against the acceptance questions; the probe's job is to
 * make the context legible, not to produce a verdict about itself.
 *
 * The model is reached through the relay. The gateway token is read from the
 * environment and never printed.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const runRoot = process.argv[2];
if (!runRoot) {
  console.error("usage: probe-context.mjs <run-root>");
  process.exit(2);
}

const contextPath = join(runRoot, "context", "decision-context.json");
const briefingPath = join(runRoot, "context", "briefing.md");
let briefing;
try {
  briefing = await readFile(briefingPath, "utf8");
} catch {
  console.error(`no briefing at ${briefingPath}; assemble a context first`);
  console.error("  node --experimental-strip-types scripts/assemble-context.ts --run <run-root> ...");
  process.exit(1);
}

const token = process.env.EVOCFD_GATEWAY_TOKEN;
if (!token) {
  console.error("EVOCFD_GATEWAY_TOKEN is required; the relay refuses unauthenticated egress");
  process.exit(2);
}

// The host the container reaches the relay through. Overridable for a host run.
const relay = process.env.EVOCFD_RELAY_URL ?? "http://172.17.0.1:18080";
const model = process.env.EVOCFD_MODEL ?? "Atria-Dawn-Preview";

const questions = [
  "What are we optimizing, and what is fixed and cannot change?",
  "How does the relevant computation work — which variables are advanced, which are recovered, and where are properties recomputed?",
  "What exactly changed between the attempts described, and what was held constant?",
  "Why was that change made — what observation or hypothesis motivated it?",
  "What did the evaluation actually measure, and what did it not measure?",
  "What have previous attempts ruled out, and what have they failed to test?",
  "What information is still missing that you would need to form a confident recommendation?",
  "Why should a proposed improvement transfer beyond the case it was tried on?",
];

const prompt = `${briefing}

---

You are advising a computational-fluid-dynamics research system. The briefing
above is the complete context you have been given; nothing has been added to it,
and you should not assume facts it does not state. Answer the following
questions from the briefing alone, then propose a next intervention.

Questions:

${questions.map((q, i) => `${i + 1}. ${q}`).join("\n")}

Then, as a bounded proposal:

- State one intervention you would test next, at the level of a specific change
  to a specific stage of the computation.
- State the mechanism by which you expect it to work, and the assumption about
  the implementation that the mechanism depends on.
- State the evidence you are relying on, quoting which part of the briefing it
  comes from.
- State the evidence you find missing, and name the specific measurement you
  would ask for before committing to the proposal.
- State the regime in which the proposal may fail.

If the briefing does not support an answer to a question, say so explicitly
rather than inferring one. Identifying a gap is a useful answer; a confident
guess is not. Answer the questions in order, then give the proposal under a
heading "Proposal".`;

async function callModel() {
  const started = Date.now();
  const res = await fetch(`${relay}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "system",
          content:
            "You are a careful scientific advisor for a real-fluid CFD solver. You distinguish what is measured from what is inferred, and you say when evidence is missing rather than filling the gap with a plausible answer.",
        },
        { role: "user", content: prompt },
      ],
      temperature: 0.2,
      max_tokens: 4096,
    }),
  });
  const elapsed = Date.now() - started;
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`the relay returned ${res.status} after ${elapsed}ms: ${body.slice(0, 300)}`);
  }
  const json = await res.json();
  const text = json?.choices?.[0]?.message?.content;
  if (typeof text !== "string" || text.length === 0) {
    throw new Error(`the relay returned no content: ${JSON.stringify(json).slice(0, 300)}`);
  }
  return { text, elapsed, usage: json.usage ?? null };
}

console.error(`probe     ${contextPath}`);
console.error(`briefing  ${briefing.length} chars`);
console.error(`model     ${model} via ${relay.replace(/:[^:@]+@/, ':***@')}`);
try {
  const { text, elapsed, usage } = await callModel();
  const outDir = join(runRoot, "context");
  await mkdir(outDir, { recursive: true });
  const outPath = join(outDir, "probe-answer.md");
  await writeFile(outPath, text, "utf8");
  console.error(`answer    ${text.length} chars in ${elapsed}ms`);
  if (usage) console.error(`tokens    ${JSON.stringify(usage)}`);
  console.error(`saved     ${outPath}`);
  // Print the answer so the operator can evaluate it against the acceptance
  // questions without opening the file.
  console.log(text);
} catch (e) {
  console.error(`probe failed: ${e.message}`);
  process.exit(1);
}
