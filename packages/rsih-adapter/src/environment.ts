/**
 * Build the environment for a worker process.
 *
 * The controller hands the worker an explicitly constructed set of variables.
 * It must never spread process.env into the worker: an episode's environment is
 * part of its identity and its reproducibility, so every variable in it is a
 * deliberate decision, not an accident of whatever shell launched the run.
 *
 * `extra` is validated against an allowlist of prefixes so that passing
 * process.env as extra fails loudly instead of silently leaking the
 * controller's own environment into the episode.
 */
const ALLOWED_EXTRA_PREFIXES = ["PI_", "RSIH_", "EVO_"] as const;

export interface ControlledEnvironmentInput {
  /** HOME for the worker. */
  home: string;
  /** PATH for the worker; normally the controller's own PATH. */
  path: string;
  /** Directory Pi reads settings and credentials from (PI_CODING_AGENT_DIR). */
  agentDir: string;
  /** Additional variables, all of which must match an allowed prefix. */
  extra?: Record<string, string>;
}

export function buildControlledEnvironment(
  input: ControlledEnvironmentInput,
): Record<string, string> {
  const rejected = Object.keys(input.extra ?? {}).filter(
    (key) => !ALLOWED_EXTRA_PREFIXES.some((prefix) => key.startsWith(prefix)),
  );
  if (rejected.length > 0) {
    throw new Error(
      `Refusing to set non-allowlisted environment variables in a worker: ${rejected.join(", ")}. ` +
        `Allowed prefixes: ${ALLOWED_EXTRA_PREFIXES.join(", ")}.`,
    );
  }

  return {
    // A worker finds its executables through PATH and nothing else.
    PATH: input.path,
    HOME: input.home,
    // Fixed locale, timezone, and terminal settings so two episodes on
    // different hosts still produce comparable artifacts.
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TZ: "UTC",
    NO_COLOR: "1",
    TERM: "dumb",
    // The agent directory carries the provider credentials the episode is
    // authorized to use; nothing else in this map does.
    PI_CODING_AGENT_DIR: input.agentDir,
    ...input.extra,
  };
}
