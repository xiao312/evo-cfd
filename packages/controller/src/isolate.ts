/**
 * Enforced agent/evaluator isolation.
 *
 * Up to now the split between an agent's workspace and the evaluation package
 * has been a structural classification: the evaluator was simply not copied
 * into the agent view, and the honesty of that depended on the agent not
 * looking. This module turns it into an authority boundary that does not
 * depend on the agent's good behaviour.
 *
 * The agent process runs in its own container and physically receives only:
 *
 *   /task/TASK.md          read-only  the prompt it is scored on
 *   /task/workspace/       read-write the only place it may change
 *   /rsih                  read-only  the harness runtime
 *   /agent-state           read-write its session directory
 *
 * It does not receive the evaluation package, the manifests, other trials, the
 * controller source, the Docker socket, or the host filesystem. The root
 * filesystem is read-only and capabilities are dropped, so the container is a
 * room with one desk on it rather than a machine the agent happens to be
 * sitting at.
 *
 * The test that matters is not "the evaluator was not copied" — that was true
 * before — but that a process running as the agent cannot open the evaluator
 * path at all.
 */
import { isAbsolute, join, relative } from "node:path";

/** What the agent is given, in host terms. All paths must be absolute. */
export interface IsolationSpec {
  /** Absolute host path of the materialized trial, e.g. runs/trial-001. */
  trialRoot: string;
  /**
   * Absolute host path of the RSI-Harness runtime the agent may execute. Not
   * part of the trial, because it is shared infrastructure, not task state.
   */
  rsihDir: string;
  /** Absolute host path of a writable directory for the agent's session. */
  agentStateDir: string;
  /**
   * Optional absolute host path of a read-only runtime the agent executes —
   * the agent runtime itself, which is shared infrastructure rather than task
   * state. Mounted at /agent-runtime.
   */
  agentRuntimeDir?: string;
  /**
   * Optional absolute host path of the Genome bundle that defines this trial's
   * harness. Mounted read-only at /genome: a harness is what the trial varies,
   * and an agent that could rewrite its own harness would invalidate the
   * comparison the trial exists to make.
   */
  genomeDir?: string;
  /** UID/GID the agent runs as. Never root. */
  uid: number;
  gid: number;
  /** Size of the writable /tmp the read-only root filesystem leaves room for. */
  tmpfsSizeMb?: number;
  /** Extra host entries, e.g. host.docker.internal:host-gateway. */
  extraHosts?: string[];
}

export interface MountEntry {
  host: string;
  container: string;
  mode: "ro" | "rw";
  /** Why this mount exists, so the generated command stays self-documenting. */
  reason: string;
}

export interface AgentContainerLaunch {
  image: string;
  /** Full argument list following `docker run`, ready to hand to a spawn. */
  args: string[];
  mounts: MountEntry[];
  /** Paths the agent must not be able to reach, for verification. */
  denied: string[];
}

const TASK_PATH = "/task";
const WORKSPACE_PATH = "/task/workspace";
const RSIH_PATH = "/rsih";
const AGENT_STATE_PATH = "/agent-state";
const AGENT_RUNTIME_PATH = "/agent-runtime";
const GENOME_PATH = "/genome";

/**
 * Build the launch arguments for an isolated agent container.
 *
 * Pure: given the same spec it produces the same command, so the boundary can
 * be tested without running anything, and the command that runs is exactly the
 * command that was tested.
 */
export function buildAgentContainer(spec: IsolationSpec, image: string): AgentContainerLaunch {
  for (const [name, value] of [
    ["trialRoot", spec.trialRoot],
    ["rsihDir", spec.rsihDir],
    ["agentStateDir", spec.agentStateDir],
  ] as const) {
    if (!isAbsolute(value)) throw new Error(`IsolationSpec.${name} must be an absolute path, got: ${value}`);
  }
  if (spec.uid === 0 || spec.gid === 0) {
    throw new Error("the agent container must not run as root");
  }

  const mounts: MountEntry[] = [
    {
      host: join(spec.trialRoot, "agent"),
      container: TASK_PATH,
      mode: "ro",
      reason: "the prompt and workspace, read-only at the top level",
    },
    {
      host: join(spec.trialRoot, "agent", "workspace"),
      container: WORKSPACE_PATH,
      mode: "rw",
      reason: "the only place the agent may change",
    },
    {
      host: spec.rsihDir,
      container: RSIH_PATH,
      mode: "ro",
      reason: "the harness runtime the agent may execute",
    },
    {
      host: spec.agentStateDir,
      container: AGENT_STATE_PATH,
      mode: "rw",
      reason: "the agent's session directory, writable, outside the task",
    },
  ];
  if (spec.agentRuntimeDir) {
    mounts.push({
      host: spec.agentRuntimeDir,
      container: AGENT_RUNTIME_PATH,
      mode: "ro",
      reason: "the agent runtime the worker executes",
    });
  }
  if (spec.genomeDir) {
    mounts.push({
      host: spec.genomeDir,
      container: GENOME_PATH,
      mode: "ro",
      reason: "the Genome bundle that defines this trial's harness",
    });
  }

  const args = [
    "--rm",
    // The agent must not escalate within its own container, and must not have
    // any Linux capability it does not need.
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    `--user=${spec.uid}:${spec.gid}`,
    // Nothing the agent writes should persist outside its mounts, and a
    // read-only root filesystem is the cheapest way to make that true.
    "--read-only",
    `--tmpfs=/tmp:rw,size=${spec.tmpfsSizeMb ?? 64}m,exec`,
    ...mounts.flatMap((mount) => ["-v", `${mount.host}:${mount.container}:${mount.mode}`]),
    ...(spec.extraHosts ?? []).flatMap((host) => ["--add-host", host]),
    "-w",
    WORKSPACE_PATH,
    image,
  ];

  return {
    image,
    args,
    mounts,
    // The paths an agent must not reach. These are recorded so a verification
    // run knows what to probe, and so the mount list above can be checked
    // against them by test.
    denied: [
      join(spec.trialRoot, "private", "evaluator"),
      join(spec.trialRoot, "private"),
      join(spec.trialRoot, "manifests"),
      spec.trialRoot,
    ],
  };
}

/**
 * True if a host path is visible inside the container at all. Anything not
 * mounted is unreachable, which is the whole of the boundary.
 */
export function isMounted(launch: AgentContainerLaunch, hostPath: string): boolean {
  return launch.mounts.some((mount) => {
    const rel = relative(mount.host, hostPath);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
}
