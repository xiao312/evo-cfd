import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { startRelay } from "../src/relay.ts";
import { loadEgressConfig } from "../src/config.ts";

const config = loadEgressConfig();

/** A fake provider: records what the relay forwarded and streams chunks. */
async function fakeUpstream(): Promise<{ url: string; seen: () => string[]; close: () => void }> {
  const received: string[] = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received.push(
      JSON.stringify({
        method: request.method,
        url: request.url,
        authorization: request.headers["authorization"],
        body: Buffer.concat(chunks).toString("utf8"),
      }),
    );
    response.writeHead(200, { "content-type": "application/json" });
    response.write('{"ok":true,"part":"one"}');
    await new Promise((resolve) => setTimeout(resolve, 20));
    response.write('{"ok":true,"part":"two"}');
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    seen: () => received,
    close: () => server.close(),
  };
}

async function relayPointingAt(upstream: string) {
  const server = await startRelay(
    { llm: { listenHost: "127.0.0.1", listenPort: 0, upstream } },
    { gatewayToken: "good-token", providerKey: "real-provider-key", log: () => {} },
  );
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/v1`, close: () => server.close() };
}

test("relay forwards a chat completion, injecting the provider key", async () => {
  const upstream = await fakeUpstream();
  const relay = await relayPointingAt(upstream.url);
  try {
    const response = await fetch(`${relay.url}/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer good-token", "content-type": "application/json" },
      body: '{"model":"Atria-Dawn-Preview"}',
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.equal(text, '{"ok":true,"part":"one"}{"ok":true,"part":"two"}');

    const [seen] = upstream.seen();
    const record = JSON.parse(seen);
    assert.equal(record.method, "POST");
    assert.equal(record.url, "/v1/chat/completions");
    assert.equal(record.authorization, "Bearer real-provider-key");
    assert.equal(record.body, '{"model":"Atria-Dawn-Preview"}');
  } finally {
    relay.close();
    upstream.close();
  }
});

test("relay streams the response instead of buffering it", async () => {
  const upstream = await fakeUpstream();
  const relay = await relayPointingAt(upstream.url);
  try {
    const response = await fetch(`${relay.url}/models`, {
      headers: { authorization: "Bearer good-token" },
    });
    assert.ok(response.body);
    const parts: string[] = [];
    for await (const chunk of response.body) parts.push(Buffer.from(chunk).toString("utf8"));
    assert.deepEqual(parts, ['{"ok":true,"part":"one"}', '{"ok":true,"part":"two"}']);
  } finally {
    relay.close();
    upstream.close();
  }
});

test("relay refuses a request without the gateway token", async () => {
  const upstream = await fakeUpstream();
  const relay = await relayPointingAt(upstream.url);
  try {
    const response = await fetch(`${relay.url}/models`, { headers: {} });
    assert.equal(response.status, 401);
    assert.equal(upstream.seen().length, 0, "no upstream call may be attempted");
  } finally {
    relay.close();
    upstream.close();
  }
});

test("relay refuses a wrong gateway token", async () => {
  const upstream = await fakeUpstream();
  const relay = await relayPointingAt(upstream.url);
  try {
    const response = await fetch(`${relay.url}/models`, {
      headers: { authorization: "Bearer bad-token" },
    });
    assert.equal(response.status, 401);
    assert.equal(upstream.seen().length, 0);
  } finally {
    relay.close();
    upstream.close();
  }
});

test("relay only serves the /v1/ prefix", async () => {
  const upstream = await fakeUpstream();
  const relay = await relayPointingAt(upstream.url);
  try {
    const response = await fetch(`http://127.0.0.1:${new URL(relay.url).port}/admin`, {
      headers: { authorization: "Bearer good-token" },
    });
    assert.equal(response.status, 404);
  } finally {
    relay.close();
    upstream.close();
  }
});

test("relay reports upstream failure as 502 rather than crashing", async () => {
  const relay = await relayPointingAt("http://127.0.0.1:1/v1");
  try {
    const response = await fetch(`${relay.url}/models`, {
      headers: { authorization: "Bearer good-token" },
    });
    assert.equal(response.status, 502);
  } finally {
    relay.close();
  }
});

test("relay refuses to start without its secrets", async () => {
  await assert.rejects(
    async () =>
      startRelay(
        { llm: { ...config.llm, listenPort: 0 } },
        { gatewayToken: "", providerKey: "key" },
      ),
    /gatewayToken is required/,
  );
  await assert.rejects(
    async () =>
      startRelay(
        { llm: { ...config.llm, listenPort: 0 } },
        { gatewayToken: "token", providerKey: "" },
      ),
    /providerKey is required/,
  );
});
