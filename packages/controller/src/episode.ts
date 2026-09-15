/**
 * Run one agent episode: spawn the planned process, capture everything it
 * emits, and record the evidence.
 *
 * An episode is a single execution of a launch plan against a task workspace.
 * Its result is data, including its failures: a crash, a timeout, or a
 * malformed event stream produces an EpisodeResult, not an exception. Only
 * programming errors — bad input, or an attempt to overwrite existing
 * evidence — throw.
 *
 * Evidence is write-once. The raw stdout stream is recorded verbatim as
 * events.jsonl, because that stream is the primary artifact an episode is
 * evaluated on; parsed buckets are a convenience built on top of it, never a
 * replacement for it. Nothing the process emits is ever rewritten, and an
 * episode id may never be run twice into the same evidence directory.
 *
 * The plan, environment included, is recorded in result.json so a run can be
 * reproduced. That is safe because credentials are supplied through the agent
 * directory, never as environment values: an episode's environment is
 * reproducible and publishable by construction.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createWriteStream, mkdir, open, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { Readable } from "node:stream";
import {
  iterateJsonlLines,
  type JsonlEvent,
  type SessionHeader,
} from "@evocfd/rsih-adapter";

/** The invocation to run, as produced by the rsih-adapter. */
export interface LaunchPlan {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

export interface EpisodeInput {
  /** Episode identifier; names the evidence directory. */
  id: string;
  plan: LaunchPlan;
  /** Parent directory; evidence is written to <evidenceDir>/<id>/. */
  evidenceDir: string;
  /** Kill the run after this many milliseconds. */
  timeoutMs?: number;
}

export interface EpisodeResult {
  id: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  startedAt: string;
  endedAt: string;
  header: SessionHeader | null;
  events: JsonlEvent[];
  malformed: { raw: string; error: string }[];
  /** The exact invocation, recorded so a run can be reproduced. */
  plan: LaunchPlan;
  /** Absolute path of the recorded raw event stream. */
  evidencePath: string;
  stderrPath: string;
}

export class EpisodeAlreadyRunError extends Error {
  readonly code = "EALREADYRUN";
}

/**
 * Run an episode to completion (or timeout) and record its evidence.
 */
export async function runEpisode(input: EpisodeInput): Promise<EpisodeResult> {
  for (const [name, value] of [
    ["evidenceDir", input.evidenceDir],
    ["plan.cwd", input.plan.cwd],
  ] as const) {
    if (!isAbsolute(value)) {
      throw new Error(`Episode ${name} must be an absolute path, got: ${value}`);
    }
  }

  const evidenceRoot = join(input.evidenceDir, input.id);
  const evidencePath = join(evidenceRoot, "events.jsonl");
  const stderrPath = join(evidenceRoot, "stderr.txt");
  const resultPath = join(evidenceRoot, "result.json");

  // Evidence is never overwritten: an episode id that has already been run
  // into this directory is refused rather than silently appended over.
  if (existsSync(evidenceRoot)) {
    throw new EpisodeAlreadyRunError(
      `Evidence for episode ${input.id} already exists at ${evidenceRoot}`,
    );
  }
  await mkdir(evidenceRoot, { recursive: true });

  const startedAt = new Date().toISOString();
  const child = spawn(input.plan.command, input.plan.args, {
    cwd: input.plan.cwd,
    env: input.plan.env,
    stdio: ["ignore", "pipe", "pipe"],
    // Run in a new process group so a timeout can take down the agent and any
    // subprocesses it spawned together, rather than orphaning them.
    detached: process.platform !== "win32",
  });

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

  let timedOut = false;
  let exitCode: number | null = null;
  let signal: NodeJS.Signals | null = null;

  const timer =
    input.timeoutMs !== undefined
      ? setTimeout(() => {
          timedOut = true;
          killGroup(child);
        }, input.timeoutMs)
      : undefined;

  // Wait for the process to be gone AND its stdio to have drained: Node may
  // emit 'exit' before the last piped output is delivered, so 'close' is the
  // signal that all output is in hand. The timer below is a backstop for the
  // case where a grandchild outside the process group keeps a pipe open.
  await new Promise<void>((resolve) => {
    let settled = false;
    const done = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    child.on("exit", (code, sig) => {
      exitCode = code;
      signal = sig;
      const backstop = setTimeout(done, 5000);
      backstop.unref();
      child.on("close", () => clearTimeout(backstop));
    });
    child.on("close", done);
    child.on("error", (error) => {
      // Spawn-level failure (missing executable): recorded as an episode
      // failure rather than thrown.
      stderrChunks.push(Buffer.from(`spawn error: ${error.message}\n`));
      done();
    });
  });
  if (timer) clearTimeout(timer);

  const endedAt = new Date().toISOString();
  const raw = Buffer.concat(stdoutChunks);

  // Write the evidence before parsing, so even a run that died mid-stream
  // leaves an exact record of what was emitted. 'wx' refuses to overwrite.
  const evidenceFile = await open(evidencePath, "wx");
  await evidenceFile.writeFile(raw);
  await evidenceFile.close();
  await writeFile(stderrPath, Buffer.concat(stderrChunks));

  const header = await firstHeader(raw);
  const { events, malformed } = await bucket(raw);

  const result: EpisodeResult = {
    id: input.id,
    exitCode,
    signal,
    timedOut,
    startedAt,
    endedAt,
    header,
    events,
    malformed,
    plan: input.plan,
    evidencePath,
    stderrPath,
  };
  await writeFile(resultPath, JSON.stringify(result, null, 2));

  return result;
}

function killGroup(child: { pid?: number | null; kill: (sig: string) => boolean }) {
  if (child.pid === undefined || child.pid === null) return;
  if (process.platform === "win32") {
    child.kill("SIGTERM");
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    // The group may already be gone; the child's own exit is what we wait on.
    child.kill("SIGTERM");
  }
}

async function firstHeader(raw: Buffer): Promise<SessionHeader | null> {
  for await (const parsed of iterateJsonlLines(Readable.from([raw]))) {
    if (parsed.kind === "header") return parsed.header;
    if (parsed.kind === "event") break; // header, if any, comes first
  }
  return null;
}

async function bucket(
  raw: Buffer,
): Promise<{ events: JsonlEvent[]; malformed: { raw: string; error: string }[] }> {
  const events: JsonlEvent[] = [];
  const malformed: { raw: string; error: string }[] = [];
  for await (const parsed of iterateJsonlLines(Readable.from([raw]))) {
    if (parsed.kind === "event") events.push(parsed.event);
    else if (parsed.kind === "malformed") malformed.push(parsed);
  }
  return { events, malformed };
}
