import { took } from "../protocol/render.ts";
import { formatTarget, parseTarget, relation } from "../protocol/target.ts";
import type {
  AcquireResult,
  Advice,
  AgentRef,
  AxisEvent,
  ClaimResult,
  Conflict,
  EventType,
  HolderFacts,
  Job,
  JobSummary,
  Lock,
  Priority,
  ProjectSnapshot,
  ReleaseResult,
  Target,
  TargetError,
  WaitResult,
} from "../protocol/types.ts";
import type { Handoff, Principal, Store } from "./store.ts";

export interface HubOptions {
  /** Lease length. Any activity by the holder pushes expiry out by this much. */
  leaseMs?: number;
  /**
   * How often lapsed leases are swept and announced. 0 disables the background
   * timer (serverless runtimes): requests then sweep via `sweepIfDue`.
   */
  sweepMs?: number;
  /** Longest a single `wait` call may block. */
  maxWaitMs?: number;
  /** How often parked waits re-check the store, to catch changes made by other hub instances. */
  pollMs?: number;
  /**
   * Adaptive leases: a holder idle this long while someone waits for its lock
   * loses the lock then, instead of at the end of its full lease.
   */
  contendedIdleMs?: number;
}

type Listener = (e: AxisEvent) => void;

export interface HotSpot {
  target: string;
  denials: number;
  waits: number;
  waitedMs: number;
  maxWaitMs: number;
  /** Times its holder lost it early for idling while others waited. */
  early: number;
  holders: string[];
}

export interface Contention {
  windowMs: number;
  totals: {
    denials: number;
    waits: number;
    waitedMs: number;
    forced: number;
    early: number;
    handoffs: number;
  };
  hot: HotSpot[];
  pairs: { blocker: string; blocked: string; count: number }[];
  holds: { count: number; medianMs: number; p90Ms: number };
}

export interface DeferResult {
  status: "queued";
  targets: string[];
  /** Agents already queued for the same targets. */
  ahead: number;
  /** Who holds them now, and why. */
  denied: Extract<AcquireResult, { status: "denied" }>;
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

const ACTIVE_MS = 2 * 60_000;

/**
 * The coordination engine. Stateless per request apart from two in-memory
 * conveniences that are safe to lose on restart: live listeners (dashboards,
 * daemons) and parked `wait` calls. Every durable fact lives in the Store.
 */
export class Hub {
  readonly leaseMs: number;
  readonly maxWaitMs: number;
  readonly contendedIdleMs: number;
  private readonly pollMs: number;
  private listeners = new Map<string, Set<Listener>>();
  private sweeper?: ReturnType<typeof setInterval>;
  private lastSweep = 0;

  constructor(
    readonly store: Store,
    opts: HubOptions = {}
  ) {
    this.leaseMs = opts.leaseMs ?? 10 * 60_000;
    this.maxWaitMs = opts.maxWaitMs ?? 120_000;
    this.pollMs = opts.pollMs ?? 500;
    this.contendedIdleMs = Math.min(opts.contendedIdleMs ?? 3 * 60_000, this.leaseMs);
    const sweepMs = opts.sweepMs ?? 2_000;
    if (sweepMs > 0) this.sweeper = setInterval(() => void this.sweep(), sweepMs);
  }

  private closed = false;

  get isClosed(): boolean {
    return this.closed;
  }

  close(): void {
    this.closed = true;
    clearInterval(this.sweeper);
    for (const set of this.parked.values()) for (const fn of [...set]) fn();
    this.store.close();
  }

  // ── events ────────────────────────────────────────────────────────────────

  subscribe(projectId: string, fn: Listener): () => void {
    let set = this.listeners.get(projectId);
    if (!set) this.listeners.set(projectId, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }

  async emit(
    projectId: string,
    type: EventType,
    text: string,
    agent: AgentRef | undefined,
    data: Record<string, unknown> = {}
  ): Promise<AxisEvent> {
    const e = await this.store.appendEvent(projectId, type, text, agent, data, Date.now());
    for (const fn of this.listeners.get(projectId) ?? []) {
      try {
        fn(e);
      } catch {
        /* a broken listener must never break the write path */
      }
    }
    this.changed(projectId);
    return e;
  }

  // ── agents ────────────────────────────────────────────────────────────────

  async startAgent(
    p: Principal,
    input: { name?: string; vendor?: string; device?: string; task?: string }
  ) {
    const vendor = clean(input.vendor) || "agent";
    const name = clean(input.name) || `${p.memberName}/${vendor}`;
    const res = await this.store.startAgent(p, {
      name,
      vendor,
      device: clean(input.device) || "unknown",
      task: input.task,
    });
    await this.emit(
      p.projectId,
      "agent.joined",
      `${name} joined from ${res.agent.device}`,
      res.agent
    );
    return res;
  }

  async touch(p: Principal, task?: string): Promise<void> {
    if (p.agent) await this.store.touchAgent(p.agent.id, Date.now(), this.leaseMs, task);
  }

  async endAgent(p: Principal): Promise<Lock[]> {
    const agent = requireAgent(p);
    const released = await this.store.endAgent(agent.id);
    await this.emit(
      p.projectId,
      "agent.left",
      `${agent.name} left${released.length ? `, releasing ${released.length} lock${s(released.length)}` : ""}`,
      agent,
      {
        released: released.map(formatTarget),
      }
    );
    return released;
  }

  // ── locks ─────────────────────────────────────────────────────────────────

  async acquire(
    p: Principal,
    rawTargets: string[],
    intent: string,
    jobId?: string
  ): Promise<AcquireResult> {
    const agent = requireAgent(p);
    const { targets, errors } = validateTargets(rawTargets);
    if (errors.length) return { status: "invalid", errors };
    if (!intent.trim())
      throw new HttpError(
        400,
        "intent is required: say why you are taking the lock, it is shown to anyone you block."
      );
    await this.touch(p);
    const now = Date.now();
    const out = await this.store.acquire(
      p.projectId,
      agent,
      targets,
      intent.trim(),
      jobId,
      this.leaseMs,
      now
    );
    if (out.conflicts.length) {
      const denied = await this.denial(p.projectId, out.conflicts, agent);
      await this.emit(
        p.projectId,
        "lock.denied",
        `${agent.name} was blocked from ${out.conflicts.map((c) => c.target).join(", ")} (held by ${[...new Set(out.conflicts.map((c) => c.lock.agent.name))].join(", ")})`,
        agent,
        {
          targets: out.conflicts.map((c) => c.target),
          holders: out.conflicts.map((c) => c.lock.agent.id),
        }
      );
      return denied;
    }
    if (out.granted.length) {
      await this.emit(
        p.projectId,
        "lock.granted",
        `${agent.name} locked ${out.granted.map(formatTarget).join(", ")}: ${intent.trim()}`,
        agent,
        {
          targets: out.granted.map(formatTarget),
          intent: intent.trim(),
          jobId,
        }
      );
    }
    return {
      status: "granted",
      locks: [...out.granted, ...out.renewed],
      renewed: out.renewed.map(formatTarget),
    };
  }

  async release(p: Principal, rawTargets: string[] | "all"): Promise<ReleaseResult> {
    const agent = requireAgent(p);
    await this.touch(p);
    const targets = rawTargets === "all" ? "all" : rawTargets.map(parseTarget);
    const released = await this.store.release(p.projectId, agent.id, targets);
    const releasedKeys = released.map(formatTarget);
    const notHeld =
      rawTargets === "all"
        ? []
        : rawTargets.filter((raw) => {
            const t = parseTarget(raw);
            return !released.some(
              (l) => l.path === t.path && (t.symbol === "" || l.symbol === t.symbol)
            );
          });
    if (released.length) {
      await this.emit(
        p.projectId,
        "lock.released",
        `${agent.name} released ${releasedKeys.join(", ")}`,
        agent,
        { targets: releasedKeys }
      );
    }
    return { status: "released", released: releasedKeys, notHeld };
  }

  async forceRelease(p: Principal, rawTargets: string[], reason: string): Promise<Lock[]> {
    if (!reason?.trim())
      throw new HttpError(400, "reason is required to break someone else's lock.");
    const targets = rawTargets.map(parseTarget);
    const broken = await this.store.forceRelease(p.projectId, targets);
    const who = p.agent?.name ?? p.memberName;
    for (const l of broken) {
      await this.emit(
        p.projectId,
        "lock.forced",
        `${who} broke ${l.agent.name}'s lock on ${formatTarget(l)}: ${reason}`,
        p.agent,
        {
          target: formatTarget(l),
          holder: l.agent.id,
          reason,
        }
      );
    }
    return broken;
  }

  /**
   * Park until every target is free (or, with `acquire`, until it is ours).
   * The queue lives in the store, so first-come-first-served holds even when
   * several hub instances serve one project. In-process releases wake waiters
   * instantly; a short poll covers releases that happened on another instance.
   */
  /**
   * Deferred hand-off: take the targets now if they are free, otherwise join the
   * queue and return at once. The queue hands them over the moment they free up,
   * and the agent is told on its next call ({@link handoffs}), so it can keep
   * working elsewhere instead of blocking in `wait`.
   */
  async defer(
    p: Principal,
    rawTargets: string[],
    intent: string,
    jobId?: string,
    holdMs = 60 * 60_000
  ): Promise<AcquireResult | DeferResult> {
    const agent = requireAgent(p);
    const now = await this.acquire(p, rawTargets, intent, jobId);
    if (now.status !== "denied") return now;
    const targets = validateTargets(rawTargets).targets;
    await this.store.enqueueWaiter(p.projectId, agent, targets, {
      acquire: true,
      intent: intent.trim(),
      jobId,
      deadline: Date.now() + Math.min(Math.max(holdMs, 60_000), 24 * 3600_000),
      leaseMs: this.leaseMs,
    });
    const ahead = Math.max(0, ...now.holders.map((h) => h.queue));
    await this.emit(
      p.projectId,
      "lock.queued",
      `${agent.name} queued for ${targets.map(formatTarget).join(", ")}${ahead ? ` behind ${ahead}` : ""}: ${intent.trim()}`,
      agent,
      { targets: targets.map(formatTarget), intent: intent.trim() }
    );
    return { status: "queued", targets: targets.map(formatTarget), ahead, denied: now };
  }

  /**
   * Locks the queue handed to this agent that no waiting call collected: deferred
   * waits, and waits whose call died before the hand-off. Returned once each.
   */
  async handoffs(p: Principal): Promise<Handoff[]> {
    if (!p.agent) return [];
    const served = await this.store.collectServed(p.agent.id);
    for (const h of served)
      if (h.outcome.status === "granted" && h.outcome.locks.length)
        await this.emit(
          p.projectId,
          "lock.granted",
          `${p.agent.name} got ${h.outcome.locks.map(formatTarget).join(", ")} from the queue: ${h.intent}`,
          p.agent,
          { targets: h.outcome.locks.map(formatTarget), intent: h.intent, handoff: true }
        );
    return served;
  }

  /**
   * Contention analytics from the event log: which targets agents fight over,
   * how long they waited, who blocks whom, and how long locks are held.
   */
  async contention(projectId: string, windowMs = 24 * 3600_000): Promise<Contention> {
    const since = Date.now() - windowMs;
    const events = (await this.store.listEvents(projectId, 0, 5000)).filter((e) => e.ts >= since);
    const names = new Map<string, string>();
    for (const e of events) if (e.agent) names.set(e.agent.id, e.agent.name);
    const hot = new Map<string, HotSpot>();
    const spot = (target: string) => {
      let h = hot.get(target);
      if (!h)
        hot.set(
          target,
          (h = { target, denials: 0, waits: 0, waitedMs: 0, maxWaitMs: 0, early: 0, holders: [] })
        );
      return h;
    };
    const pairs = new Map<string, number>();
    const open = new Map<string, number>();
    const holds: number[] = [];
    const close = (agentId: string | undefined, target: unknown, ts: number) => {
      const key = `${agentId}\0${String(target)}`;
      const at = open.get(key);
      if (at !== undefined) {
        holds.push(ts - at);
        open.delete(key);
      }
    };
    const totals = { denials: 0, waits: 0, waitedMs: 0, forced: 0, early: 0, handoffs: 0 };
    for (const e of events) {
      const d = e.data as Record<string, unknown>;
      const targets = (Array.isArray(d.targets) ? d.targets : d.target ? [d.target] : []).map(
        String
      );
      if (e.type === "lock.denied") {
        totals.denials++;
        for (const t of targets) spot(t).denials++;
        for (const holder of (d.holders as string[] | undefined) ?? []) {
          const blocker = names.get(holder) ?? holder;
          for (const t of targets) {
            const h = spot(t);
            if (!h.holders.includes(blocker)) h.holders.push(blocker);
          }
          const pair = `${blocker}\0${e.agent?.name ?? "?"}`;
          pairs.set(pair, (pairs.get(pair) ?? 0) + 1);
        }
      } else if (e.type === "lock.granted") {
        for (const t of targets) open.set(`${e.agent?.id}\0${t}`, e.ts);
        const waited = Number(d.waitedMs ?? 0);
        if (d.handoff) totals.handoffs++;
        if (waited > 0) {
          totals.waits++;
          totals.waitedMs += waited;
          for (const t of targets) {
            const h = spot(t);
            h.waits++;
            h.waitedMs += waited;
            h.maxWaitMs = Math.max(h.maxWaitMs, waited);
          }
        }
      } else if (e.type === "lock.released") for (const t of targets) close(e.agent?.id, t, e.ts);
      else if (e.type === "lock.expired") {
        for (const t of targets) close(e.agent?.id, t, e.ts);
        if (d.contended) {
          totals.early++;
          for (const t of targets) spot(t).early++;
        }
      } else if (e.type === "lock.forced") {
        totals.forced++;
        close(String(d.holder), d.target, e.ts);
      } else if (e.type === "job.done")
        for (const t of (d.released as string[] | undefined) ?? []) close(e.agent?.id, t, e.ts);
    }
    holds.sort((a, b) => a - b);
    const pct = (q: number) =>
      holds.length ? holds[Math.min(holds.length - 1, Math.floor(q * holds.length))]! : 0;
    return {
      windowMs,
      totals,
      hot: [...hot.values()]
        .sort((a, b) => b.denials + b.waits - (a.denials + a.waits) || b.waitedMs - a.waitedMs)
        .slice(0, 10),
      pairs: [...pairs.entries()]
        .map(([k, count]) => {
          const [blocker, blocked] = k.split("\0") as [string, string];
          return { blocker, blocked, count };
        })
        .sort((a, b) => b.count - a.count)
        .slice(0, 10),
      holds: { count: holds.length, medianMs: pct(0.5), p90Ms: pct(0.9) },
    };
  }

  /** The holder renamed a symbol it had locked; the lock follows the new name. */
  async renameSymbol(p: Principal, path: string, from: string, to: string): Promise<boolean> {
    const agent = requireAgent(p);
    const followed = await this.store.renameLock(p.projectId, agent.id, path, from, to);
    if (followed)
      await this.emit(
        p.projectId,
        "lock.renamed",
        `${agent.name} renamed ${path}#${from} to ${to}; the lock followed`,
        agent,
        { path, from, to }
      );
    return followed;
  }

  /** A locked file moved (git mv, an editor rename): its locks and queued waits move with it. */
  async moveFile(p: Principal, from: string, to: string): Promise<Lock[]> {
    const { targets, errors } = validateTargets([from, to]);
    if (errors.length || targets.some((t) => t.symbol))
      throw new HttpError(400, "from and to must be repo-relative file paths.");
    const [src, dst] = targets as [Target, Target];
    if (src.path === dst.path) return [];
    const moved = await this.store.moveLocks(p.projectId, src.path, dst.path);
    if (moved.length) {
      const who = p.agent?.name ?? p.memberName;
      const holders = [...new Set(moved.map((l) => l.agent.name))].join(", ");
      await this.emit(
        p.projectId,
        "lock.moved",
        `${src.path} moved to ${dst.path} (seen by ${who}); ${moved.length} lock${s(moved.length)} followed (${holders})`,
        p.agent,
        { from: src.path, to: dst.path, targets: moved.map(formatTarget) }
      );
    }
    return moved;
  }

  /**
   * A locked file vanished from a device and no rename explains it. Its locks
   * stay (the holder may bring it back), but the team is told they protect
   * nothing there, instead of enforcement lapsing silently.
   */
  async orphaned(p: Principal, path: string, detail: string): Promise<Lock[]> {
    const locks = (await this.store.listLocks(p.projectId)).filter((l) => l.path === path);
    if (!locks.length) return [];
    const who = p.agent?.name ?? p.memberName;
    const holders = [...new Set(locks.map((l) => l.agent.name))].join(", ");
    await this.emit(
      p.projectId,
      "lock.orphaned",
      `${path} is gone on ${who}'s machine${detail ? ` (${detail})` : ""}; ${holders}'s lock${s(locks.length)} there protect${locks.length === 1 ? "s" : ""} nothing until it is back`,
      p.agent,
      { path, holders: locks.map((l) => l.agent.id) }
    );
    return locks;
  }

  async wait(
    p: Principal,
    rawTargets: string[],
    opts: { timeoutMs?: number; acquire?: boolean; intent?: string; jobId?: string }
  ): Promise<WaitResult> {
    const agent = requireAgent(p);
    const { targets, errors } = validateTargets(rawTargets);
    if (errors.length) throw new HttpError(400, errors.map((e) => e.message).join(" "));
    const acquire = opts.acquire ?? true;
    const intent = opts.intent?.trim() || "";
    if (acquire && !intent)
      throw new HttpError(400, "intent is required when wait should take the lock for you.");
    const timeoutMs = Math.min(Math.max(opts.timeoutMs ?? 60_000, 1_000), this.maxWaitMs);
    const startedAt = Date.now();
    const deadline = startedAt + timeoutMs;
    await this.touch(p);

    const waiterId = await this.store.enqueueWaiter(p.projectId, agent, targets, {
      acquire,
      intent,
      jobId: opts.jobId,
      deadline: deadline + 5_000,
      leaseMs: this.leaseMs,
    });
    let res: Awaited<ReturnType<Store["tryWaiter"]>> = null;
    try {
      while (true) {
        const seen = this.generation(p.projectId);
        res = await this.store.tryWaiter(waiterId, Date.now());
        if (res || Date.now() >= deadline) break;
        await this.nextChange(
          p.projectId,
          seen,
          Math.min(this.pollMs, Math.max(0, deadline - Date.now()))
        );
        await this.touch(p);
      }
    } finally {
      if (!res) res = await this.store.dropWaiter(waiterId);
    }
    if (res && res.status !== "gone") {
      const waitedMs = Date.now() - startedAt;
      if (res.status === "free") return { status: "free", waitedMs };
      if (res.locks.length) {
        await this.emit(
          p.projectId,
          "lock.granted",
          `${agent.name} locked ${res.locks.map(formatTarget).join(", ")} after waiting ${took(waitedMs)}: ${intent}`,
          agent,
          {
            targets: res.locks.map(formatTarget),
            intent,
            waitedMs,
          }
        );
      }
      return { status: "granted", locks: [...res.locks, ...res.renewed], waitedMs };
    }
    const conflicts = await this.conflictsFor(p.projectId, targets, agent.id);
    const d = await this.denial(p.projectId, conflicts, agent);
    return {
      status: "timeout",
      waitedMs: Date.now() - startedAt,
      conflicts: d.conflicts,
      holders: d.holders,
      advice: d.advice,
    };
  }

  /**
   * The lock table, as soon as anything in the project happens after event `sinceSeq`
   * (or after `waitMs` with nothing new). In-process events answer instantly; a
   * one-second poll covers events written by other hub instances.
   */
  async watchLocks(
    projectId: string,
    sinceSeq: number,
    waitMs: number
  ): Promise<{ seq: number; locks: Lock[] }> {
    const deadline = Date.now() + Math.min(Math.max(waitMs || 0, 0), 25_000);
    while (true) {
      const seen = this.generation(projectId);
      const [last] = await this.store.listEvents(projectId, 0, 1);
      const seq = last?.seq ?? 0;
      if (seq !== sinceSeq || Date.now() >= deadline || this.closed)
        return { seq, locks: await this.store.listLocks(projectId) };
      await this.nextChange(projectId, seen, Math.min(this.pollMs * 2, deadline - Date.now()));
    }
  }

  /**
   * Parking for `wait` and lock watches. Every event bumps its project's
   * generation; a caller reads the generation BEFORE checking the store and
   * parks only if it has not moved since, so a change that lands between the
   * check and the park is never missed. The timeout covers changes made by
   * other hub instances, which this process cannot see.
   */
  private generations = new Map<string, number>();
  private parked = new Map<string, Set<() => void>>();

  private generation(projectId: string): number {
    return this.generations.get(projectId) ?? 0;
  }

  private changed(projectId: string): void {
    this.generations.set(projectId, this.generation(projectId) + 1);
    for (const fn of [...(this.parked.get(projectId) ?? [])]) fn();
  }

  private nextChange(projectId: string, seen: number, ms: number): Promise<void> {
    if (this.generation(projectId) !== seen || this.closed) return Promise.resolve();
    return new Promise((resolve) => {
      let set = this.parked.get(projectId);
      if (!set) this.parked.set(projectId, (set = new Set()));
      const done = () => {
        clearTimeout(timer);
        set!.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      set.add(done);
    });
  }

  private async conflictsFor(
    projectId: string,
    targets: Target[],
    agentId: string
  ): Promise<Conflict[]> {
    const locks = await this.store.listLocks(projectId);
    const out: Conflict[] = [];
    for (const t of targets) {
      for (const l of locks) {
        if (l.agent.id === agentId) continue;
        const rel = relation(t, l);
        if (rel) out.push({ target: formatTarget(t), lock: l, relation: rel });
      }
    }
    return out;
  }

  /** Turn raw conflicts into the full decision package a blocked agent gets. */
  async denial(
    projectId: string,
    conflicts: Conflict[],
    asker: AgentRef
  ): Promise<Extract<AcquireResult, { status: "denied" }>> {
    const now = Date.now();
    const holders: HolderFacts[] = [];
    const seen = new Set<string>();
    for (const c of conflicts) {
      if (seen.has(c.lock.id)) continue;
      seen.add(c.lock.id);
      const agent = await this.store.getAgent(c.lock.agent.id);
      const lastSeen = agent?.lastSeenAt ?? c.lock.acquiredAt;
      let job: HolderFacts["job"];
      if (c.lock.jobId) {
        const j = await this.store.getJob(projectId, c.lock.jobId);
        if (j) job = { id: j.id, title: j.title, status: j.status };
      }
      holders.push({
        agent: c.lock.agent,
        idleMs: Math.max(0, now - lastSeen),
        heldMs: Math.max(0, now - c.lock.acquiredAt),
        expiresInMs: Math.max(0, c.lock.expiresAt - now),
        online: !!agent && agent.status !== "offline",
        job,
        queue: await this.store.queueDepth(projectId, c.lock, asker.id, now),
      });
    }
    const openJobs: JobSummary[] = (await this.store.listJobs(projectId, false))
      .filter((j) => j.status === "todo")
      .slice(0, 5)
      .map((j) => ({ id: j.id, title: j.title, priority: j.priority }));
    return { status: "denied", conflicts, holders, advice: advise(holders, openJobs), openJobs };
  }

  /** Sweep at most once per `minMs`; for runtimes without long-lived timers. */
  sweepIfDue(minMs = 2_000): Promise<void> {
    if (Date.now() - this.lastSweep < minMs) return Promise.resolve();
    return this.sweep();
  }

  private async sweep(): Promise<void> {
    if (this.closed) return;
    this.lastSweep = Date.now();
    try {
      const expired = await this.store.expireAll(Date.now());
      for (const { projectId, lock } of expired) {
        await this.emit(
          projectId,
          "lock.expired",
          `${lock.agent.name}'s lock on ${formatTarget(lock)} lapsed (no activity for ${Math.round(this.leaseMs / 60000)}m)`,
          lock.agent,
          {
            target: formatTarget(lock),
          }
        );
      }
      const early = await this.store.expireContended(Date.now(), this.contendedIdleMs);
      for (const { projectId, lock } of early) {
        await this.emit(
          projectId,
          "lock.expired",
          `${lock.agent.name}'s lock on ${formatTarget(lock)} lapsed early: idle ${mins(this.contendedIdleMs)} while others waited`,
          lock.agent,
          { target: formatTarget(lock), contended: true }
        );
      }
    } catch (e) {
      // The next sweep retries; a store hiccup must never take the hub down.
      if (!this.closed) console.error("[hub] sweep failed:", (e as Error).message);
    }
  }

  // ── jobs ──────────────────────────────────────────────────────────────────

  async postJob(
    p: Principal,
    input: { title: string; description?: string; priority?: Priority; dependencies?: string[] }
  ): Promise<Job> {
    if (!input.title?.trim()) throw new HttpError(400, "title is required");
    const priority: Priority = (["low", "medium", "high", "critical"] as const).includes(
      input.priority as Priority
    )
      ? (input.priority as Priority)
      : "medium";
    await this.touch(p);
    const job = await this.store.postJob(p.projectId, p.agent?.name ?? p.memberName, {
      title: input.title.trim(),
      description: input.description?.trim() ?? "",
      priority,
      dependencies: input.dependencies ?? [],
    });
    await this.emit(
      p.projectId,
      "job.posted",
      `${p.agent?.name ?? p.memberName} posted ${job.id} (${job.priority}): ${job.title}`,
      p.agent,
      { jobId: job.id }
    );
    return job;
  }

  async claim(p: Principal, jobId?: string): Promise<ClaimResult> {
    const agent = requireAgent(p);
    const now = Date.now();
    const out = jobId
      ? await this.store.claim(p.projectId, agent, jobId, now)
      : await this.store.claimNext(p.projectId, agent, now);
    if (out.kind === "missing") throw new HttpError(404, `No job ${jobId}.`);
    if (out.kind === "claimed") {
      await this.store.touchAgent(agent.id, now, this.leaseMs, `${out.job.id}: ${out.job.title}`);
      await this.emit(
        p.projectId,
        "job.claimed",
        `${agent.name} claimed ${out.job.id}: ${out.job.title}`,
        agent,
        { jobId: out.job.id }
      );
      return { status: "claimed", job: out.job };
    }
    await this.touch(p);
    if (out.kind === "none")
      return {
        status: "none",
        reason: out.blocked.length ? "blocked" : "empty",
        blocked: out.blocked,
      };
    return { status: "unavailable", job: out.job, reason: out.reason };
  }

  async completeJob(
    p: Principal,
    jobId: string,
    outcome: string
  ): Promise<{ job: Job; released: string[] }> {
    const agent = requireAgent(p);
    if (!outcome?.trim())
      throw new HttpError(400, "outcome is required: one line on what was done.");
    const res = await this.store.completeJob(
      p.projectId,
      agent.id,
      jobId,
      outcome.trim(),
      Date.now()
    );
    if ("error" in res) throw new HttpError(409, res.error);
    await this.store.touchAgent(agent.id, Date.now(), this.leaseMs, "");
    const released = res.released.map(formatTarget);
    await this.emit(
      p.projectId,
      "job.done",
      `${agent.name} finished ${jobId}: ${outcome.trim()}`,
      agent,
      { jobId, released }
    );
    return { job: res.job, released };
  }

  async releaseJob(p: Principal, jobId: string): Promise<Job> {
    const job = await this.store.releaseJob(p.projectId, jobId, Date.now());
    if (!job) throw new HttpError(409, `${jobId} is not in progress.`);
    await this.emit(
      p.projectId,
      "job.released",
      `${p.agent?.name ?? p.memberName} put ${jobId} back on the board`,
      p.agent,
      { jobId }
    );
    return job;
  }

  async cancelJob(p: Principal, jobId: string, reason: string): Promise<Job> {
    const job = await this.store.cancelJob(p.projectId, jobId, reason || "cancelled", Date.now());
    if (!job) throw new HttpError(409, `${jobId} is already closed or does not exist.`);
    await this.emit(
      p.projectId,
      "job.cancelled",
      `${p.agent?.name ?? p.memberName} cancelled ${jobId}: ${reason}`,
      p.agent,
      { jobId }
    );
    return job;
  }

  // ── notes + snapshot ──────────────────────────────────────────────────────

  async note(p: Principal, text: string): Promise<AxisEvent> {
    if (!text?.trim()) throw new HttpError(400, "text is required");
    await this.touch(p);
    return this.emit(p.projectId, "note", text.trim().slice(0, 2000), p.agent, {
      by: p.agent?.name ?? p.memberName,
    });
  }

  async snapshot(
    projectId: string,
    projectName: string,
    eventLimit = 200
  ): Promise<ProjectSnapshot> {
    const now = Date.now();
    const [agents, devices, locks, jobs, events] = await Promise.all([
      this.store.listAgents(projectId),
      this.store.listDevices(projectId, now),
      this.store.listLocks(projectId),
      this.store.listJobs(projectId, true),
      this.store.listEvents(projectId, 0, eventLimit),
    ]);
    return {
      project: { id: projectId, name: projectName },
      agents,
      devices,
      locks,
      jobs,
      events,
      serverTime: now,
    };
  }
}

// ── pure helpers ────────────────────────────────────────────────────────────

export function validateTargets(raw: string[]): { targets: Target[]; errors: TargetError[] } {
  const targets: Target[] = [];
  const errors: TargetError[] = [];
  if (!Array.isArray(raw) || raw.length === 0) {
    return {
      targets,
      errors: [
        {
          target: "",
          code: "empty",
          message: "Pass at least one target, e.g. src/auth.ts or src/auth.ts#login.",
        },
      ],
    };
  }
  for (const r of raw) {
    const t = parseTarget(String(r));
    if (!t.path || t.path === "." || t.path === "/") {
      errors.push({
        target: String(r),
        code: "empty",
        message: "Lock individual files, not the project root.",
      });
    } else if (t.path.startsWith("../") || t.path.startsWith("/")) {
      errors.push({
        target: String(r),
        code: "outside_project",
        message: `${r} is outside the project. Use a repo-relative path.`,
      });
    } else if (r.includes("#") && !/^[\p{L}\p{N}_$<>.:@()\-\[\]]+$/u.test(t.symbol)) {
      errors.push({
        target: String(r),
        code: "bad_symbol",
        message: `'${t.symbol}' is not a symbol name. Use dotted names like Class.method.`,
      });
    } else {
      targets.push(t);
    }
  }
  return { targets, errors };
}

/**
 * Recommend wait vs. work elsewhere from the facts, never from vibes. The agent
 * sees both the recommendation and the numbers behind it, and decides.
 */
export function advise(holders: HolderFacts[], openJobs: JobSummary[]): Advice {
  const maxWaitMs = Math.max(0, ...holders.map((h) => h.expiresInMs));
  const quiet = holders.filter((h) => h.idleMs > ACTIVE_MS || !h.online);
  const active = holders.filter((h) => !quiet.includes(h));
  const names = (hs: HolderFacts[]) => [...new Set(hs.map((h) => h.agent.name))].join(", ");

  if (active.length === 0 && holders.length > 0) {
    const longest = Math.max(...quiet.map((h) => h.idleMs));
    if (longest > 10 * 60_000) {
      return {
        action: "take_over",
        why: `${names(quiet)} has been silent ${mins(longest)}; the lease lapses by itself in ${mins(maxWaitMs)}, or break it with force_release if they crashed.`,
        maxWaitMs,
      };
    }
    return {
      action: "wait",
      why: `${names(quiet)} has gone quiet (${mins(longest)} idle), so this frees up within ${mins(maxWaitMs)} at most. wait() returns the instant it does.`,
      maxWaitMs,
    };
  }
  const queued = Math.max(0, ...holders.map((h) => h.queue));
  if (openJobs.length > 0) {
    const next = openJobs[0]!;
    return {
      action: "work_elsewhere",
      why: `${names(active)} is actively working here${queued ? ` and ${queued} agent${s(queued)} already queued` : ""}. ${openJobs.length} open job${s(openJobs.length)} (next: ${next.id} ${next.title}). Take one, or wait() to be pinged when this frees.`,
      maxWaitMs,
    };
  }
  return {
    action: "wait",
    why: `${names(active)} is actively working here and there is no other open job. wait() parks you in the queue${queued ? ` behind ${queued}` : ""} and hands you the lock the moment it frees.`,
    maxWaitMs,
  };
}

function requireAgent(p: Principal): AgentRef {
  if (!p.agent)
    throw new HttpError(
      403,
      "This call needs an agent session token. Start one with POST /api/v1/agents."
    );
  return p.agent;
}

function clean(v?: string): string {
  return (v ?? "").trim().slice(0, 80);
}

function s(n: number): string {
  return n === 1 ? "" : "s";
}

function mins(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  return `${Math.round(ms / 60_000)}m`;
}
