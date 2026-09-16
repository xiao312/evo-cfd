/**
 * CFD job lifecycle.
 *
 * A CFD job is not an agent episode. An episode is a bounded conversation that
 * ends when the model stops; a solver run may outlive the agent that launched
 * it, outlive the controller process that recorded it, and outlive an ssh
 * session. The two need different primitives, and conflating them is how a job
 * ends up unkillable and unaccountable.
 *
 * The contract here is deliberately small and deliberately host-side. The
 * controller records a plan, the plan is what runs, and the state machine has
 * exactly the transitions a reviewer can check:
 *
 *   submitted -> running -> finished | failed | cancelled
 *
 * There is no "lost" state. A controller that restarts finds an existing job by
 * its persistent id, reads whatever state the executor left, and reports that.
 * A job whose container is gone is `failed` with the reason recorded, never
 * silently `running`.
 *
 * Authority sits in the controller, never in the agent. The agent may not reach
 * the docker socket: it asks for a job, and the controller decides whether and
 * how one exists. This mirrors the trial boundary — the plan is recorded before
 * anything runs, so what executed is inspectable apart from what was intended.
 *
 * Everything here is about the physical layer staying observable: which
 * executable ran, which library set it resolved, whether it reached the
 * requested physical time, and what it left behind. Numerical assessment is a
 * separate concern and lives in `assess.ts`; this module reports process facts.
 */

/**
 * A solver profile is a resolved execution contract, not a name.
 *
 * The package installs an executable named `reactingFoam` and libraries whose
 * SONAMES are identical to stock ones. A profile that records only a name
 * therefore identifies nothing: which binary and which library set actually ran
 * is decided by directory order. The fields below are the ones that make the
 * answer inspectable after the fact.
 */
export interface SolverProfile {
  /** Profile id, as in cfd-baseline/baseline.json. */
  id: string;
  /** Absolute path to the executable that must run. */
  executable: string;
  /** sha256 of that executable, recorded before the job starts. */
  executableSha256: string;
  /**
   * The environment contract that selects the library set. Sourcing this file
   * is what makes LD_LIBRARY_PATH resolve the modified rather than stock
   * libraries of the same name.
   */
  envFile: string;
  /** Library directories in resolution order, first wins. */
  libraryPaths: string[];
  /**
   * The libraries expected to resolve from the profile's own directory rather
   * than from stock. Verified after the job, because a binary that loads the
   * wrong libspecie still runs — with the wrong physics.
   */
  expectedProfileLibraries: string[];
}

/**
 * What a job is asked to do. Recorded before execution and never edited after.
 */
export interface CfdJobPlan {
  /** Persistent id. Stable across controller restarts. */
  jobId: string;
  profile: SolverProfile;
  /** Host directory containing the OpenFOAM case. */
  caseDir: string;
  /** Solver arguments, typically none or `-case`. */
  args: string[];
  /** Wall-clock budget in seconds. The job is stopped at the budget. */
  budgetSeconds: number;
  /** Requested physical end time, from the case's controlDict. */
  requestedEndTime: number;
  /** Number of MPI ranks. 1 means serial. */
  ranks: number;
  /** Where logs are written, relative to the job directory. */
  logFile: string;
}

/** Job states. The terminal ones are exactly three. */
export type JobState =
  | "submitted"
  | "running"
  | "finished"
  | "failed"
  | "cancelled";

/** A fact about a container, read back after the fact. */
export interface ContainerFacts {
  containerId: string;
  /** Command as the executor actually started it. */
  startedCommand: string;
  /** Exit code, when the container has exited. */
  exitCode: number | null;
  /** True when the container still exists and is running. */
  running: boolean;
  /** True when the container exists but has exited. */
  exited: boolean;
}

/**
 * The state of one job, as the controller can prove it.
 *
 * Every field is either recorded before execution (the plan) or read back from
 * the executor afterwards (the facts). Nothing here is a prediction or an
 * intention; if it cannot be observed, it is not recorded.
 */
export interface CfdJobState {
  jobId: string;
  state: JobState;
  /** When the plan was recorded, epoch milliseconds. */
  submittedAt: number;
  /** When execution started, if it has. */
  startedAt: number | null;
  /** When a terminal state was reached, if it has. */
  finishedAt: number | null;
  container: ContainerFacts | null;
  /** Last physical time the solver reported, read from its log. */
  lastReportedTime: number | null;
  /** True when the log ends with a normal `End`. */
  terminatedNormally: boolean;
  /** Reason a job stopped, when it was not the solver's own choice. */
  stopReason: "budget" | "cancelled" | "solver_error" | "executor_error" | null;
  /** Human-readable diagnostic, never empty for a failed job. */
  detail: string;
}

/**
 * A job is only inspectable if its state is on disk, so a restarted controller
 * reads the same record the first one wrote. This is the write-once shape.
 */
export interface CfdJobRecord {
  plan: CfdJobPlan;
  state: CfdJobState;
  /** sha256 of the plan, so the record cannot be quietly re-planned. */
  planDigest: string;
}
