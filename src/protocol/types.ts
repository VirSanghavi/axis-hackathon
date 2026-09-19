/**
 * The Axis protocol: every shape that crosses a process boundary (hub HTTP API,
 * daemon socket, MCP tool results, dashboard) is defined here and nowhere else.
 *
 * Design rules for these shapes:
 *  - Every result is a discriminated union on `status`, so a caller branches on
 *    one field and TypeScript proves every branch is handled.
 *  - A denial is never just "no". It carries who holds the target, why they
 *    took it, how fresh they are, when it frees up, and what the caller can do
 *    instead. The caller (usually an LLM agent) decides; we supply the facts.
 *  - Times are epoch milliseconds on the wire. Durations are `...Ms`.
 */

// ── Identity ────────────────────────────────────────────────────────────────

/** Who is acting. Agents are sessions; members are people; devices are machines. */
export interface AgentRef {
  id: string;
  /** Short human label, e.g. "dana/claude-code". */
  name: string;
  vendor: string;
  member: string;
  device: string;
}

export interface Agent extends AgentRef {
  status: "active" | "idle" | "offline";
  task?: string;
  startedAt: number;
  lastSeenAt: number;
}

export interface Device {
  id: string;
  member: string;
  hostname: string;
  platform: string;
  /** Strongest enforcement this machine's daemon can apply. */
  tier: EnforcementTier;
  lastSeenAt: number;
  /** Files currently sealed on this device, as reported by its daemon. */
  sealed: string[];
  online: boolean;
  health: DeviceHealth;
}

/**
 * What a device says about its own enforcement, merged from its daemon (version,
 * orphaned files) and its last `axis doctor` run (checks, wired agent hosts).
 * `axis doctor --team` reads every device's health from the hub.
 */
export interface DeviceHealth {
  version?: string;
  /** Locked files that vanished on this device with no rename to explain it. */
  orphaned?: string[];
  /** Agent hosts wired on this device (claude-code, cursor, codex, ...). */
  hosts?: string[];
  checks?: { name: string; ok: boolean; detail: string }[];
  checkedAt?: number;
}

/**
 * How hard a lock is on a given machine.
 *  - off:    advisory only. Nothing stops a raw write.
 *  - guard:  user-level seal (macOS `chflags uchg`, Linux chmod a-w).
 *            Blocks writes, renames and deletes from every tool that does not
 *            deliberately strip the flag.
 *  - kernel: root-owned seal (macOS `chflags schg`, Linux `chattr +i`). No
 *            process without root can write, rename, delete, or unseal the file.
 */
export type EnforcementTier = "off" | "guard" | "kernel";

// ── Targets ─────────────────────────────────────────────────────────────────

/**
 * A lockable unit: a whole file (`symbol === ""`) or one symbol inside it.
 * Wire form is `path#Qualified.symbol`, e.g. `src/auth.ts#AuthService.login`.
 */
export interface Target {
  path: string;
  symbol: string;
}

/** How a held lock relates to the target someone asked for. */
export type Relation =
  | "same" //      they hold exactly what you asked for
  | "encloses" //  they hold something containing your target (the file, or the class around your method)
  | "within"; //   they hold something inside your target (you asked for the file, they hold one function)

// ── Locks ───────────────────────────────────────────────────────────────────

export interface Lock {
  id: string;
  path: string;
  symbol: string;
  agent: AgentRef;
  /** Why the holder took the lock. Required on acquire; shown to every blocked agent. */
  intent: string;
  jobId?: string;
  acquiredAt: number;
  /** Lease end. Renewed by holder activity; a crashed holder's lock simply lapses. */
  expiresAt: number;
}

export interface Conflict {
  /** The target you asked for, wire form. */
  target: string;
  lock: Lock;
  relation: Relation;
}

/** Facts about a holder that let a blocked agent decide whether to wait. */
export interface HolderFacts {
  agent: AgentRef;
  /** ms since the holder last did anything through Axis. */
  idleMs: number;
  /** ms the holder has held this lock. */
  heldMs: number;
  /** ms until the lease lapses if the holder goes quiet. */
  expiresInMs: number;
  online: boolean;
  job?: { id: string; title: string; status: JobStatus };
  /** Agents already queued (FIFO) behind this lock. */
  queue: number;
}

export type AdviceAction = "wait" | "work_elsewhere" | "take_over";

export interface Advice {
  action: AdviceAction;
  /** One sentence, written for the agent, grounded in the facts above. */
  why: string;
  /** Upper bound on how long `wait` could block before the lease lapses on its own. */
  maxWaitMs: number;
}

export type AcquireResult =
  | {
      status: "granted";
      locks: Lock[];
      /** targets you already held; lease renewed */ renewed: string[];
    }
  | {
      status: "denied";
      conflicts: Conflict[];
      holders: HolderFacts[];
      advice: Advice;
      /** Open, claimable jobs: the "work elsewhere" option made concrete. */
      openJobs: JobSummary[];
    }
  | { status: "invalid"; errors: TargetError[] };

export interface TargetError {
  target: string;
  code: "not_a_file" | "outside_project" | "bad_symbol" | "empty";
  message: string;
}

export type ReleaseResult = { status: "released"; released: string[]; notHeld: string[] };

export type WaitResult =
  | { status: "granted"; locks: Lock[]; waitedMs: number }
  | { status: "free"; waitedMs: number }
  | {
      status: "timeout";
      waitedMs: number;
      conflicts: Conflict[];
      holders: HolderFacts[];
      advice: Advice;
    };

// ── Jobs ────────────────────────────────────────────────────────────────────

export type JobStatus = "todo" | "in_progress" | "done" | "cancelled";
export type Priority = "low" | "medium" | "high" | "critical";

export interface Job {
  id: string;
  title: string;
  description: string;
  priority: Priority;
  status: JobStatus;
  dependencies: string[];
  assignee?: AgentRef;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  outcome?: string;
}

export interface JobSummary {
  id: string;
  title: string;
  priority: Priority;
}

export type ClaimResult =
  | { status: "claimed"; job: Job }
  | {
      status: "none";
      reason: "empty" | "blocked";
      blocked: { id: string; title: string; waitingOn: string[] }[];
    }
  | { status: "unavailable"; job: Job; reason: "taken" | "blocked" | "closed" };

// ── Events (the live feed; dashboard + daemons + ambient team updates) ──────

export type EventType =
  | "agent.joined"
  | "agent.left"
  | "lock.granted"
  | "lock.released"
  | "lock.expired"
  | "lock.denied"
  | "lock.forced"
  | "lock.renamed"
  | "lock.moved"
  | "lock.orphaned"
  | "lock.queued"
  | "job.posted"
  | "job.claimed"
  | "job.done"
  | "job.released"
  | "job.cancelled"
  | "note"
  | "soul.updated"
  | "write.applied"
  | "write.blocked"
  | "device.report";

export interface AxisEvent {
  seq: number;
  ts: number;
  type: EventType;
  agent?: AgentRef;
  /** Human-readable one-liner, so every consumer renders the same sentence. */
  text: string;
  data: Record<string, unknown>;
}

// ── Snapshot (dashboard + `axis status`) ────────────────────────────────────

export interface ProjectSnapshot {
  project: { id: string; name: string };
  agents: Agent[];
  devices: Device[];
  locks: Lock[];
  jobs: Job[];
  events: AxisEvent[];
  serverTime: number;
}

// ── Writes through the enforcement gateway ─────────────────────────────────

export type WriteResult =
  | {
      status: "applied";
      path: string;
      /** Content hash after the write; pass back as `baseHash` on the next full write. */
      hash: string;
      /** Locks Axis took for you to authorize this write. */
      autoLocked: string[];
      /** True when your change was 3-way merged with a teammate's concurrent change. */
      merged: boolean;
      /** Symbols your change touched. */
      touched: string[];
    }
  | { status: "denied"; path: string; acquire: Extract<AcquireResult, { status: "denied" }> }
  | {
      status: "conflict";
      path: string;
      /** Where the merge could not be resolved, 1-based line numbers in current content. */
      lines: number[];
      currentHash: string;
      message: string;
    }
  | {
      status: "error";
      path: string;
      code: "not_found" | "no_match" | "ambiguous" | "parse" | "io" | "no_symbol";
      message: string;
    };
