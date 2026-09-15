import test from "node:test";
import assert from "node:assert/strict";
import { environmentIdentity, credentialReference } from "../src/identity.ts";

test("identity is deterministic for the same inputs", () => {
  const input = {
    profile: "llm-only",
    upstream: "https://discovery-api.intern-ai.org.cn/v1",
    egressVersion: "0.0.0",
    container: "evocfd-dev:node22",
  };
  assert.equal(environmentIdentity(input), environmentIdentity({ ...input }));
});

test("identity changes when information access changes", () => {
  const base = {
    profile: "llm-only",
    upstream: "https://discovery-api.intern-ai.org.cn/v1",
    egressVersion: "0.0.0",
    container: "evocfd-dev:node22",
  };
  const offline = environmentIdentity({ ...base, profile: "offline" });
  const web = environmentIdentity({ ...base, profile: "llm+web" });
  assert.notEqual(offline, base.profile && environmentIdentity(base));
  assert.notEqual(web, environmentIdentity(base));
  assert.notEqual(offline, web);
});

test("identity is derived from the hostname, not the whole upstream url", () => {
  const base = {
    profile: "llm-only",
    upstream: "https://discovery-api.intern-ai.org.cn/v1",
    egressVersion: "0.0.0",
    container: "evocfd-dev:node22",
  };
  assert.equal(
    environmentIdentity(base),
    environmentIdentity({ ...base, upstream: "https://discovery-api.intern-ai.org.cn/v1/" }),
  );
  assert.notEqual(
    environmentIdentity(base),
    environmentIdentity({ ...base, upstream: "https://other.example.com/v1" }),
  );
});

test("credential reference names the secret instead of carrying it", () => {
  const ref = credentialReference("http://host.docker.internal:18080/v1");
  assert.deepEqual(ref, {
    endpoint: "http://host.docker.internal:18080/v1",
    credential_ref: "gateway-token:default",
  });
  assert.equal(JSON.stringify(ref).includes("evocfd-local"), false);
});
