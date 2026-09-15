import { test } from "node:test";
import assert from "node:assert/strict";
import { buildControlledEnvironment } from "../src/index.ts";

const base = {
  home: "/home/worker",
  path: "/usr/local/bin:/usr/bin:/bin",
  agentDir: "/state/agent",
};

test("sets exactly the controlled variables, nothing inherited", () => {
  const env = buildControlledEnvironment(base);
  assert.deepEqual(Object.keys(env).sort(), [
    "HOME",
    "LANG",
    "LC_ALL",
    "NO_COLOR",
    "PATH",
    "PI_CODING_AGENT_DIR",
    "TERM",
    "TZ",
  ]);
  assert.equal(env.PATH, base.path);
  assert.equal(env.HOME, base.home);
  assert.equal(env.PI_CODING_AGENT_DIR, base.agentDir);
});

test("pins locale, timezone, and terminal settings", () => {
  const env = buildControlledEnvironment(base);
  assert.equal(env.LANG, "C.UTF-8");
  assert.equal(env.LC_ALL, "C.UTF-8");
  assert.equal(env.TZ, "UTC");
  assert.equal(env.NO_COLOR, "1");
  assert.equal(env.TERM, "dumb");
});

test("does not inherit the controller environment", () => {
  // A variable present in the controller but not allowlisted must not leak in,
  // even if it looks relevant.
  const env = buildControlledEnvironment(base);
  assert.equal("PI_API_KEY" in env, false);
  assert.equal("SECRET" in env, false);
});

test("accepts allowlisted extra variables", () => {
  const env = buildControlledEnvironment({
    ...base,
    extra: { PI_MODEL: "test-model", RSIH_FOO: "1", EVO_TRIAL: "t-1" },
  });
  assert.equal(env.PI_MODEL, "test-model");
  assert.equal(env.RSIH_FOO, "1");
  assert.equal(env.EVO_TRIAL, "t-1");
});

test("refuses non-allowlisted extra variables", () => {
  assert.throws(
    () => buildControlledEnvironment({ ...base, extra: { AWS_SECRET_KEY: "leak" } }),
    /Refusing to set non-allowlisted environment variables.*AWS_SECRET_KEY/,
  );
  // Lowercase variants are not exempt either.
  assert.throws(
    () => buildControlledEnvironment({ ...base, extra: { token: "leak" } }),
    /Refusing to set non-allowlisted environment variables.*token/,
  );
});

test("an explicit extra PI_ variable may override a controlled one", () => {
  // Deliberate overrides are how an episode is authorized for a specific
  // provider; the controller says so explicitly rather than inheriting it.
  const env = buildControlledEnvironment({
    ...base,
    extra: { PI_CODING_AGENT_DIR: "/state/other-agent" },
  });
  assert.equal(env.PI_CODING_AGENT_DIR, "/state/other-agent");
});
