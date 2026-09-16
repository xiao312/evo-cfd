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
import { dirname, isAbsolute, join, relative, sep } from "node:path";

/**
 * Host paths are consumed by the host's Docker daemon, which is a Linux
 * process, so a bind-mount source is always a POSIX path — even when the
 * launch plan is built on a machine that edits the repository on Windows.
 */
function toPosixHost(host: string): string {
  return sep === "\\" ? host.split("\\").join("/") : host;
}

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

/**
 * The invariant a `denied` list must hold: nothing in it may be a path the
 * mounts make visible. `denied` drives verification probes, so an entry the
 * container can actually reach would assert a boundary that does not exist —
 * and would do it in the direction that hides the problem, with the probe
 * passing on a path it was meant to prove unreachable. This is the check that
 * makes the contradiction impossible to express rather than merely easy to
 * spot.
 */
export function assertDeniedUnreachable(launch: AgentContainerLaunch): void {
  for (const denied of launch.denied) {
    if (isMounted(launch, denied)) {
      throw new Error(
        `the denied path ${denied} is mounted into the container, so it is not denied; ` +
          "the mount list and the denied list contradict each other",
      );
    }
  }
}

export const TASK_PATH = "/task";
const WORKSPACE_PATH = "/task/workspace";
export const RSIH_PATH = "/rsih";
export const AGENT_STATE_PATH = "/agent-state";
const AGENT_RUNTIME_PATH = "/agent-runtime";
export const GENOME_PATH = "/genome";

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
      host: toPosixHost(join(spec.trialRoot, "agent")),
      container: TASK_PATH,
      mode: "ro",
      reason: "the prompt and workspace, read-only at the top level",
    },
    {
      host: toPosixHost(join(spec.trialRoot, "agent", "workspace")),
      container: WORKSPACE_PATH,
      mode: "rw",
      reason: "the only place the agent may change",
    },
    {
      host: toPosixHost(spec.rsihDir),
      container: RSIH_PATH,
      mode: "ro",
      reason: "the harness runtime the agent may execute",
    },
    {
      host: toPosixHost(spec.agentStateDir),
      container: AGENT_STATE_PATH,
      mode: "rw",
      reason: "the agent's session directory, writable, outside the task",
    },
  ];
  if (spec.agentRuntimeDir) {
    mounts.push({
      host: toPosixHost(spec.agentRuntimeDir),
      container: AGENT_RUNTIME_PATH,
      mode: "ro",
      reason: "the agent runtime the worker executes",
    });
  }
  if (spec.genomeDir) {
    mounts.push({
      host: toPosixHost(spec.genomeDir),
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

  return (() => {
    const launch: AgentContainerLaunch = {
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
    assertDeniedUnreachable(launch);
    return launch;
  })();
}

/**
 * True if a host path is visible inside the container at all. Anything not
 * mounted is unreachable, which is the whole of the boundary.
 */
export function isMounted(launch: AgentContainerLaunch, hostPath: string): boolean {
  const query = toPosixHost(hostPath);
  return launch.mounts.some((mount) => {
    const rel = relative(mount.host, query);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
}

/** Paths a proposer container needs, all absolute and host-side. */
export interface ProposerSpec {
  /** Absolute host path of the proposal run, e.g. runs/proposal-001. */
  runRoot: string;
  /** Absolute host path of the RSI-Harness runtime the proposer executes. */
  rsihDir: string;
  /** Absolute host path of a writable directory for the proposer's session. */
  agentStateDir: string;
  /** Absolute host path of the proposer's own Genome bundle, mounted read-only. */
  genomeDir: string;
  uid: number;
  gid: number;
  tmpfsSizeMb?: number;
  extraHosts?: string[];
}

const PROPOSAL_INPUT_PATH = "/proposal-input";
const PROPOSAL_OUTPUT_PATH = "/output";

/**
 * Build the launch arguments for a proposer container.
 *
 * The boundary is the same idea as a trial's, with two differences that follow
 * from what a proposer is for. It reads recorded evidence instead of a task
 * workspace, and its only writable path is the output directory, so the one
 * thing it can produce is the one file it is allowed to write.
 *
 * Pure, like `buildAgentContainer`: the same spec yields the same command, so
 * the boundary is testable without running anything.
 */
export function buildProposerContainer(spec: ProposerSpec, image: string): AgentContainerLaunch {
  for (const [name, value] of [
    ["runRoot", spec.runRoot],
    ["rsihDir", spec.rsihDir],
    ["agentStateDir", spec.agentStateDir],
    ["genomeDir", spec.genomeDir],
  ] as const) {
    if (!isAbsolute(value))
      throw new Error(`ProposerSpec.${name} must be an absolute path, got: ${value}`);
  }
  if (spec.uid === 0 || spec.gid === 0) {
    throw new Error("the proposer container must not run as root");
  }

  const mounts: MountEntry[] = [
    {
      host: toPosixHost(join(spec.runRoot, "agent")),
      container: TASK_PATH,
      mode: "ro",
      reason: "the proposer's prompt, read-only",
    },
    {
      host: toPosixHost(join(spec.runRoot, "private", "proposal-input")),
      container: PROPOSAL_INPUT_PATH,
      mode: "ro",
      reason: "recorded evidence and the read-only parent Genome",
    },
    {
      host: toPosixHost(join(spec.runRoot, "private", "output")),
      container: PROPOSAL_OUTPUT_PATH,
      mode: "rw",
      reason: "the only place the proposer may write: its proposal",
    },
    {
      host: toPosixHost(spec.rsihDir),
      container: RSIH_PATH,
      mode: "ro",
      reason: "the harness runtime the proposer executes",
    },
    {
      host: toPosixHost(spec.agentStateDir),
      container: AGENT_STATE_PATH,
      mode: "rw",
      reason: "the proposer's session directory, outside the evidence",
    },
    {
      host: toPosixHost(spec.genomeDir),
      container: GENOME_PATH,
      mode: "ro",
      reason: "the proposer's own Genome, never the one it reviews",
    },
  ];

  const args = [
    "--rm",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    `--user=${spec.uid}:${spec.gid}`,
    "--read-only",
    `--tmpfs=/tmp:rw,size=${spec.tmpfsSizeMb ?? 64}m,exec`,
    ...mounts.flatMap((mount) => ["-v", `${mount.host}:${mount.container}:${mount.mode}`]),
    ...(spec.extraHosts ?? []).flatMap((host) => ["--add-host", host]),
    "-w",
    PROPOSAL_OUTPUT_PATH,
    image,
  ];

  return (() => {
    const launch: AgentContainerLaunch = {
      image,
      args,
      mounts,
      // The proposer must not reach: the evaluator source of the trials it
      // reads about, the staging area where candidates are built, or another
      // proposal's output. Its own output directory is deliberately absent —
      // it is mounted rw and is the only place the proposer may write, so
      // listing it here would contradict the mount list, and the invariant
      // check below now refuses such a launch rather than recording it.
      denied: [
        join(spec.runRoot, "private", "evaluator"),
        join(spec.runRoot, "private", "staging"),
        join(dirname(spec.runRoot), "proposal-000"),
        spec.runRoot,
      ],
    };
    assertDeniedUnreachable(launch);
    return launch;
  })();
}
