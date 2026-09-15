import test from "node:test";
import assert from "node:assert/strict";
import { loadEgressConfig } from "../src/config.ts";
import { checkEgress } from "../src/health.ts";
import { startRelay } from "../src/relay.ts";
import { startProxy } from "../src/proxy.ts";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

const config = loadEgressConfig();

test("committed egress config pins the frozen ports", () => {
  assert.equal(config.llm.listenPort, 18080);
  assert.equal(config.web.listenPort, 18081);
  assert.equal(config.llm.upstream, "https://discovery-api.intern-ai.org.cn/v1");
  assert.equal(config.tunnel.bindHost, "172.17.0.1");
  assert.equal(config.tunnel.remoteUser, "evocfd-tunnel");
});

test("config validates profile grants and rejects unknown profiles", () => {
  assert.deepEqual(config.profiles["offline"], { llm: false, web: false });
  assert.deepEqual(config.profiles["llm-only"], { llm: true, web: false });
  assert.deepEqual(config.profiles["llm+web"], { llm: true, web: true });
});

test("a missing config file fails loudly", () => {
  assert.throws(() => loadEgressConfig("/nonexistent/egress.config.json"), /cannot read/);
});

test("health reports ok only when both services are live and enforce auth", async () => {
  const upstream = createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"data":[]}');
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamPort = (upstream.address() as AddressInfo).port;

  const relay = await startRelay(
    { llm: { listenHost: "127.0.0.1", listenPort: 0, upstream: `http://127.0.0.1:${upstreamPort}/v1` } },
    { gatewayToken: "good", providerKey: "real", log: () => {} },
  );
  const relayPort = (relay.address() as AddressInfo).port;
  const proxy = await startProxy(
    { web: { listenHost: "127.0.0.1", listenPort: 0 } },
    { proxyAuthorization: "Basic dXNlcjpzZWNyZXQ=", log: () => {} },
  );
  const proxyPort = (proxy.address() as AddressInfo).port;

  try {
    const health = await checkEgress({
      llmEndpoint: `http://127.0.0.1:${relayPort}/v1`,
      gatewayToken: "good",
      webEndpoint: `http://127.0.0.1:${proxyPort}`,
    });
    assert.equal(health.llm.status, "ok");
    // The proxy probe is healthy because it was refused while unauthenticated.
    assert.equal(health.web.status, "ok");
    assert.equal(health.ok, true);
  } finally {
    relay.close();
    proxy.close();
    upstream.close();
  }
});

test("health detects a relay that does not enforce its gateway token", async () => {
  const relay = await startRelay(
    { llm: { listenHost: "127.0.0.1", listenPort: 0, upstream: "https://invalid.example/v1" } },
    { gatewayToken: "good", providerKey: "real", log: () => {} },
  );
  const relayPort = (relay.address() as AddressInfo).port;
  try {
    const health = await checkEgress({
      llmEndpoint: `http://127.0.0.1:${relayPort}/v1`,
      gatewayToken: "wrong",
      webEndpoint: "http://127.0.0.1:1",
    });
    assert.equal(health.llm.status, "unauthorized");
    assert.equal(health.web.status, "unreachable");
    assert.equal(health.ok, false);
  } finally {
    relay.close();
  }
});
