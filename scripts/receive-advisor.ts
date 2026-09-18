// Receive an advisor answer from a live ChatGPT web session.
//
// ChatGPT web has no push. But the operator's Chrome is local, and once it runs
// with a debug port the conversation DOM is readable. This script attaches to
// the chat tab, waits until the assistant's turn stops streaming, extracts the
// final message, and writes it as the answer file the importer consumes.
//
// Usage:
//   node --experimental-strip-types scripts/receive-advisor.ts \
//     --run runs/external-002 \
//     [--url https://chatgpt.com/g/g-.../c/...] [--port 9222] [--dump-dom]
//
// The run's transport job is the source of identity: the request id and digest
// the answer must declare are read from it, never from this file. Capturing is
// not accepting -- the candidate is recorded against the job and verified by
// the transport layer, which refuses a mismatch rather than importing it.

const argv = process.argv.slice(2);
const arg = (n: string): string | undefined => {
  const i = argv.indexOf(n);
  return i > -1 && i + 1 < argv.length ? argv[i + 1] : undefined;
};

const runRoot = arg("--run") ?? arg("--out")?.replace(/[/\\]answer\.txt$/, "");
const out = arg("--out") ?? (runRoot ? join(runRoot, "answer.txt") : undefined);
const wantUrl = arg("--url");
const port = Number(arg("--port") ?? "9222");
const dumpDom = argv.includes("--dump-dom");
const quiet = Number(arg("--stable") ?? "3"); // consecutive identical polls
const intervalMs = Number(arg("--interval") ?? "2000");

if (!runRoot || !out) {
  console.error(
    "usage: receive-advisor.ts --run <run-root> [--out <file>] [--url <chat-url>] [--port 9222] [--dump-dom]",
  );
  process.exit(2);
}

import {
  readTransportJob,
  markWaiting,
  recordCandidate,
  verifyCandidate,
} from "../packages/controller/src/transport.ts";
import { join } from "node:path";

// ---------------------------------------------------------------- CDP client

interface Cdp {
  send: (method: string, params?: object) => Promise<unknown>;
  close: () => void;
}

async function connect(wsUrl: string): Promise<Cdp> {
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("websocket to the debug target failed"));
  });
  let next = 0;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data as string) as { id?: number; result?: unknown; error?: { message?: string } };
    if (msg.id === undefined) return;
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message ?? "cdp error"));
    else p.resolve(msg.result);
  };
  return {
    send: (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = ++next;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      }),
    close: () => ws.close(),
  };
}

// ------------------------------------------------------- extraction + status

// Runs inside the page. Returns diagnostics alongside the text, so a DOM change
// that breaks selection is visible in the output rather than silently empty.
const EXTRACT = `
(() => {
  const out = { text: "", generating: false, assistantCount: 0, strategy: "", notes: [] };
  const roles = document.querySelectorAll('[data-message-author-role="assistant"]');
  out.assistantCount = roles.length;
  let el = null;
  if (roles.length) el = roles[roles.length - 1];
  if (!el) {
    const arts = document.querySelectorAll('article');
    out.notes.push('articles=' + arts.length);
    if (arts.length) el = arts[arts.length - 1];
  }
  if (el) {
    // Prefer the prose container so chrome text (copy buttons, citations) is
    // excluded. Fall back to the whole turn if the container is absent.
    const prose = el.querySelector('.markdown, .prose, [class*="markdown"]');
    out.text = (prose ? prose : el).textContent || "";
    out.strategy = prose ? 'prose-in-turn' : 'whole-turn';
  }
  const stop = document.querySelector('button[aria-label*="Stop"], [data-testid="stop-button"]');
  out.generating = !!stop;
  return out;
})()
`;

async function evaluate<T>(cdp: Cdp, expression: string): Promise<T> {
  const res = (await cdp.send("Runtime.evaluate", { expression, returnByValue: true })) as {
    result?: { value?: T };
    exceptionDetails?: { text?: string };
  };
  if (res.exceptionDetails) throw new Error(`page evaluation failed: ${res.exceptionDetails.text}`);
  // returnByValue already deserialises the result; it is not a JSON string.
  return (res.result?.value ?? ("" as unknown as T));
}

// ------------------------------------------------------------------- main

async function main(): Promise<void> {
  // The job carries the identity this run expects. It was created at export
  // time, before any answer could exist to influence it, and it is the only
  // source of the request id and digest checked below.
  const job = await readTransportJob(runRoot);
  if (!job) {
    console.error(
      `no transport job at ${join(runRoot, "transport")}; prepare and export the request first`,
    );
    process.exit(1);
  }
  if (job.status === "imported" || job.status === "refused") {
    console.error(`the transport job for this run is already ${job.status}; nothing to receive`);
    process.exit(1);
  }
  if (job.status === "submitted") {
    await markWaiting(runRoot);
  }

  const listRes = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json());
  const targets = (listRes as { type: string; url: string; webSocketDebuggerUrl: string }[]).filter(
    (t) => t.type === "page",
  );
  const match = wantUrl
    ? targets.find((t) => t.url.startsWith(wantUrl) || wantUrl.startsWith(t.url))
    : targets.find((t) => /chatgpt\.com\/(g|c|chat)\//.test(t.url));
  if (!match) {
    console.error(
      `no ChatGPT tab on port ${port}. Found: ${targets.map((t) => t.url).join(", ") || "none"}`,
    );
    process.exit(1);
  }
  console.error(`attached: ${match.url}`);

  const cdp = await connect(match.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable");

  let last = "";
  let stable = 0;
  let attempt = 0;
  for (;;) {
    attempt++;
    const parsed = await evaluate<{
      text: string;
      generating: boolean;
      assistantCount: number;
      strategy: string;
      notes: string[];
    }>(cdp, EXTRACT);
    if (typeof parsed !== "object" || parsed === null) {
      console.error(`poll ${attempt}: the page returned no object; is this a ChatGPT chat?`);
      await new Promise((r) => setTimeout(r, intervalMs));
      continue;
    }
    const text = (parsed.text || "").trim();
    if (dumpDom && attempt === 1) {
      const dom = await evaluate<string>(
        cdp,
        `(() => { const r = document.querySelectorAll('[data-message-author-role]'); return r.length + ' roles; first 200 chars: ' + ((document.querySelector('main')||document.body).textContent||'').slice(0,200); })()`,
      );
      console.error(`[dom] ${dom}`);
    }
    if (text === last && text.length > 0 && !parsed.generating) {
      stable++;
    } else {
      stable = 0;
    }
    if (attempt === 1 || attempt % 5 === 0) {
      console.error(
        `poll ${attempt}: ${parsed.assistantCount} assistant turns, strategy=${parsed.strategy}, ` +
          `${text.length} chars, generating=${parsed.generating}, stable=${stable}/${quiet}` +
          (parsed.notes.length ? `, ${parsed.notes.join(";")}` : ""),
      );
    }
    if (stable >= quiet && text.length > 0) {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(out, text, "utf8");
      console.error(`complete: wrote ${text.length} chars to ${out} (strategy=${parsed.strategy})`);

      // The candidate is recorded against the job, and verified by the transport
      // layer. A mismatch is a refusal that keeps the bytes, not a warning.
      await recordCandidate(runRoot, text, {
        assistantTurns: parsed.assistantCount,
        generating: parsed.generating,
      });
      const verified = await verifyCandidate(runRoot);
      console.error(`transport: ${verified.status}`);
      if (verified.verification) {
        for (const f of verified.verification.failures) console.error(`  failed rule: ${f}`);
      }
      cdp.close();
      if (verified.status !== "verified" && verified.status !== "imported") {
        // The answer is on record; the operator decides whether to regenerate
        // the request or accept the refusal. A refused answer is not imported.
        process.exit(1);
      }
      return;
    }
    last = text;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

main().catch((e) => {
  console.error(`receive failed: ${e.message}`);
  process.exit(1);
});
