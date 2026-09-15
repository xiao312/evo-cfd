import test from "node:test";
import assert from "node:assert/strict";
import { loadEgressConfig } from "../src/config.ts";
import { endpointsFor, grantFor, sshForwardArguments, tunnelBindings } from "../src/profiles.ts";

const config = loadEgressConfig();

test("offline grants nothing and forwards nothing", () => {
  assert.equal(grantFor(config, "offline").llm, false);
  assert.equal(grantFor(config, "offline").web, false);
  assert.deepEqual(endpointsFor(config, "offline"), { llm: null, web: null });
  assert.deepEqual([...tunnelBindings(config, "offline")], []);
  assert.deepEqual([...sshForwardArguments(config, "offline")], []);
});

test("llm-only exposes the relay only", () => {
  assert.equal(grantFor(config, "llm-only").llm, true);
  assert.equal(grantFor(config, "llm-only").web, false);
  assert.deepEqual(endpointsFor(config, "llm-only"), {
    llm: `http://host.docker.internal:${config.llm.listenPort}/v1`,
    web: null,
  });
  // The decisive property: no web binding exists, so the capability is not
  // merely unadvertised but genuinely unavailable.
  assert.deepEqual([...tunnelBindings(config, "llm-only")], [
    {
      remote: `${config.tunnel.bindHost}:${config.llm.listenPort}`,
      local: `${config.llm.listenHost}:${config.llm.listenPort}`,
    },
  ]);
});

test("llm+web exposes both services", () => {
  assert.equal(grantFor(config, "llm+web").web, true);
  const endpoints = endpointsFor(config, "llm+web");
  assert.equal(endpoints.web, `http://host.docker.internal:${config.web.listenPort}`);
  assert.equal(tunnelBindings(config, "llm+web").length, 2);
  assert.deepEqual([...sshForwardArguments(config, "llm+web")], [
    "-R",
    `${config.tunnel.bindHost}:${config.llm.listenPort}:${config.llm.listenHost}:${config.llm.listenPort}`,
    "-R",
    `${config.tunnel.bindHost}:${config.web.listenPort}:${config.web.listenHost}:${config.web.listenPort}`,
  ]);
});

test("an unknown profile is rejected rather than silently degraded", () => {
  assert.throws(() => grantFor(config, "cellular" as never), /unknown network profile/);
});
