import postgres from "postgres";
import { relation } from "../protocol/target.ts";
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
  JobStatus,
  Lock,
  Priority,
  Target,
} from "../protocol/types.ts";
import { hashToken, newId, newToken, shortCode } from "./ids.ts";
import type {
  AcquireOutcome,
  ClaimOutcome,
  Handoff,
  NewProject,
  Principal,
  Store,
} from "./store.ts";

/**
 * The hosted store (Supabase / any Postgres). Same semantics as SqliteStore,
 * with atomicity from a per-project transaction-scoped advisory lock: every
 * mutation of a project's coordination state runs one at a time, across every
 * hub instance, so two agents racing through acquire or claim can never both
 * win. Tables live in the private `axis` schema, which PostgREST does not expose.
 */

type Sql = postgres.Sql;
type Tx = postgres.TransactionSql;
type Q = Sql | Tx;

/** Served waiters stay this long for their agent to collect the hand-off. */
const SERVED_KEEP_MS = 24 * 3600_000;
const PRIORITY_RANK: Record<Priority, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const ACTIVE_MS = 2 * 60_000;
const IDLE_MS = 15 * 60_000;
const DEVICE_ONLINE_MS = 90_000;

type WaitOutcome = { status: "granted"; locks: Lock[]; renewed: Lock[] } | { status: "free" };

interface AgentRow {
  id: string;
  project_id: string;
  name: string;
  vendor: string;
  member: string;
  device: string;
  task: string | null;
  started_at: string;
  last_seen_at: string;
}

interface JobRow {
  id: string;
  title: string;
  description: string;
  priority: Priority;
  status: JobStatus;
  dependencies: string[];
  assignee: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  outcome: string | null;
  assignee_name: string | null;
  assignee_vendor: string | null;
  assignee_member: string | null;
  assignee_device: string | null;
}

interface WaiterRow {
  seq: string;
  id: string;
  agent_id: string;
  targets: Target[];
  acquire: boolean;
  intent: string;
  job_id: string | null;
  lease_ms: string;
}

const n = (v: string | number | null | undefined): number => Number(v ?? 0);

export class PostgresStore implements Store {
  private sql: Sql;

  constructor(url: string | Sql, opts: { max?: number; idleTimeoutSec?: number } = {}) {
    // prepare:false keeps it compatible with transaction-mode poolers (Supabase's pgbouncer/supavisor).
    // A short idle timeout matters on serverless: every warm isolate would otherwise pin its connections.
    this.sql =
      typeof url === "string"
        ? postgres(url, {
            prepare: false,
            max: opts.max ?? 5,
            idle_timeout: opts.idleTimeoutSec,
            onnotice: () => {},
          })
        : url;
  }

  close(): void {
    void this.sql.end({ timeout: 1 });
  }

  /** One project's coordination state, mutated by one transaction at a time. */
  private tx<T>(projectIds: string | string[], fn: (t: Tx) => Promise<T>): Promise<T> {
    const ids = [...new Set(Array.isArray(projectIds) ? projectIds : [projectIds])].sort();
    return this.sql.begin(async (t) => {
      for (const id of ids) await t`SELECT pg_advisory_xact_lock(hashtext(${"axis:" + id}))`;
      return fn(t);
    }) as Promise<T>;
  }

  // ── projects + auth ───────────────────────────────────────────────────────

  async createProject(name: string, memberName: string): Promise<NewProject> {
    const now = Date.now();
    const id = newId("p");
    const invite = shortCode();
    const token = newToken("axm");
    await this.sql.begin(async (t) => {
      await t`INSERT INTO axis.projects (id, name, invite, created_at) VALUES (${id}, ${name}, ${invite}, ${now})`;
      await t`INSERT INTO axis.members (id, project_id, name, token_hash, created_at) VALUES (${newId("m")}, ${id}, ${memberName}, ${hashToken(token)}, ${now})`;
    });
    return { project: { id, name }, memberToken: token, invite };
  }

  async join(invite: string, memberName: string) {
    const [project] = await this.sql<
      { id: string; name: string }[]
    >`SELECT id, name FROM axis.projects WHERE invite = ${invite}`;
    if (!project) return null;
    const token = newToken("axm");
    await this
      .sql`INSERT INTO axis.members (id, project_id, name, token_hash, created_at) VALUES (${newId("m")}, ${project.id}, ${memberName}, ${hashToken(token)}, ${Date.now()})`;
    return { projectId: project.id, projectName: project.name, memberToken: token };
  }

  async rotateInvite(projectId: string): Promise<string> {
    const invite = shortCode();
    await this.sql`UPDATE axis.projects SET invite = ${invite} WHERE id = ${projectId}`;
    return invite;
  }

  async getInvite(projectId: string): Promise<string | null> {
    const [row] = await this.sql<
      { invite: string }[]
    >`SELECT invite FROM axis.projects WHERE id = ${projectId}`;
    return row?.invite ?? null;
  }

  async authenticate(token: string): Promise<Principal | null> {
    // One round trip: the token is either a live agent session or a member.
    const [row] = await this.sql<
      {
        kind: "agent" | "member";
        project_id: string;
        project_name: string;
        member_id: string;
        member_name: string;
        id: string | null;
        name: string | null;
        vendor: string | null;
        member: string | null;
        device: string | null;
      }[]
    >`
      SELECT 'agent' AS kind, a.project_id, p.name AS project_name, m.id AS member_id, m.name AS member_name, a.id, a.name, a.vendor, a.member, a.device
      FROM axis.agents a JOIN axis.members m ON m.id = a.member_id JOIN axis.projects p ON p.id = a.project_id
      WHERE a.token_hash = ${hashToken(token)} AND a.ended_at IS NULL
      UNION ALL
      SELECT 'member', m.project_id, p.name, m.id, m.name, NULL, NULL, NULL, NULL, NULL
      FROM axis.members m JOIN axis.projects p ON p.id = m.project_id WHERE m.token_hash = ${hashToken(token)}
      LIMIT 1`;
    if (!row) return null;
    const base = {
      projectId: row.project_id,
      projectName: row.project_name,
      memberId: row.member_id,
      memberName: row.member_name,
    };
    if (row.kind === "member") return { kind: "member", ...base };
    return {
      kind: "agent",
      ...base,
      agent: {
        id: row.id!,
        name: row.name!,
        vendor: row.vendor!,
        member: row.member!,
        device: row.device!,
      },
    };
  }

  // ── agents ────────────────────────────────────────────────────────────────

  async startAgent(
    p: Principal,
    input: { name: string; vendor: string; device: string; task?: string }
  ) {
    const now = Date.now();
    const id = newId("a");
    const token = newToken("axa");
    await this.sql`
      INSERT INTO axis.agents (id, project_id, member_id, name, vendor, member, device, task, token_hash, started_at, last_seen_at)
      VALUES (${id}, ${p.projectId}, ${p.memberId}, ${input.name}, ${input.vendor}, ${p.memberName}, ${input.device}, ${input.task ?? null}, ${hashToken(token)}, ${now}, ${now})`;
    return {
      agent: {
        id,
        name: input.name,
        vendor: input.vendor,
        member: p.memberName,
        device: input.device,
      },
      token,
    };
  }

  async touchAgent(agentId: string, now: number, leaseMs: number, task?: string): Promise<void> {
    await this.sql.begin(async (t) => {
      if (task !== undefined)
        await t`UPDATE axis.agents SET last_seen_at = ${now}, task = ${task} WHERE id = ${agentId}`;
      else await t`UPDATE axis.agents SET last_seen_at = ${now} WHERE id = ${agentId}`;
      await t`UPDATE axis.locks SET expires_at = ${now + leaseMs} WHERE agent_id = ${agentId} AND expires_at < ${now + leaseMs}`;
    });
  }

  async endAgent(agentId: string): Promise<Lock[]> {
    const [row] = await this.sql<
      { project_id: string }[]
    >`SELECT project_id FROM axis.agents WHERE id = ${agentId}`;
    if (!row) return [];
    return this.tx(row.project_id, async (t) => {
      const now = Date.now();
      const held = await lockRows(t, t`WHERE l.agent_id = ${agentId}`);
      await t`DELETE FROM axis.locks WHERE agent_id = ${agentId}`;
      await t`DELETE FROM axis.waiters WHERE agent_id = ${agentId}`;
      await t`UPDATE axis.agents SET ended_at = ${now} WHERE id = ${agentId}`;
      // A job the agent was mid-way through goes back on the board.
      await t`UPDATE axis.jobs SET status = 'todo', assignee = NULL, updated_at = ${now} WHERE assignee = ${agentId} AND status = 'in_progress'`;
      if (held.length) await serviceQueue(t, row.project_id, now);
      return held;
    });
  }

  async listAgents(projectId: string): Promise<Agent[]> {
    const now = Date.now();
    const rows = await this.sql<AgentRow[]>`
      SELECT * FROM axis.agents WHERE project_id = ${projectId} AND ended_at IS NULL AND last_seen_at > ${now - 24 * 3600_000} ORDER BY started_at`;
    return rows.map((r) => toAgent(r, now));
  }

  async getAgent(agentId: string): Promise<Agent | null> {
    const [row] = await this.sql<AgentRow[]>`SELECT * FROM axis.agents WHERE id = ${agentId}`;
    return row ? toAgent(row, Date.now()) : null;
  }

  // ── locks ─────────────────────────────────────────────────────────────────

  acquire(
    projectId: string,
    agent: AgentRef,
    targets: Target[],
    intent: string,
    jobId: string | undefined,
    leaseMs: number,
    now: number
  ): Promise<AcquireOutcome> {
    return this.tx(projectId, async (t) => {
      // Anyone already queued is served before a newcomer, even on a lease that lapsed unswept.
      await serviceQueue(t, projectId, now);
      return acquireIn(t, projectId, agent, targets, intent, jobId, leaseMs, now);
    });
  }

  release(projectId: string, agentId: string, targets: Target[] | "all"): Promise<Lock[]> {
    return this.tx(projectId, async (t) => {
      const held = await lockRows(
        t,
        t`WHERE l.project_id = ${projectId} AND l.agent_id = ${agentId}`
      );
      const out =
        targets === "all"
          ? held
          : held.filter((l) =>
              targets.some((x) => x.path === l.path && (x.symbol === l.symbol || x.symbol === ""))
            );
      if (out.length) {
        await t`DELETE FROM axis.locks WHERE id IN ${t(out.map((l) => l.id))}`;
        await serviceQueue(t, projectId, Date.now());
      }
      return out;
    });
  }

  forceRelease(projectId: string, targets: Target[]): Promise<Lock[]> {
    return this.tx(projectId, async (t) => {
      const out: Lock[] = [];
      for (const target of targets) {
        for (const l of await lockRows(
          t,
          t`WHERE l.project_id = ${projectId} AND l.path = ${target.path}`
        )) {
          if (relation(target, l) && !out.some((o) => o.id === l.id)) out.push(l);
        }
      }
      if (out.length) {
        await t`DELETE FROM axis.locks WHERE id IN ${t(out.map((l) => l.id))}`;
        await serviceQueue(t, projectId, Date.now());
      }
      return out;
    });
  }

  async collectServed(agentId: string): Promise<Handoff[]> {
    const rows = await this.sql<
      { targets: Target[]; intent: string; result: Handoff["outcome"] }[]
    >`DELETE FROM axis.waiters WHERE agent_id = ${agentId} AND result IS NOT NULL RETURNING seq, targets, intent, result`;
    return rows
      .sort((a, b) => Number((a as { seq?: number }).seq) - Number((b as { seq?: number }).seq))
      .map((r) => ({ targets: r.targets, intent: r.intent, outcome: r.result }));
  }

  async expireContended(now: number, idleMs: number): Promise<{ projectId: string; lock: Lock }[]> {
    const waiting = await this.sql<
      { project_id: string }[]
    >`SELECT DISTINCT project_id FROM axis.waiters WHERE result IS NULL AND deadline >= ${now}`;
    if (!waiting.length) return [];
    const projects = waiting.map((r) => r.project_id);
    return this.tx(projects, async (t) => {
      const out: { projectId: string; lock: Lock }[] = [];
      for (const projectId of projects) {
        const queued = await t<
          { agent_id: string; targets: Target[] }[]
        >`SELECT agent_id, targets FROM axis.waiters WHERE project_id = ${projectId} AND result IS NULL AND deadline >= ${now}`;
        const idle = await t<{ id: string }[]>`
          SELECT l.id FROM axis.locks l JOIN axis.agents a ON a.id = l.agent_id
          WHERE l.project_id = ${projectId} AND l.expires_at > ${now} AND a.last_seen_at < ${now - idleMs}`;
        if (!idle.length) continue;
        const ids = new Set(idle.map((r) => r.id));
        const gone = (await lockRows(t, t`WHERE l.project_id = ${projectId}`)).filter(
          (l) =>
            ids.has(l.id) &&
            queued.some((q) => q.agent_id !== l.agent.id && q.targets.some((x) => relation(x, l)))
        );
        if (!gone.length) continue;
        await t`DELETE FROM axis.locks WHERE id IN ${t(gone.map((l) => l.id))}`;
        await serviceQueue(t, projectId, now);
        out.push(...gone.map((lock) => ({ projectId, lock })));
      }
      return out;
    });
  }

  async expireAll(now: number): Promise<{ projectId: string; lock: Lock }[]> {
    const due = await this.sql<
      { project_id: string }[]
    >`SELECT DISTINCT project_id FROM axis.locks WHERE expires_at <= ${now}`;
    if (!due.length) return [];
    const projects = due.map((r) => r.project_id);
    return this.tx(projects, async (t) => {
      const gone = await lockRows(
        t,
        t`WHERE l.expires_at <= ${now} AND l.project_id IN ${t(projects)}`
      );
      const [pids, lockProject] = [new Set<string>(), new Map<string, string>()];
      if (!gone.length) return [];
      const rows = await t<
        { id: string; project_id: string }[]
      >`DELETE FROM axis.locks WHERE id IN ${t(gone.map((l) => l.id))} RETURNING id, project_id`;
      for (const r of rows) {
        pids.add(r.project_id);
        lockProject.set(r.id, r.project_id);
      }
      for (const p of pids) await serviceQueue(t, p, now);
      return gone.map((lock) => ({ projectId: lockProject.get(lock.id)!, lock }));
    });
  }

  async listLocks(projectId: string): Promise<Lock[]> {
    return lockRows(
      this.sql,
      this
        .sql`WHERE l.project_id = ${projectId} AND l.expires_at > ${Date.now()} ORDER BY l.path, l.symbol`
    );
  }

  async locksOf(agentId: string): Promise<Lock[]> {
    return lockRows(
      this.sql,
      this.sql`WHERE l.agent_id = ${agentId} AND l.expires_at > ${Date.now()}`
    );
  }

  async renameLock(
    projectId: string,
    agentId: string,
    filePath: string,
    from: string,
    to: string
  ): Promise<boolean> {
    return this.tx(projectId, async (t) => {
      const [clash] = await t<
        { agent_id: string }[]
      >`SELECT agent_id FROM axis.locks WHERE project_id = ${projectId} AND path = ${filePath} AND symbol = ${to}`;
      if (clash && clash.agent_id !== agentId) return false;
      if (clash)
        await t`DELETE FROM axis.locks WHERE project_id = ${projectId} AND agent_id = ${agentId} AND path = ${filePath} AND symbol = ${from}`;
      else
        await t`UPDATE axis.locks SET symbol = ${to} WHERE project_id = ${projectId} AND agent_id = ${agentId} AND path = ${filePath} AND symbol = ${from}`;
      return true;
    });
  }

  moveLocks(projectId: string, from: string, to: string): Promise<Lock[]> {
    return this.tx(projectId, async (t) => {
      const moving = await lockRows(t, t`WHERE l.project_id = ${projectId} AND l.path = ${from}`);
      if (!moving.length) return [];
      const moved: Lock[] = [];
      for (const l of moving) {
        const [taken] =
          await t`SELECT 1 FROM axis.locks WHERE project_id = ${projectId} AND path = ${to} AND symbol = ${l.symbol}`;
        // Someone already holds the same unit at the destination; theirs stands.
        if (taken) await t`DELETE FROM axis.locks WHERE id = ${l.id}`;
        else {
          await t`UPDATE axis.locks SET path = ${to} WHERE id = ${l.id}`;
          moved.push({ ...l, path: to });
        }
      }
      const waiters = await t<
        { id: string; targets: Target[] }[]
      >`SELECT id, targets FROM axis.waiters WHERE project_id = ${projectId}`;
      for (const w of waiters) {
        if (!w.targets.some((x) => x.path === from)) continue;
        const next = w.targets.map((x) => (x.path === from ? { ...x, path: to } : x));
        await t`UPDATE axis.waiters SET targets = ${t.json(next as never)} WHERE id = ${w.id}`;
      }
      await serviceQueue(t, projectId, Date.now());
      return moved;
    });
  }

  // ── wait queue ────────────────────────────────────────────────────────────

  async enqueueWaiter(
    projectId: string,
    agent: AgentRef,
    targets: Target[],
    opts: { acquire: boolean; intent: string; jobId?: string; deadline: number; leaseMs: number }
  ): Promise<string> {
    const id = newId("w");
    await this.sql`
      INSERT INTO axis.waiters (id, project_id, agent_id, targets, acquire, intent, job_id, deadline, lease_ms)
      VALUES (${id}, ${projectId}, ${agent.id}, ${this.sql.json(targets as never)}, ${opts.acquire}, ${opts.intent}, ${opts.jobId ?? null}, ${opts.deadline}, ${opts.leaseMs})`;
    return id;
  }

  async tryWaiter(waiterId: string, now: number) {
    const [w] = await this.sql<
      { project_id: string; result: WaitOutcome | null }[]
    >`SELECT project_id, result FROM axis.waiters WHERE id = ${waiterId}`;
    if (!w) return { status: "gone" as const };
    return this.tx(w.project_id, async (t): Promise<WaitOutcome | { status: "gone" } | null> => {
      await serviceQueue(t, w.project_id, now);
      const [row] = await t<
        { result: WaitOutcome | null }[]
      >`SELECT result FROM axis.waiters WHERE id = ${waiterId}`;
      if (!row) return { status: "gone" };
      if (!row.result) return null;
      await t`DELETE FROM axis.waiters WHERE id = ${waiterId}`;
      return row.result;
    });
  }

  async dropWaiter(waiterId: string): Promise<WaitOutcome | null> {
    const [row] = await this.sql<
      { result: WaitOutcome | null }[]
    >`DELETE FROM axis.waiters WHERE id = ${waiterId} RETURNING result`;
    return row?.result ?? null;
  }

  async queueDepth(
    projectId: string,
    target: Target,
    exceptAgentId: string,
    now: number
  ): Promise<number> {
    const rows = await this.sql<{ targets: Target[] }[]>`
      SELECT targets FROM axis.waiters WHERE project_id = ${projectId} AND agent_id <> ${exceptAgentId} AND deadline >= ${now} AND result IS NULL`;
    return rows.filter((r) => r.targets.some((x) => relation(x, target))).length;
  }

  // ── jobs ──────────────────────────────────────────────────────────────────

  async postJob(
    projectId: string,
    by: string,
    input: { title: string; description: string; priority: Priority; dependencies: string[] }
  ): Promise<Job> {
    return this.tx(projectId, async (t) => {
      const [bumped] = await t<
        { job_seq: number }[]
      >`UPDATE axis.projects SET job_seq = job_seq + 1 WHERE id = ${projectId} RETURNING job_seq`;
      const id = `J${bumped!.job_seq}`;
      const now = Date.now();
      await t`
        INSERT INTO axis.jobs (id, project_id, title, description, priority, status, dependencies, created_by, created_at, updated_at)
        VALUES (${id}, ${projectId}, ${input.title}, ${input.description}, ${input.priority}, 'todo', ${t.json(input.dependencies)}, ${by}, ${now}, ${now})`;
      return (await jobRow(t, projectId, id))!;
    });
  }

  claimNext(projectId: string, agent: AgentRef, now: number): Promise<ClaimOutcome> {
    return this.tx(projectId, async (t): Promise<ClaimOutcome> => {
      const todo = (
        await jobRows(t, t`WHERE j.project_id = ${projectId} AND j.status = 'todo'`)
      ).sort(
        (a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.createdAt - b.createdAt
      );
      const blocked: { id: string; title: string; waitingOn: string[] }[] = [];
      for (const job of todo) {
        const waitingOn = await unmetDeps(t, projectId, job.dependencies);
        if (waitingOn.length) {
          blocked.push({ id: job.id, title: job.title, waitingOn });
          continue;
        }
        await t`UPDATE axis.jobs SET status = 'in_progress', assignee = ${agent.id}, updated_at = ${now} WHERE project_id = ${projectId} AND id = ${job.id}`;
        return { kind: "claimed", job: (await jobRow(t, projectId, job.id))! };
      }
      return { kind: "none", blocked };
    });
  }

  claim(projectId: string, agent: AgentRef, jobId: string, now: number): Promise<ClaimOutcome> {
    return this.tx(projectId, async (t): Promise<ClaimOutcome> => {
      const job = await jobRow(t, projectId, jobId);
      if (!job) return { kind: "missing" };
      if (job.status === "done" || job.status === "cancelled")
        return { kind: "unavailable", job, reason: "closed" };
      if (job.status === "in_progress") {
        if (job.assignee?.id === agent.id) return { kind: "claimed", job };
        return { kind: "unavailable", job, reason: "taken" };
      }
      if ((await unmetDeps(t, projectId, job.dependencies)).length)
        return { kind: "unavailable", job, reason: "blocked" };
      await t`UPDATE axis.jobs SET status = 'in_progress', assignee = ${agent.id}, updated_at = ${now} WHERE project_id = ${projectId} AND id = ${jobId}`;
      return { kind: "claimed", job: (await jobRow(t, projectId, jobId))! };
    });
  }

  completeJob(projectId: string, agentId: string, jobId: string, outcome: string, now: number) {
    return this.tx(
      projectId,
      async (t): Promise<{ job: Job; released: Lock[] } | { error: string }> => {
        const job = await jobRow(t, projectId, jobId);
        if (!job) return { error: `No job ${jobId}.` };
        if (job.status === "done") return { error: `${jobId} is already done.` };
        if (job.status === "cancelled") return { error: `${jobId} was cancelled.` };
        await t`UPDATE axis.jobs SET status = 'done', outcome = ${outcome}, updated_at = ${now}, assignee = COALESCE(assignee, ${agentId}) WHERE project_id = ${projectId} AND id = ${jobId}`;
        const released = await lockRows(
          t,
          t`WHERE l.project_id = ${projectId} AND l.job_id = ${jobId}`
        );
        await t`DELETE FROM axis.locks WHERE project_id = ${projectId} AND job_id = ${jobId}`;
        if (released.length) await serviceQueue(t, projectId, now);
        return { job: (await jobRow(t, projectId, jobId))!, released };
      }
    );
  }

  async releaseJob(projectId: string, jobId: string, now: number): Promise<Job | null> {
    const rows = await this
      .sql`UPDATE axis.jobs SET status = 'todo', assignee = NULL, updated_at = ${now} WHERE project_id = ${projectId} AND id = ${jobId} AND status = 'in_progress' RETURNING id`;
    return rows.length ? jobRow(this.sql, projectId, jobId) : null;
  }

  async cancelJob(
    projectId: string,
    jobId: string,
    reason: string,
    now: number
  ): Promise<Job | null> {
    const rows = await this.sql`
      UPDATE axis.jobs SET status = 'cancelled', outcome = ${reason}, updated_at = ${now}
      WHERE project_id = ${projectId} AND id = ${jobId} AND status IN ('todo', 'in_progress') RETURNING id`;
    return rows.length ? jobRow(this.sql, projectId, jobId) : null;
  }

  async listJobs(projectId: string, includeClosed: boolean): Promise<Job[]> {
    const where = includeClosed
      ? this.sql`WHERE j.project_id = ${projectId}`
      : this.sql`WHERE j.project_id = ${projectId} AND j.status IN ('todo', 'in_progress')`;
    return (await jobRows(this.sql, where)).sort(
      (a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.createdAt - b.createdAt
    );
  }

  getJob(projectId: string, jobId: string): Promise<Job | null> {
    return jobRow(this.sql, projectId, jobId);
  }

  // ── devices ───────────────────────────────────────────────────────────────

  async reportDevice(
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
  ): Promise<void> {
    await this.sql`
      INSERT INTO axis.devices (id, project_id, member, hostname, platform, tier, sealed, health, last_seen_at)
      VALUES (${input.deviceId}, ${p.projectId}, ${p.memberName}, ${input.hostname}, ${input.platform}, ${input.tier}, ${this.sql.json(input.sealed)}, ${this.sql.json((input.health ?? {}) as never)}, ${now})
      ON CONFLICT (project_id, id) DO UPDATE SET member = excluded.member, hostname = excluded.hostname, platform = excluded.platform,
        tier = excluded.tier, sealed = excluded.sealed, health = axis.devices.health || excluded.health,
        last_seen_at = excluded.last_seen_at`;
  }

  async listDevices(projectId: string, now: number): Promise<Device[]> {
    const rows = await this.sql<
      {
        id: string;
        member: string;
        hostname: string;
        platform: string;
        tier: EnforcementTier;
        sealed: string[];
        health: DeviceHealth;
        last_seen_at: string;
      }[]
    >`
      SELECT * FROM axis.devices WHERE project_id = ${projectId} AND last_seen_at > ${now - 24 * 3600_000} ORDER BY hostname`;
    return rows.map((r) => ({
      id: r.id,
      member: r.member,
      hostname: r.hostname,
      platform: r.platform,
      tier: r.tier,
      sealed: r.sealed,
      health: r.health ?? {},
      lastSeenAt: n(r.last_seen_at),
      online: now - n(r.last_seen_at) < DEVICE_ONLINE_MS,
    }));
  }

  // ── events ────────────────────────────────────────────────────────────────

  async appendEvent(
    projectId: string,
    type: EventType,
    text: string,
    agent: AgentRef | undefined,
    data: Record<string, unknown>,
    now: number
  ): Promise<AxisEvent> {
    const [row] = await this.sql<{ seq: string }[]>`
      INSERT INTO axis.events (project_id, ts, type, agent, text, data)
      VALUES (${projectId}, ${now}, ${type}, ${agent ? this.sql.json(agent as never) : null}, ${text}, ${this.sql.json(data as never)}) RETURNING seq`;
    return { seq: n(row!.seq), ts: now, type, agent, text, data };
  }

  async listEvents(projectId: string, sinceSeq: number, limit: number): Promise<AxisEvent[]> {
    const rows = await this.sql<
      {
        seq: string;
        ts: string;
        type: EventType;
        agent: AgentRef | null;
        text: string;
        data: Record<string, unknown>;
      }[]
    >`
      SELECT * FROM (SELECT * FROM axis.events WHERE project_id = ${projectId} AND seq > ${sinceSeq} ORDER BY seq DESC LIMIT ${limit}) e ORDER BY seq`;
    return rows.map((r) => ({
      seq: n(r.seq),
      ts: n(r.ts),
      type: r.type,
      agent: r.agent ?? undefined,
      text: r.text,
      data: r.data,
    }));
  }

  // ── soul ──────────────────────────────────────────────────────────────────

  async getSoul(projectId: string) {
    const [row] = await this.sql<
      { soul_context: string; soul_conventions: string }[]
    >`SELECT soul_context, soul_conventions FROM axis.projects WHERE id = ${projectId}`;
    return { context: row?.soul_context ?? "", conventions: row?.soul_conventions ?? "" };
  }

  async setSoul(projectId: string, soul: { context?: string; conventions?: string }) {
    if (soul.context !== undefined)
      await this
        .sql`UPDATE axis.projects SET soul_context = ${soul.context} WHERE id = ${projectId}`;
    if (soul.conventions !== undefined)
      await this
        .sql`UPDATE axis.projects SET soul_conventions = ${soul.conventions} WHERE id = ${projectId}`;
  }
}

// ── transaction bodies (shared by acquire and the queue) ─────────────────────

async function lockRows(q: Q, where: postgres.PendingQuery<postgres.Row[]>): Promise<Lock[]> {
  const rows = await q<
    {
      id: string;
      path: string;
      symbol: string;
      agent_id: string;
      agent_name: string;
      vendor: string;
      member: string;
      device: string;
      intent: string;
      job_id: string | null;
      acquired_at: string;
      expires_at: string;
    }[]
  >`SELECT l.*, a.name AS agent_name, a.vendor, a.member, a.device FROM axis.locks l JOIN axis.agents a ON a.id = l.agent_id ${where}`;
  return rows.map((r) => ({
    id: r.id,
    path: r.path,
    symbol: r.symbol,
    agent: {
      id: r.agent_id,
      name: r.agent_name,
      vendor: r.vendor,
      member: r.member,
      device: r.device,
    },
    intent: r.intent,
    jobId: r.job_id ?? undefined,
    acquiredAt: n(r.acquired_at),
    expiresAt: n(r.expires_at),
  }));
}

async function acquireIn(
  t: Tx,
  projectId: string,
  agent: AgentRef,
  targets: Target[],
  intent: string,
  jobId: string | undefined,
  leaseMs: number,
  now: number
): Promise<AcquireOutcome> {
  const conflicts: Conflict[] = [];
  const renewed: Lock[] = [];
  const fresh: Target[] = [];
  const sameIds = new Set<string>();
  for (const target of uniqueTargets(targets)) {
    const rows = await lockRows(
      t,
      // Ordered, so a denial lists its conflicts the same way on every store.
      t`WHERE l.project_id = ${projectId} AND l.path = ${target.path} AND l.expires_at > ${now} ORDER BY l.symbol`
    );
    let mine: Lock | undefined;
    for (const lock of rows) {
      const rel = relation(target, lock);
      if (!rel) continue;
      if (lock.agent.id === agent.id) {
        if (rel === "same" || rel === "encloses") mine = lock;
        continue;
      }
      conflicts.push({
        target: target.symbol ? `${target.path}#${target.symbol}` : target.path,
        lock,
        relation: rel,
      });
    }
    if (mine) {
      if (!renewed.some((r) => r.id === mine!.id)) renewed.push(mine);
      if (mine.path === target.path && mine.symbol === target.symbol) sameIds.add(mine.id);
    } else fresh.push(target);
  }
  // All-or-nothing: a partial batch would block others while still not letting the caller work.
  if (conflicts.length) return { granted: [], renewed: [], conflicts };

  const expires = now + leaseMs;
  for (const l of renewed) {
    const nextIntent = sameIds.has(l.id) ? intent : l.intent;
    await t`UPDATE axis.locks SET expires_at = ${expires}, intent = ${nextIntent} WHERE id = ${l.id}`;
    l.expiresAt = expires;
    l.intent = nextIntent;
  }
  const granted: Lock[] = [];
  for (const target of fresh) {
    // Taking an enclosing lock subsumes the caller's own narrower locks.
    for (const o of await lockRows(
      t,
      t`WHERE l.project_id = ${projectId} AND l.path = ${target.path} AND l.agent_id = ${agent.id}`
    )) {
      if (relation(target, o) === "within") await t`DELETE FROM axis.locks WHERE id = ${o.id}`;
    }
    // A lapsed row for this exact target may still exist until the sweep runs.
    await t`DELETE FROM axis.locks WHERE project_id = ${projectId} AND path = ${target.path} AND symbol = ${target.symbol} AND expires_at <= ${now}`;
    const id = newId("l");
    await t`
      INSERT INTO axis.locks (id, project_id, path, symbol, agent_id, intent, job_id, acquired_at, expires_at)
      VALUES (${id}, ${projectId}, ${target.path}, ${target.symbol}, ${agent.id}, ${intent}, ${jobId ?? null}, ${now}, ${expires})`;
    granted.push({
      id,
      path: target.path,
      symbol: target.symbol,
      agent,
      intent,
      jobId,
      acquiredAt: now,
      expiresAt: expires,
    });
  }
  return { granted, renewed, conflicts: [] };
}

/** Hand freed targets to the queue, oldest first, inside the caller's transaction. */
async function serviceQueue(t: Tx, projectId: string, now: number): Promise<void> {
  // Unserved waiters leave at their deadline. Served ones stay until their agent collects
  // the hand-off (see collectServed), so a grant is never lost, for at most a day.
  await t`DELETE FROM axis.waiters WHERE project_id = ${projectId} AND ((result IS NULL AND deadline < ${now}) OR deadline < ${now - SERVED_KEEP_MS})`;
  const queue = await t<
    WaiterRow[]
  >`SELECT * FROM axis.waiters WHERE project_id = ${projectId} AND result IS NULL ORDER BY seq`;
  if (!queue.length) return;
  const live = await lockRows(t, t`WHERE l.project_id = ${projectId} AND l.expires_at > ${now}`);
  const pending: WaiterRow[] = [];
  for (const w of queue) {
    const blocked = pending.some(
      (a) =>
        a.acquire &&
        a.agent_id !== w.agent_id &&
        a.targets.some((x) => w.targets.some((y) => relation(x, y)))
    );
    const busy =
      !blocked &&
      live.some((l) => l.agent.id !== w.agent_id && w.targets.some((x) => relation(x, l)));
    if (blocked || busy) {
      pending.push(w);
      continue;
    }
    let result: WaitOutcome;
    if (!w.acquire) result = { status: "free" };
    else {
      const [agentRow] = await t<
        AgentRow[]
      >`SELECT * FROM axis.agents WHERE id = ${w.agent_id} AND ended_at IS NULL`;
      if (!agentRow) {
        await t`DELETE FROM axis.waiters WHERE id = ${w.id}`;
        continue;
      }
      const out = await acquireIn(
        t,
        projectId,
        agentRef(agentRow),
        w.targets,
        w.intent,
        w.job_id ?? undefined,
        n(w.lease_ms),
        now
      );
      if (out.conflicts.length) {
        pending.push(w);
        continue;
      }
      live.push(...out.granted);
      result = { status: "granted", locks: out.granted, renewed: out.renewed };
    }
    await t`UPDATE axis.waiters SET result = ${t.json(result as never)} WHERE id = ${w.id}`;
  }
}

async function jobRows(q: Q, where: postgres.PendingQuery<postgres.Row[]>): Promise<Job[]> {
  const rows = await q<JobRow[]>`
    SELECT j.*, a.name AS assignee_name, a.vendor AS assignee_vendor, a.member AS assignee_member, a.device AS assignee_device
    FROM axis.jobs j LEFT JOIN axis.agents a ON a.id = j.assignee ${where}`;
  return rows.map(toJob);
}

async function jobRow(q: Q, projectId: string, id: string): Promise<Job | null> {
  const [job] = await jobRows(q, q`WHERE j.project_id = ${projectId} AND j.id = ${id}`);
  return job ?? null;
}

async function unmetDeps(t: Tx, projectId: string, deps: string[]): Promise<string[]> {
  if (!deps.length) return [];
  const rows = await t<
    { id: string; status: string }[]
  >`SELECT id, status FROM axis.jobs WHERE project_id = ${projectId} AND id IN ${t(deps)}`;
  // A dependency on a job that does not exist can never be met; treat it as met rather than wedging the job forever.
  return deps.filter((d) => rows.some((r) => r.id === d && r.status !== "done"));
}

function toJob(r: JobRow): Job {
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    priority: r.priority,
    status: r.status,
    dependencies: r.dependencies,
    assignee:
      r.assignee && r.assignee_name
        ? {
            id: r.assignee,
            name: r.assignee_name,
            vendor: r.assignee_vendor!,
            member: r.assignee_member!,
            device: r.assignee_device!,
          }
        : undefined,
    createdBy: r.created_by,
    createdAt: n(r.created_at),
    updatedAt: n(r.updated_at),
    outcome: r.outcome ?? undefined,
  };
}

function agentRef(r: Pick<AgentRow, "id" | "name" | "vendor" | "member" | "device">): AgentRef {
  return { id: r.id, name: r.name, vendor: r.vendor, member: r.member, device: r.device };
}

function toAgent(r: AgentRow, now: number): Agent {
  const idle = now - n(r.last_seen_at);
  return {
    ...agentRef(r),
    status: idle < ACTIVE_MS ? "active" : idle < IDLE_MS ? "idle" : "offline",
    task: r.task ?? undefined,
    startedAt: n(r.started_at),
    lastSeenAt: n(r.last_seen_at),
  };
}

function uniqueTargets(ts: Target[]): Target[] {
  const seen = new Set<string>();
  return ts.filter((t) => {
    const k = `${t.path}#${t.symbol}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
