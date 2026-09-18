/**
 * Transport tests.
 *
 * These are deterministic: no browser, no network, no timing. Every fail-closed
 * rule is exercised with a candidate that breaks exactly one of them, so a rule
 * that silently stops being enforced shows up as a failing test rather than as
 * a run that imported the wrong answer.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
const expect = assert;

import {
  createTransportJob,
  readTransportJob,
  markWaiting,
  recordCandidate,
  verifyCandidate,
  recordImport,
  markIncomplete,
  isImportable,
  parseDeclaredIdentity,
  TransportError,
  type TransportJob,
} from "../src/transport.ts";

const FIXED_NOW = new Date("2026-09-17T12:00:00Z");
const LATER = new Date("2026-09-17T13:00:00Z");
const DIGEST = "5b1a".repeat(16);

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "evocfd-transport-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function makeJob(overrides: Partial<Parameters<typeof createTransportJob>[0]> = {}) {
  return createTransportJob({
    // The clock is fixed for every job, so a deadline test can place a capture
    // beyond it without depending on the wall clock.
    now: FIXED_NOW,
    runRoot: dir,
    requestId: "external-diagnostic-selection",
    requestRevision: 1,
    requestDigest: DIGEST,
    expectedProjectUrl: "https://chatgpt.com/g/g-p-evocfd",
    expectedConversationUrl: "",
    deadlineSeconds: 3600,
    ...overrides,
  });
}

function answerWith(declaredId: string, declaredDigest: string): string {
  return (
    `# Analysis\n\nREQUEST_ID ${declaredId}\n` +
    `REQUEST_DIGEST ${declaredDigest}\n\nSome reasoning about the solver.\n`
  );
}

async function captureAndVerify(job: TransportJob, text: string, page: {
  assistantTurns: number;
  generating: boolean;
} = { assistantTurns: 1, generating: false }) {
  await markWaiting(dir, FIXED_NOW);
  await recordCandidate(dir, text, page, FIXED_NOW);
  return verifyCandidate(dir, LATER);
}

test("a job is created with the identity it will check against", async () => {
  const job = await makeJob();
  expect.equal(job.status, "submitted");
  expect.equal(job.request_id, "external-diagnostic-selection");
  expect.equal(job.request_digest, DIGEST);
  expect.equal(job.log.length, 1);
  // The deadline is a real future time, not an open-ended wait.
  expect.ok(new Date(job.deadline).getTime() > new Date(job.submission_boundary).getTime());
});

test("a job refuses to be created without a project binding", async () => {
  await expect.rejects(
    () => makeJob({ expectedProjectUrl: "" }),
    /project url/,
  );
});

test("a job refuses a digest that is not the full 64 characters", async () => {
  await expect.rejects(() => makeJob({ requestDigest: "abc" }), /64-character/);
});

test("a full round trip reaches imported", async () => {
  const job = await captureAndVerify(
    await makeJob(),
    answerWith("external-diagnostic-selection", DIGEST),
  );
  expect.equal(job.status, "verified");
  expect.equal(job.verification?.outcome, "verified");
  expect.deepEqual(job.verification?.failures, []);

  const imported = await recordImport(dir, "resp-001", LATER);
  expect.equal(imported.status, "imported");
  expect.equal(imported.import?.response_id, "resp-001");
  expect.equal(imported.import?.sha256, job.candidate?.sha256);
  // The log records every transition in order, and is never rewritten.
  const statuses = imported.log.map((t) => t.to);
  expect.deepEqual(statuses, ["submitted", "waiting", "captured", "verified", "imported"]);
});

test("an answer that declares no identity is refused, not imported", async () => {
  const job = await captureAndVerify(await makeJob(), "# Analysis\n\nNo identity lines at all.\n");
  expect.equal(job.status, "refused");
  expect.equal(job.verification?.outcome, "refused");
  expect.ok(job.verification?.failures.some((f) => f.includes("does not declare")));
  expect.equal(isImportable(job), false);
  // The bytes are still on record.
  expect.ok(job.candidate && job.candidate.char_count > 0);
});

test("an answer declaring the wrong request id is refused", async () => {
  const job = await captureAndVerify(
    await makeJob(),
    answerWith("some-other-request", DIGEST),
  );
  expect.equal(job.status, "refused");
  expect.ok(job.verification?.failures.some((f) => f.includes("declares request id")));
});

test("an answer with a stale digest is refused as belonging to an earlier revision", async () => {
  const old = "0".repeat(64);
  const job = await captureAndVerify(
    await makeJob(),
    answerWith("external-diagnostic-selection", old),
  );
  expect.equal(job.status, "refused");
  const failures = job.verification?.failures ?? [];
  expect.ok(failures.some((f) => f.includes("stale")));
  expect.ok(failures.some((f) => f.includes("earlier revision")));
});

test("a digest is matched exactly, not by prefix", async () => {
  const job = await captureAndVerify(
    await makeJob(),
    answerWith("external-diagnostic-selection", DIGEST.slice(0, 60) + "abcd"),
  );
  expect.equal(job.status, "refused");
});

test("a paused stream is not a completed answer", async () => {
  const job = await captureAndVerify(
    await makeJob(),
    answerWith("external-diagnostic-selection", DIGEST),
    { assistantTurns: 1, generating: true },
  );
  expect.equal(job.status, "refused");
  expect.ok(job.verification?.failures.some((f) => f.includes("still generating")));
});

test("a page with no assistant turn has no answer to read", async () => {
  const job = await captureAndVerify(
    await makeJob(),
    answerWith("external-diagnostic-selection", DIGEST),
    { assistantTurns: 0, generating: false },
  );
  expect.equal(job.status, "refused");
  expect.ok(job.verification?.failures.some((f) => f.includes("no assistant turn")));
});

test("a candidate captured after the deadline is incomplete", async () => {
  await makeJob({ deadlineSeconds: 1 });
  await markWaiting(dir, FIXED_NOW);
  const longAfter = new Date(FIXED_NOW.getTime() + 7200_000);
  await recordCandidate(
    dir,
    answerWith("external-diagnostic-selection", DIGEST),
    { assistantTurns: 1, generating: false },
    longAfter,
  );
  const job = await verifyCandidate(dir, longAfter);
  expect.equal(job.status, "refused");
  expect.ok(job.verification?.failures.some((f) => f.includes("deadline")));
});

test("importing from anything but verified is refused", async () => {
  await makeJob();
  await expect.rejects(() => recordImport(dir, "resp-x", LATER), /only a verified candidate/);
});

test("importing the same candidate twice is idempotent", async () => {
  const job = await captureAndVerify(
    await makeJob(),
    answerWith("external-diagnostic-selection", DIGEST),
  );
  const first = await recordImport(dir, "resp-001", LATER);
  const second = await recordImport(dir, "resp-001", LATER);
  expect.deepEqual(first.log, second.log);
  expect.equal(second.log.filter((t) => t.to === "imported").length, 1);
});

test("re-capturing identical bytes does not flood the log", async () => {
  await makeJob();
  await markWaiting(dir, FIXED_NOW);
  const text = answerWith("external-diagnostic-selection", DIGEST);
  await recordCandidate(dir, text, { assistantTurns: 1, generating: false }, FIXED_NOW);
  await recordCandidate(dir, text, { assistantTurns: 1, generating: false }, FIXED_NOW);
  await recordCandidate(dir, text, { assistantTurns: 1, generating: false }, FIXED_NOW);
  const job = await readTransportJob(dir);
  expect.equal(job?.log.filter((t) => t.to === "captured").length, 1);
});

test("a refused job cannot be marked incomplete", async () => {
  const job = await captureAndVerify(await makeJob(), "no identity lines here\n");
  expect.equal(job.status, "refused");
  await expect.rejects(() => markIncomplete(dir, "operator gave up"), /cannot mark refused/);
});

test("an abandoned job is marked incomplete without an answer", async () => {
  const job = await makeJob();
  const after = await markIncomplete(dir, "operator abandoned the submission", LATER);
  expect.equal(after.status, "incomplete");
  expect.equal(job.transport_job_id, after.transport_job_id);
});

test("the job survives a crash and is recovered by reading it", async () => {
  await makeJob();
  await markWaiting(dir, FIXED_NOW);
  // A crash is nothing more than the process dying between stages. The next run
  // reads the record rather than reconstructing it.
  const recovered = await readTransportJob(dir);
  expect.equal(recovered?.status, "waiting");
  expect.equal(recovered?.log.length, 2);
});

test("parseDeclaredIdentity reads the export's identity lines", () => {
  const parsed = parseDeclaredIdentity(
    `REQUEST_ID external-diagnostic-selection\nREQUEST_DIGEST ${DIGEST}\n`,
  );
  expect.equal(parsed.requestId, "external-diagnostic-selection");
  expect.equal(parsed.requestDigest, DIGEST);
});

test("parseDeclaredIdentity rejects a truncated digest", () => {
  const parsed = parseDeclaredIdentity(
    `REQUEST_ID external-diagnostic-selection\nREQUEST_DIGEST ${DIGEST.slice(0, 40)}\n`,
  );
  expect.equal(parsed.requestDigest, null);
});

test("no transport job is reported without throwing", async () => {
  expect.equal(await readTransportJob(dir), null);
  await expect.rejects(() => markWaiting(dir), TransportError);
});

test("the receiver takes identity from the job, not from constants", async () => {
  // The job is the only source: a run whose request differs from the one the
  // earlier receiver hard-coded must verify against its own request.
  const other = "9f2c".repeat(16);
  const job = await captureAndVerify(
    await makeJob({ requestId: "a-different-request", requestDigest: other }),
    answerWith("a-different-request", other),
  );
  expect.equal(job.status, "verified");
  expect.equal(job.request_id, "a-different-request");
});
