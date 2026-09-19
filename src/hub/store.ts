import type {
  Agent,
  AgentRef,
  AxisEvent,
  Conflict,
  Device,
  DeviceHealth,
  EnforcementTier,
  EventType,
  Job,
  Lock,
  Priority,
  Target,
} from "../protocol/types.ts";

/** Who a bearer token belongs to. Members are people/devices; agents are sessions. */
export interface Principal {
  kind: "member" | "agent";
  projectId: string;
  projectName: string;
  memberId: string;
  memberName: string;
  agent?: AgentRef;
}

export interface NewProject {
  project: { id: string; name: string };
  memberToken: string;
  invite: string;
}

export interface AcquireOutcome {
  granted: Lock[];
  renewed: Lock[];
  conflicts: Conflict[];
}

/** A queued wait the queue served while its agent was not there to collect it. */
export interface Handoff {
  targets: Target[];
  intent: string;
  outcome: { status: "granted"; locks: Lock[]; renewed: Lock[] } | { status: "free" };
}

export type ClaimOutcome =
  | { kind: "claimed"; job: Job }
  | { kind: "none"; blocked: { id: string; title: string; waitingOn: string[] }[] }
  | { kind: "unavailable"; job: Job; reason: "taken" | "blocked" | "closed" }
  | { kind: "missing" };

/**
 * The persistence boundary. Every method that mutates coordination state is a
 * single atomic unit: two agents racing through `acquire` or `claimNext` can
 * never both win. The SQLite store gets that from one-writer transactions; a
 * Postgres store gets it from row locks. Nothing above this interface has to
 * think about races.
 */
export interface Store {
  // projects + auth
  createProject(name: string, memberName: string): Promise<NewProject>;
  join(
    invite: string,
    memberName: string
  ): Promise<{ projectId: string; projectName: string; memberToken: string } | null>;
  rotateInvite(projectId: string): Promise<string>;
  getInvite(projectId: string): Promise<string | null>;
  authenticate(token: string): Promise<Principal | null>;

  // agents
  startAgent(
    p: Principal,
    input: { name: string; vendor: string; device: string; task?: string }
  ): Promise<{ agent: AgentRef; token: string }>;
  /** Record activity. Renews the agent's lock leases to now + leaseMs. */
  touchAgent(agentId: string, now: number, leaseMs: number, task?: string): Promise<void>;
  /** Session ended cleanly: release everything it held. */
  endAgent(agentId: string): Promise<Lock[]>;
  listAgents(projectId: string): Promise<Agent[]>;
  getAgent(agentId: string): Promise<Agent | null>;

  // locks
  acquire(
    projectId: string,
    agent: AgentRef,
    targets: Target[],
    intent: string,
    jobId: string | undefined,
    leaseMs: number,
    now: number
  ): Promise<AcquireOutcome>;
  release(projectId: string, agentId: string, targets: Target[] | "all"): Promise<Lock[]>;
  forceRelease(projectId: string, targets: Target[]): Promise<Lock[]>;
  /** Delete lapsed leases in every project; returns what was removed so callers can announce it. */
  expireAll(now: number): Promise<{ projectId: string; lock: Lock }[]>;
  listLocks(projectId: string): Promise<Lock[]>;
  locksOf(agentId: string): Promise<Lock[]>;
  /**
   * The holder renamed a symbol it had locked: carry the lock to the new name, or
   * drop the old one if it already holds the new name. False if someone else holds it.
   */
  renameLock(
    projectId: string,
    agentId: string,
    path: string,
    from: string,
    to: string
  ): Promise<boolean>;
  /** A file moved: every lock (anyone's) and queued wait on `from` now points at `to`. */
  moveLocks(projectId: string, from: string, to: string): Promise<Lock[]>;

  // wait queue (durable, so FIFO holds across hub instances)
  enqueueWaiter(
    projectId: string,
    agent: AgentRef,
    targets: Target[],
    opts: { acquire: boolean; intent: string; jobId?: string; deadline: number; leaseMs: number }
  ): Promise<string>;
  /**
   * Collect this waiter's hand-off if the queue has served it. Every transaction
   * that frees a lock serves the queue (oldest first) before it commits, so the
   * next in line owns a freed target before any newcomer can see it free.
   * Returns null while the waiter must keep waiting.
   */
  tryWaiter(
    waiterId: string,
    now: number
  ): Promise<
    | { status: "granted"; locks: Lock[]; renewed: Lock[] }
    | { status: "free" }
    | { status: "gone" }
    | null
  >;
  /** Leave the queue. Returns a hand-off that landed after the last check, so it is never stranded. */
  dropWaiter(
    waiterId: string
  ): Promise<{ status: "granted"; locks: Lock[]; renewed: Lock[] } | { status: "free" } | null>;
  /**
   * Hand-offs the queue made to this agent that no waiting call collected (a deferred
   * wait, or a wait whose call died): returned once, then forgotten.
   */
  collectServed(agentId: string): Promise<Handoff[]>;
  /**
   * Adaptive leases: a lock whose holder has been idle `idleMs` while someone else
   * waits for it lapses now, not at the end of its full lease.
   */
  expireContended(now: number, idleMs: number): Promise<{ projectId: string; lock: Lock }[]>;
  /** Waiters (from agents other than `exceptAgentId`) queued on something overlapping `target`. */
  queueDepth(
    projectId: string,
    target: Target,
    exceptAgentId: string,
    now: number
  ): Promise<number>;

  // jobs
  postJob(
    projectId: string,
    by: string,
    input: { title: string; description: string; priority: Priority; dependencies: string[] }
  ): Promise<Job>;
  claimNext(projectId: string, agent: AgentRef, now: number): Promise<ClaimOutcome>;
  claim(projectId: string, agent: AgentRef, jobId: string, now: number): Promise<ClaimOutcome>;
  completeJob(
    projectId: string,
    agentId: string,
    jobId: string,
    outcome: string,
    now: number
  ): Promise<{ job: Job; released: Lock[] } | { error: string }>;
  releaseJob(projectId: string, jobId: string, now: number): Promise<Job | null>;
  cancelJob(projectId: string, jobId: string, reason: string, now: number): Promise<Job | null>;
  listJobs(projectId: string, includeClosed: boolean): Promise<Job[]>;
  getJob(projectId: string, jobId: string): Promise<Job | null>;

  // devices
  reportDevice(
    p: Principal,
    input: {
      deviceId: string;
      hostname: string;
      platform: string;
      tier: EnforcementTier;
      sealed: string[];
      health?: DeviceHealth;
    },
    now: number
  ): Promise<void>;
  listDevices(projectId: string, now: number): Promise<Device[]>;

  // events
  appendEvent(
    projectId: string,
    type: EventType,
    text: string,
    agent: AgentRef | undefined,
    data: Record<string, unknown>,
    now: number
  ): Promise<AxisEvent>;
  /** The newest `limit` events after `sinceSeq`, oldest first. `(0, 1)` is the latest event. */
  listEvents(projectId: string, sinceSeq: number, limit: number): Promise<AxisEvent[]>;

  // soul (project context + conventions, shared by every agent)
  getSoul(projectId: string): Promise<{ context: string; conventions: string }>;
  setSoul(projectId: string, soul: { context?: string; conventions?: string }): Promise<void>;

  close(): void;
}
