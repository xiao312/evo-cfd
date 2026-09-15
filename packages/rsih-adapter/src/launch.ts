/**
 * Build the command line that drives an RSI-Harness episode.
 *
 * EvoCFD runs RSI-Harness as a subprocess through its own CLI rather than
 * importing its internals. The plan is returned as plain data — command, args,
 * cwd, env — so it can be asserted in tests without ever spawning anything,
 * and so the exact invocation is recorded in the run digest before it happens.
 *
 * Argument layout follows RSI-Harness's own option split: the options it
 * understands itself (--genome --profile --config --cwd --max-turns --run-id)
 * are consumed by its CLI, and everything else, including --json,
 * --session-dir, --model and --no-context-files, is forwarded to Pi.
 */
import { isAbsolute, join } from "node:path";
import type { Installation } from "./installation.ts";
import type { ControlledEnvironmentInput } from "./environment.ts";
import { buildControlledEnvironment } from "./environment.ts";

export interface LaunchOptions {
  /** Absolute path to the Genome that defines this episode's harness. */
  genome: string;
  /** Absolute path to the task workspace the agent works in. */
  cwd: string;
  /** RSI-Harness run id, used to name its own artifacts. */
  runId?: string;
  /** RSI-Harness --profile, which it maps onto Pi --provider. */
  profile?: string;
  /** Pi settings/config file to load, forwarded through RSI-Harness --config. */
  config?: string;
  /** Model pattern forwarded to Pi --model. */
  model?: string;
  /** Cap on agent turns, forwarded to Pi --max-turns via RSI-Harness. */
  maxTurns?: number;
  /** Directory Pi writes the session transcript into. */
  sessionDir?: string;
  /**
   * Skip ambient context files (AGENTS.md and the like). Default true: an
   * episode's context is what the Genome and the task supply, nothing that
   * happened to be sitting in the workspace.
   */
  noContextFiles?: boolean;
  /** Extra arguments appended verbatim after everything else. */
  extraArgs?: string[];
}

export interface LaunchPlan {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

export function buildLaunchPlan(
  installation: Installation,
  environment: ControlledEnvironmentInput,
  options: LaunchOptions,
): LaunchPlan {
  for (const [name, value] of [
    ["genome", options.genome],
    ["cwd", options.cwd],
  ] as const) {
    if (!isAbsolute(value)) {
      throw new Error(`Launch option ${name} must be an absolute path, got: ${value}`);
    }
  }

  // RSI-Harness is run from source: Node 22 strips the types itself, so no
  // build step and no compiled artifacts are required to start an episode.
  const cli = join(installation.root, "src", "cli.ts");

  const args = [
    "--experimental-strip-types",
    cli,
    "--genome",
    options.genome,
    "--cwd",
    options.cwd,
    "--json",
  ];
  if (options.profile) args.push("--profile", options.profile);
  if (options.config) args.push("--config", options.config);
  if (options.maxTurns !== undefined) args.push("--max-turns", String(options.maxTurns));
  if (options.runId) args.push("--run-id", options.runId);
  if (options.sessionDir) args.push("--session-dir", options.sessionDir);
  if (options.model) args.push("--model", options.model);
  if (options.noContextFiles ?? true) args.push("--no-context-files");
  if (options.extraArgs) args.push(...options.extraArgs);

  return {
    command: "node",
    args,
    cwd: options.cwd,
    env: buildControlledEnvironment(environment),
  };
}
