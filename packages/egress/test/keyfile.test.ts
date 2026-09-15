import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { readProviderKey } from "../src/serve.ts";

/**
 * The launcher hands the provider key over as a file plus a provider name, so
 * the batch layer never has to quote a script or spawn node itself. This pins
 * that contract: a plain JSON string and a nested {type, key} entry both work,
 * and anything missing yields nothing rather than a crash.
 */

test("reads a flat api_key value from a named entry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "egress-key-"));
  try {
    await writeFile(join(dir, "auth.json"), JSON.stringify({ "some-provider": "plain-value" }));
    assert.equal(
      await readProviderKey({ file: join(dir, "auth.json"), name: "some-provider" }),
      "plain-value",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("reads the key nested under an object entry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "egress-key-"));
  try {
    await writeFile(
      join(dir, "auth.json"),
      JSON.stringify({ "some-provider": { type: "api_key", key: "nested-value" } }),
    );
    assert.equal(
      await readProviderKey({ file: join(dir, "auth.json"), name: "some-provider" }),
      "nested-value",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("returns nothing for an absent provider or an unreadable file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "egress-key-"));
  try {
    await writeFile(join(dir, "auth.json"), JSON.stringify({ other: "value" }));
    assert.equal(await readProviderKey({ file: join(dir, "auth.json"), name: "missing" }), undefined);
    assert.equal(await readProviderKey({ file: join(dir, "nope.json"), name: "other" }), undefined);
    await mkdir(join(dir, "empty"));
    assert.equal(await readProviderKey({ file: join(dir, "empty"), name: "other" }), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("falls back to the environment when no override is given", async () => {
  const dir = await mkdtemp(join(tmpdir(), "egress-key-"));
  const previousFile = process.env["EVOCFD_KEY_FILE"];
  const previousName = process.env["EVOCFD_KEY_NAME"];
  try {
    await writeFile(join(dir, "auth.json"), JSON.stringify({ relay: "env-value" }));
    process.env["EVOCFD_KEY_FILE"] = join(dir, "auth.json");
    process.env["EVOCFD_KEY_NAME"] = "relay";
    assert.equal(await readProviderKey(), "env-value");
  } finally {
    if (previousFile === undefined) delete process.env["EVOCFD_KEY_FILE"];
    else process.env["EVOCFD_KEY_FILE"] = previousFile;
    if (previousName === undefined) delete process.env["EVOCFD_KEY_NAME"];
    else process.env["EVOCFD_KEY_NAME"] = previousName;
    await rm(dir, { recursive: true, force: true });
  }
});
