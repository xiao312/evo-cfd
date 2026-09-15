/**
 * Episode runner tests.
 *
 * A real agent is not needed to test the runner: what has to hold is that
 * whatever the planned process does — succeed, crash, emit garbage, hang — the
 * runner records it faithfully and never throws. So the episodes here run a
 * fake agent CLI with a handful of scripted behaviours.
 *
 * Run with: node --experimental-strip-types --test test/*.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runEpisode, EpisodeAlreadyRunError } from "../src/episode.ts";

/**
 * A stand-in for the RSI-Harness CLI. Emits a session header followed by a
 * small event stream, chosen by argv[2]. Written without template literals so
 * it can be embedded here as a plain string.
 *
 * - ok          header, agent_start, tool_call, tool_result, message_end,
 *               agent_settled, session_shutdown; exit 0
 * - crash       header, agent_start, a stderr line, exit 1
 * - malformed   header, agent_start, a line that is not JSON, message_end
 * - hang        header, agent_start, then block until killed (self-exits after
 *               two minutes as a safety net)
 * - dumpenv     header carrying the environment keys the child saw
 */
const FAKE_CLI = [
  "import { argv, env, stdout, stderr } from 'node:process';",
  "const behavior = argv[2] ?? 'ok';",
  "function emit(o) { stdout.write(JSON.stringify(o) + '\\n'); }",
  "function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }",
  "async function main() {",
  "  if (behavior === 'dumpenv') {",
  "    emit({ type: 'session', env: Object.keys(env).sort() });",
  "    await sleep(30);",
  "    return;",
  "  }",
  "  emit({ type: 'session', id: 'fake-session' });",
  "  await sleep(30);",
  "  emit({ type: 'agent_start' });",
  "  if (behavior === 'crash') {",
  "    stderr.write('agent exploded\\n');",
  "    process.exitCode = 1;",
  "    return;",
  "  }",
  "  if (behavior === 'malformed') {",
  "    stdout.write('this is not json\\n');",
  "    emit({ type: 'message_end' });",
  "    return;",
  "  }",
  "  if (behavior === 'hang') { await sleep(120000); return; }",
  "  emit({ type: 'tool_call', tool: 'bash' });",
  "  emit({ type: 'tool_result', tool: 'bash' });",
  "  emit({ type: 'message_end' });",
  "  emit({ type: 'agent_settled' });",
  "  emit({ type: 'session_shutdown' });",
  "}",
  "main();",
].join("\n");

/** The environment every episode is run under: exactly these eight keys. */
const CONTROLLED_ENV = {
  PATH: "/usr/bin:/bin",
  HOME: "/tmp/fake-home",
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  TZ: "UTC",
  NO_COLOR: "1",
  TERM: "dumb",
  PI_CODING_AGENT_DIR: "/tmp/fake-agent-dir",
};

let evidenceDir: string;
let workspaceDir: string;
let cliPath: string;

test.before(async () => {
  const staging = await mkdtemp(join(tmpdir(), "evocfd-episode-"));
  evidenceDir = join(staging, "evidence");
  workspaceDir = join(staging, "workspace");
  cliPath = join(staging, "fake-cli.ts");
  await writeFile(cliPath, FAKE_CLI);
  await mkdir(workspaceDir, { recursive: true });
  await writeFile(join(workspaceDir, "marker.txt"), "task workspace\n");
});

test.after(async () => {
  await rm(join(evidenceDir, ".."), { recursive: true, force: true });
});

/** A launch plan for the fake CLI with the given behaviour. */
function plan(behavior: string) {
  return {
    command: process.execPath,
    args: ["--experimental-strip-types", cliPath, behavior],
    cwd: workspaceDir,
    env: { ...CONTROLLED_ENV },
  };
}

test("records a clean episode", async () => {
  const result = await runEpisode({
    id: "ok",
    plan: plan("ok"),
    evidenceDir,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.header?.type, "session");
  assert.equal(result.header?.id, "fake-session");
  const types = result.events.map((event) => event.type);
  assert.deepEqual(types, [
    "agent_start",
    "tool_call",
    "tool_result",
    "message_end",
    "agent_settled",
    "session_shutdown",
  ]);
  assert.equal(result.malformed.length, 0);
});

test("the recorded stream is exactly what was emitted", async () => {
  const result = await runEpisode({
    id: "verbatim",
    plan: plan("ok"),
    evidenceDir,
  });
  const recorded = await readFile(result.evidencePath, "utf8");
  assert.ok(recorded.includes('"type":"session","id":"fake-session"'));
  assert.ok(recorded.includes('"type":"agent_settled"'));
  assert.ok(recorded.endsWith('"type":"session_shutdown"}\n'));
  const digest = JSON.parse(await readFile(join(dirname(result.evidencePath), "result.json"), "utf8"));
  assert.equal(digest.id, "verbatim");
  assert.equal(digest.exitCode, 0);
});

test("a crash is a result, not an exception", async () => {
  const result = await runEpisode({
    id: "crash",
    plan: plan("crash"),
    evidenceDir,
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.timedOut, false);
  assert.ok(result.header !== null);
  const stderr = await readFile(result.stderrPath, "utf8");
  assert.ok(stderr.includes("agent exploded"));
});

test("a malformed stream still yields its valid events", async () => {
  const result = await runEpisode({
    id: "malformed",
    plan: plan("malformed"),
    evidenceDir,
  });
  assert.equal(result.malformed.length, 1);
  assert.equal(result.malformed[0].raw, "this is not json");
  assert.deepEqual(
    result.events.map((event) => event.type),
    ["agent_start", "message_end"],
  );
});

test("a hanging episode is stopped at the timeout", async () => {
  const result = await runEpisode({
    id: "hang",
    plan: plan("hang"),
    evidenceDir,
    timeoutMs: 400,
  });
  assert.equal(result.timedOut, true);
  assert.ok(result.header !== null);
  // Whatever had been emitted before the kill is preserved.
  assert.deepEqual(
    result.events.map((event) => event.type),
    ["agent_start"],
  );
  const recorded = await readFile(result.evidencePath, "utf8");
  assert.ok(recorded.includes('"type":"agent_start"'));
});

test("evidence is never overwritten", async () => {
  const first = await runEpisode({
    id: "overwrite",
    plan: plan("ok"),
    evidenceDir,
  });
  const before = await readFile(first.evidencePath, "utf8");
  await assert.rejects(
    () => runEpisode({ id: "overwrite", plan: plan("crash"), evidenceDir }),
    (error: unknown) => error instanceof EpisodeAlreadyRunError,
  );
  const after = await readFile(first.evidencePath, "utf8");
  assert.equal(after, before);
});

test("nothing is written into the task workspace", async () => {
  await runEpisode({ id: "workspace-clean", plan: plan("ok"), evidenceDir });
  assert.deepEqual(await readdir(workspaceDir), ["marker.txt"]);
});

test("the child sees only the controlled environment", async () => {
  const result = await runEpisode({
    id: "dumpenv",
    plan: plan("dumpenv"),
    evidenceDir,
  });
  assert.deepEqual(result.header?.env, Object.keys(CONTROLLED_ENV).sort());
});

test("a missing executable is an episode failure, not a throw", async () => {
  const result = await runEpisode({
    id: "noexec",
    plan: {
      command: "this-command-does-not-exist",
      args: [],
      cwd: workspaceDir,
      env: { ...CONTROLLED_ENV },
    },
    evidenceDir,
  });
  assert.equal(result.exitCode, null);
  const stderr = await readFile(result.stderrPath, "utf8");
  assert.ok(stderr.includes("spawn error"));
});

test("relative paths are refused", async () => {
  await assert.rejects(
    () =>
      runEpisode({
        id: "relative",
        plan: { ...plan("ok"), cwd: "relative/cwd" },
        evidenceDir: "relative/evidence",
      }),
    /must be an absolute path/,
  );
});

function dirname(path: string): string {
  return path.slice(0, Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")));
}
