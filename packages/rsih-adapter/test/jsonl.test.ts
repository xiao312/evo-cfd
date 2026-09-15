import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import {
  parseLine,
  iterateJsonlLines,
  readJsonlStream,
  isAgentSettled,
  isSessionShutdown,
  isErrorEvent,
  EVENT_TYPES,
} from "../src/index.ts";

const header = '{"type":"session","sessionId":"s-1","model":"Atria-Dawn-Preview"}';
const settled = '{"type":"agent_settled"}';
const toolCall = '{"type":"tool_call","toolCallId":"c-1","toolName":"bash"}';

test("parses the session header", () => {
  const parsed = parseLine(header);
  assert.equal(parsed.kind, "header");
  if (parsed.kind === "header") {
    assert.equal(parsed.header.type, "session");
    assert.equal(parsed.header.sessionId, "s-1");
  }
});

test("parses an event", () => {
  const parsed = parseLine(toolCall);
  assert.equal(parsed.kind, "event");
  if (parsed.kind === "event") {
    assert.equal(parsed.event.type, "tool_call");
    assert.equal(parsed.event.toolName, "bash");
  }
});

test("recognizes the terminal events", () => {
  assert.equal(isAgentSettled(parseLine(settled)), true);
  assert.equal(isSessionShutdown(parseLine('{"type":"session_shutdown"}')), true);
  assert.equal(isErrorEvent(parseLine('{"type":"error","message":"boom"}')), true);
  assert.equal(isAgentSettled(parseLine(toolCall)), false);
});

test("treats an object without a type as malformed", () => {
  const parsed = parseLine('{"foo":1}');
  assert.equal(parsed.kind, "malformed");
});

test("treats non-object JSON as malformed", () => {
  for (const line of ["5", '"a string"', "null", "true"]) {
    assert.equal(parseLine(line).kind, "malformed");
  }
});

test("reports invalid JSON instead of throwing", () => {
  const parsed = parseLine('{"type":"broken');
  assert.equal(parsed.kind, "malformed");
  if (parsed.kind === "malformed") {
    assert.ok(parsed.raw);
    assert.ok(parsed.error);
  }
});

test("ignores blank lines", () => {
  for (const line of ["", "  ", "\t\n"]) {
    assert.equal(parseLine(line).kind, "empty");
  }
});

test("EVENT_TYPES names match the documented stream vocabulary", () => {
  assert.equal(EVENT_TYPES.agentSettled, "agent_settled");
  assert.equal(EVENT_TYPES.toolCall, "tool_call");
  assert.equal(EVENT_TYPES.toolResult, "tool_result");
  assert.equal(EVENT_TYPES.messageEnd, "message_end");
  assert.equal(EVENT_TYPES.sessionShutdown, "session_shutdown");
});

test("buckets a complete stream, including a line split across chunks", async () => {
  // A chunk boundary in the middle of the settled event must not lose it.
  const first = header + "\n" + toolCall + '\n{"type":"agent_';
  const second = 'settled"}\n';
  const result = await readJsonlStream(Readable.from([first, second]));
  assert.equal(result.lines, 3);
  assert.equal(result.headers.length, 1);
  assert.equal(result.events.length, 2);
  assert.equal(result.events[1].type, "agent_settled");
  assert.equal(result.malformed.length, 0);
});

test("yields the final line even without a trailing newline", async () => {
  const lines = [];
  for await (const parsed of iterateJsonlLines(Readable.from([settled]))) {
    lines.push(parsed);
  }
  assert.equal(lines.length, 1);
  assert.equal(isAgentSettled(lines[0]), true);
});

test("buckets malformed lines alongside good ones", async () => {
  const result = await readJsonlStream(
    Readable.from([`${header}\n{"type":"agent_start"}\nNOT JSON\n${settled}\n`]),
  );
  assert.equal(result.events.length, 2);
  assert.equal(result.malformed.length, 1);
  assert.equal(result.malformed[0].raw, "NOT JSON");
});

test("stream state is local, so two reads do not corrupt each other", async () => {
  const [a, b] = await Promise.all([
    readJsonlStream(Readable.from([`${header}\n${settled}\n`])),
    readJsonlStream(Readable.from(['{"type":"agent_start"}\n{"type":"agent_end"}\n'])),
  ]);
  assert.equal(a.events.length, 1);
  assert.equal(b.events.length, 2);
});
