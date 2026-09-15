/**
 * Parse the JSONL event stream an RSI-Harness episode writes to stdout.
 *
 * With --json, Pi's print mode writes one JSON object per line: first a session
 * header (the same `type: "session"` entry that starts its session transcript),
 * then the agent event stream — one object per event, each carrying a `type`.
 * `agent_settled` is the signal that a run has fully settled, with no retry,
 * compaction, or queued continuation left to run, which makes it the natural
 * end of an episode.
 *
 * The stream is treated as untrusted input: a line that is not valid JSON, or
 * valid JSON without a type, is reported as malformed rather than thrown, so a
 * partial or corrupted episode still yields everything that could be parsed.
 */
import type { Readable } from "node:stream";

export interface JsonlEvent {
  type: string;
  [key: string]: unknown;
}

export interface SessionHeader {
  type: "session";
  [key: string]: unknown;
}

export type ParsedLine =
  | { kind: "header"; header: SessionHeader }
  | { kind: "event"; event: JsonlEvent }
  | { kind: "empty" }
  | { kind: "malformed"; raw: string; error: string };

/** The event types an episode runner actually reacts to. */
export const EVENT_TYPES = {
  sessionStart: "session_start",
  sessionShutdown: "session_shutdown",
  agentStart: "agent_start",
  agentEnd: "agent_end",
  agentSettled: "agent_settled",
  turnStart: "turn_start",
  turnEnd: "turn_end",
  messageStart: "message_start",
  messageDelta: "message_delta",
  messageEnd: "message_end",
  toolCall: "tool_call",
  toolResult: "tool_result",
  error: "error",
} as const;

/** Parse one line. Never throws; malformed lines are reported, not fatal. */
export function parseLine(line: string): ParsedLine {
  const trimmed = line.trim();
  if (trimmed === "") return { kind: "empty" };

  try {
    const value = JSON.parse(trimmed);
    if (typeof value !== "object" || value === null) {
      return { kind: "malformed", raw: trimmed, error: "not an object" };
    }
    const event = value as { type?: unknown };
    if (typeof event.type !== "string") {
      return { kind: "malformed", raw: trimmed, error: "object has no string type" };
    }
    return event.type === "session"
      ? { kind: "header", header: value as SessionHeader }
      : { kind: "event", event: value as JsonlEvent };
  } catch (error) {
    return { kind: "malformed", raw: trimmed, error: (error as Error).message };
  }
}

export function isSessionHeader(parsed: ParsedLine): parsed is { kind: "header"; header: SessionHeader } {
  return parsed.kind === "header";
}

export function isEvent(
  parsed: ParsedLine,
): parsed is { kind: "event"; event: JsonlEvent } {
  return parsed.kind === "event";
}

export function hasType(parsed: ParsedLine, type: string): boolean {
  return isEvent(parsed) && parsed.event.type === type;
}

/** A run that has settled: nothing further will happen automatically. */
export function isAgentSettled(parsed: ParsedLine): boolean {
  return hasType(parsed, EVENT_TYPES.agentSettled);
}

/** The session is closed; no more events will follow. */
export function isSessionShutdown(parsed: ParsedLine): boolean {
  return hasType(parsed, EVENT_TYPES.sessionShutdown);
}

/** An error reported by the runtime, as distinct from a malformed line. */
export function isErrorEvent(parsed: ParsedLine): boolean {
  return hasType(parsed, EVENT_TYPES.error);
}

export interface StreamReaderResult {
  headers: SessionHeader[];
  events: JsonlEvent[];
  malformed: { raw: string; error: string }[];
  lines: number;
}

/** Yield one parsed line at a time. Stream state is local to the call. */
export async function* iterateJsonlLines(stream: Readable): AsyncGenerator<ParsedLine> {
  let partial = "";
  const flush = (line: string): ParsedLine => parseLine(line);
  for await (const chunk of stream) {
    // A chunk may carry several lines or only part of one: split on newlines
    // and hold the remainder for the next chunk.
    partial += chunk instanceof Buffer ? chunk.toString("utf8") : String(chunk);
    const lines = partial.split("\n");
    partial = lines.pop() ?? "";
    for (const line of lines) yield flush(line);
  }
  if (partial.trim() !== "") yield flush(partial);
}

/** Read a stream to completion and bucket the results. */
export async function readJsonlStream(stream: Readable): Promise<StreamReaderResult> {
  const result: StreamReaderResult = {
    headers: [],
    events: [],
    malformed: [],
    lines: 0,
  };
  for await (const parsed of iterateJsonlLines(stream)) {
    result.lines += 1;
    if (parsed.kind === "header") result.headers.push(parsed.header);
    else if (parsed.kind === "event") result.events.push(parsed.event);
    else if (parsed.kind === "malformed") result.malformed.push(parsed);
  }
  return result;
}
