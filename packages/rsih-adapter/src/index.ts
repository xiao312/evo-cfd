/**
 * Narrow integration with RSI-Harness: resolve its installation, build the
 * controlled environment for an episode, plan the CLI invocation that drives
 * it, and parse the JSONL event stream it emits.
 *
 * RSI-Harness is driven as an external process and never imported.
 */
export {
  resolveInstallation,
  resolveInstallationFromEnv,
  defaultInstallationRoot,
  InstallationNotFoundError,
  InvalidInstallationError,
  type Installation,
  type ResolveOptions,
} from "./installation.ts";
export {
  buildControlledEnvironment,
  type ControlledEnvironmentInput,
} from "./environment.ts";
export { buildLaunchPlan, type LaunchOptions, type LaunchPlan } from "./launch.ts";
export {
  parseLine,
  iterateJsonlLines,
  readJsonlStream,
  isSessionHeader,
  isEvent,
  hasType,
  isAgentSettled,
  isSessionShutdown,
  isErrorEvent,
  EVENT_TYPES,
  type JsonlEvent,
  type SessionHeader,
  type ParsedLine,
  type StreamReaderResult,
} from "./jsonl.ts";
