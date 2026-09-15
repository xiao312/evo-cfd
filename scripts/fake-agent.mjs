#!/usr/bin/env node
/**
 * A deterministic stand-in for a real agent, used to prove the trial pipeline
 * without spending a model call.
 *
 * It does what the task's intended solution looks like: reads the prompt, finds
 * the configuration key the program actually reads, corrects the configuration
 * without touching the program, and writes the report the task asks for. It is
 * mounted read-only into the agent container and is given the workspace as its
 * only argument, exactly as a real agent would find it.
 *
 * It deliberately does not read anything outside the workspace: a real agent
 * cannot either, and a prober that peeked at the evaluation package would be
 * testing a boundary that does not exist.
 *
 * Usage: node fake-agent.mjs <workspace>
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const workspace = process.argv[2];
if (typeof workspace !== "string" || workspace.length === 0) {
  console.error("usage: node fake-agent.mjs <workspace>");
  process.exit(2);
}

const prompt = await readFile(join(workspace, "..", "TASK.md"), "utf8").catch(() => "");
console.log(`fake agent: read the task (${prompt.length} characters)`);

// The program reads units_per_kit; the configuration supplies unitsPerKit.
// Correct the configuration and leave the program alone.
const configPath = join(workspace, "config.json");
const config = JSON.parse(await readFile(configPath, "utf8"));
if (!("unitsPerKit" in config) && !("units_per_kit" in config)) {
  console.error("fake agent: the configuration has neither key, nothing to correct");
  process.exit(1);
}
if ("unitsPerKit" in config) {
  config.units_per_kit = config.unitsPerKit;
  delete config.unitsPerKit;
}
await writeFile(configPath, JSON.stringify(config, null, 2));
console.log(`fake agent: config.json now sets units_per_kit=${config.units_per_kit}`);

await writeFile(
  join(workspace, "REPORT.md"),
  "The program reads `units_per_kit`, but config.json supplied `unitsPerKit`, so\n" +
    "the lookup returned undefined and the total was wrong. Renamed the key in\n" +
    "the configuration; the program is unchanged.\n",
);
console.log("fake agent: wrote REPORT.md");
