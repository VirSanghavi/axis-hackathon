import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
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
  Handoff,
  ClaimOutcome,
  NewProject,
  Principal,
  Store,
} from "./store.ts";

const PRIORITY_RANK: Record<Priority, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const ACTIVE_MS = 2 * 60_000;
const IDLE_MS = 15 * 60_000;
const DEVICE_ONLINE_MS = 90_000;

interface LockRow {
  id: string;
  project_id: string;
  path: string;
  symbol: string;
  agent_id: string;
  agent_name: string;
  vendor: string;
  member: string;
  device: string;
  intent: string;
  job_id: string | null;
  acquired_at: number;
  expires_at: number;
}

interface JobRow {
  id: string;
  project_id: string;
  title: string;
  description: string;
  priority: Priority;
  status: JobStatus;
  dependencies: string;
  assignee: string | null;
  created_by: string;
  created_at: number;
  updated_at: number;
  outcome: string | null;
}

interface WaiterRow {
  seq: number;
  id: string;
  project_id: string;
  agent_id: string;
  targets: string;
  acquire: number;
  intent: string;
  job_id: string | null;
  deadline: number;
  lease_ms: number;
  result: string | null;
}

/** Served waiters stay this long for their agent to collect the hand-off. */
const SERVED_KEEP_MS = 24 * 3600_000;

type WaitOutcome = { status: "granted"; locks: Lock[]; renewed: Lock[] } | { status: "free" };

interface AgentRow {
  id: string;
  project_id: string;
  name: string;
  vendor: string;
  member: string;
  device: string;
  task: string | null;
  started_at: number;
  last_seen_at: number;
  ended_at: number | null;
}

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  invite TEXT NOT NULL UNIQUE,
  job_seq INTEGER NOT NULL DEFAULT 0,
  soul_context TEXT NOT NULL DEFAULT '',
  soul_conventions TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  vendor TEXT NOT NULL,
  member TEXT NOT NULL,
  device TEXT NOT NULL,
  task TEXT,
  token_hash TEXT NOT NULL UNIQUE,
  started_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE INDEX IF NOT EXISTS agents_project ON agents(project_id, ended_at);
CREATE TABLE IF NOT EXISTS locks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  symbol TEXT NOT NULL,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  intent TEXT NOT NULL,
  job_id TEXT,
  acquired_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  UNIQUE(project_id, path, symbol)
);
CREATE INDEX IF NOT EXISTS locks_path ON locks(project_id, path);
CREATE INDEX IF NOT EXISTS locks_agent ON locks(agent_id);
CREATE TABLE IF NOT EXISTS waiters (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  targets TEXT NOT NULL,
  acquire INTEGER NOT NULL,
  intent TEXT NOT NULL,
  job_id TEXT,
  deadline INTEGER NOT NULL,
  lease_ms INTEGER NOT NULL,
  -- Set when the queue hands this waiter its targets; the waiting call collects it.
  result TEXT
);
CREATE INDEX IF NOT EXISTS waiters_project ON waiters(project_id, seq);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  priority TEXT NOT NULL,
  status TEXT NOT NULL,
  dependencies TEXT NOT NULL DEFAULT '[]',
  assignee TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  outcome TEXT,
  PRIMARY KEY (project_id, id)
);
CREATE TABLE IF NOT EXISTS devices (
  id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  member TEXT NOT NULL,
  hostname TEXT NOT NULL,
  platform TEXT NOT NULL,
  tier TEXT NOT NULL,
  sealed TEXT NOT NULL DEFAULT '[]',
  health TEXT NOT NULL DEFAULT '{}',
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, id)
);
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  agent TEXT,
  text TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_project ON events(project_id, seq);
`;

export class SqliteStore implements Store {
  private db: Database;

  constructor(file: string) {
    if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
    this.db = new Database(file, { create: true, strict: true });
    this.db.exec(SCHEMA);
    // Hubs created before devices reported their health.
    const cols = this.db.query("PRAGMA table_info(devices)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "health"))
      this.db.exec("ALTER TABLE devices ADD COLUMN health TEXT NOT NULL DEFAULT '{}'");
  }

  close(): void {
    this.db.close();
  }

  // ── projects + auth ───────────────────────────────────────────────────────

  async createProject(name: string, memberName: string): Promise<NewProject> {
    const now = Date.now();
    const id = newId("p");
    const invite = shortCode();
    const token = newToken("axm");
    this.db.transaction(() => {
      this.db
        .query("INSERT INTO projects (id, name, invite, created_at) VALUES (?, ?, ?, ?)")
        .run(id, name, invite, now);
      this.db
        .query(
          "INSERT INTO members (id, project_id, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?)"
        )
        .run(newId("m"), id, memberName, hashToken(token), now);
    })();
    return { project: { id, name }, memberToken: token, invite };
  }

  async join(invite: string, memberName: string) {
    const project = this.db.query("SELECT id, name FROM projects WHERE invite = ?").get(invite) as {
      id: string;
      name: string;
    } | null;
    if (!project) return null;
    const token = newToken("axm");
    this.db
      .query(
        "INSERT INTO members (id, project_id, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?)"
      )
      .run(newId("m"), project.id, memberName, hashToken(token), Date.now());
    return { projectId: project.id, projectName: project.name, memberToken: token };
  }

  async rotateInvite(projectId: string): Promise<string> {
    const invite = shortCode();
    this.db.query("UPDATE projects SET invite = ? WHERE id = ?").run(invite, projectId);
    return invite;
  }

  async getInvite(projectId: string): Promise<string | null> {
    const row = this.db.query("SELECT invite FROM projects WHERE id = ?").get(projectId) as {
      invite: string;
    } | null;
    return row?.invite ?? null;
  }

  async authenticate(token: string): Promise<Principal | null> {
    const h = hashToken(token);
    const agent = this.db
      .query(
        `SELECT a.*, m.name AS member_name, p.name AS project_name FROM agents a
         JOIN members m ON m.id = a.member_id JOIN projects p ON p.id = a.project_id
         WHERE a.token_hash = ? AND a.ended_at IS NULL`
      )
      .get(h) as
      (AgentRow & { member_id: string; member_name: string; project_name: string }) | null;
    if (agent) {
      return {
        kind: "agent",
        projectId: agent.project_id,
        projectName: agent.project_name,
        memberId: agent.member_id,
        memberName: agent.member_name,
        agent: agentRef(agent),
      };
    }
    const member = this.db
      .query(
        "SELECT m.id, m.name, m.project_id, p.name AS project_name FROM members m JOIN projects p ON p.id = m.project_id WHERE m.token_hash = ?"
      )
      .get(h) as { id: string; name: string; project_id: string; project_name: string } | null;
    if (!member) return null;
    return {
      kind: "member",
      projectId: member.project_id,
      projectName: member.project_name,
      memberId: member.id,
      memberName: member.name,
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
    this.db
      .query(
        `INSERT INTO agents (id, project_id, member_id, name, vendor, member, device, task, token_hash, started_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        p.projectId,
        p.memberId,
        input.name,
        input.vendor,
        p.memberName,
        input.device,
        input.task ?? null,
        hashToken(token),
        now,
        now
      );
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
    this.db.transaction(() => {
      if (task !== undefined) {
        this.db
          .query("UPDATE agents SET last_seen_at = ?, task = ? WHERE id = ?")
          .run(now, task, agentId);
      } else {
        this.db.query("UPDATE agents SET last_seen_at = ? WHERE id = ?").run(now, agentId);
      }
      this.db
        .query("UPDATE locks SET expires_at = ? WHERE agent_id = ? AND expires_at < ?")
        .run(now + leaseMs, agentId, now + leaseMs);
    })();
  }

  async endAgent(agentId: string): Promise<Lock[]> {
    return this.db.transaction(() => {
      const held = this.lockRows("WHERE l.agent_id = ?", agentId);
      this.db.query("DELETE FROM locks WHERE agent_id = ?").run(agentId);
      this.db.query("DELETE FROM waiters WHERE agent_id = ?").run(agentId);
      this.db.query("UPDATE agents SET ended_at = ? WHERE id = ?").run(Date.now(), agentId);
      // A job the agent was mid-way through goes back on the board.
      this.db
        .query(
          "UPDATE jobs SET status = 'todo', assignee = NULL, updated_at = ? WHERE assignee = ? AND status = 'in_progress'"
        )
        .run(Date.now(), agentId);
      const project = this.db.query("SELECT project_id FROM agents WHERE id = ?").get(agentId) as {
        project_id: string;
      } | null;
      if (project && held.length) this.serviceQueue(project.project_id, Date.now());
      return held;
    })();
  }

  async listAgents(projectId: string): Promise<Agent[]> {
    const now = Date.now();
    const rows = this.db
      .query(
        "SELECT * FROM agents WHERE project_id = ? AND (ended_at IS NULL) AND last_seen_at > ? ORDER BY started_at"
      )
      .all(projectId, now - 24 * 3600_000) as AgentRow[];
    return rows.map((r) => toAgent(r, now));
  }

  async getAgent(agentId: string): Promise<Agent | null> {
    const row = this.db.query("SELECT * FROM agents WHERE id = ?").get(agentId) as AgentRow | null;
    return row ? toAgent(row, Date.now()) : null;
  }

  // ── locks ─────────────────────────────────────────────────────────────────

  async acquire(
    projectId: string,
    agent: AgentRef,
    targets: Target[],
    intent: string,
    jobId: string | undefined,
    leaseMs: number,
    now: number
  ): Promise<AcquireOutcome> {
    return this.db.transaction(() => {
      // Anyone already queued is served before a newcomer, even on a lease that lapsed unswept.
      this.serviceQueue(projectId, now);
      return this.acquireSync(projectId, agent, targets, intent, jobId, leaseMs, now);
    })();
  }

  private acquireSync(
    projectId: string,
    agent: AgentRef,
    targets: Target[],
    intent: string,
    jobId: string | undefined,
    leaseMs: number,
    now: number
  ): AcquireOutcome {
    {
      // Lapsed leases are ignored here and announced by the hub's expiry sweep, so
      // anyone waiting on them is woken even when nobody else touches the project.
      const conflicts: Conflict[] = [];
      const renewed: Lock[] = [];
      const fresh: Target[] = [];
      const sameIds = new Set<string>();
      for (const t of uniqueTargets(targets)) {
        const rows = this.lockRows(
          // Ordered, so a denial lists its conflicts the same way on every store.
          "WHERE l.project_id = ? AND l.path = ? AND l.expires_at > ? ORDER BY l.symbol",
          projectId,
          t.path,
          now
        );
        let mine: Lock | undefined;
        for (const lock of rows) {
          const rel = relation(t, lock);
          if (!rel) continue;
          if (lock.agent.id === agent.id) {
            // Holding the same target, or something that encloses it, already covers it.
            // Holding something inside it is upgraded below (all-or-nothing still applies).
            if (rel === "same" || rel === "encloses") mine = lock;
            continue;
          }
          conflicts.push({
            target: t.symbol ? `${t.path}#${t.symbol}` : t.path,
            lock,
            relation: rel,
          });
        }
        if (mine) {
          if (!renewed.some((r) => r.id === mine!.id)) renewed.push(mine);
          if (mine.path === t.path && mine.symbol === t.symbol) sameIds.add(mine.id);
        } else fresh.push(t);
      }
      // All-or-nothing: a partial batch would block others while still not letting the caller work.
      if (conflicts.length > 0) return { granted: [], renewed: [], conflicts };

      const expires = now + leaseMs;
      for (const l of renewed) {
        // Re-requesting the exact target restates why you hold it; covering it via an
        // enclosing lock keeps that lock's original reason.
        const nextIntent = sameIds.has(l.id) ? intent : l.intent;
        this.db
          .query("UPDATE locks SET expires_at = ?, intent = ? WHERE id = ?")
          .run(expires, nextIntent, l.id);
        l.expiresAt = expires;
        l.intent = nextIntent;
      }
      const granted: Lock[] = [];
      for (const t of fresh) {
        // Taking an enclosing lock subsumes the caller's own narrower locks.
        const own = this.lockRows(
          "WHERE l.project_id = ? AND l.path = ? AND l.agent_id = ?",
          projectId,
          t.path,
          agent.id
        );
        for (const o of own)
          if (relation(t, o) === "within")
            this.db.query("DELETE FROM locks WHERE id = ?").run(o.id);
        // A lapsed row for this exact target may still exist until the sweep runs.
        this.db
          .query(
            "DELETE FROM locks WHERE project_id = ? AND path = ? AND symbol = ? AND expires_at <= ?"
          )
          .run(projectId, t.path, t.symbol, now);
        const id = newId("l");
        this.db
          .query(
            `INSERT INTO locks (id, project_id, path, symbol, agent_id, intent, job_id, acquired_at, expires_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(id, projectId, t.path, t.symbol, agent.id, intent, jobId ?? null, now, expires);
        granted.push({
          id,
          path: t.path,
          symbol: t.symbol,
          agent,
          intent,
          jobId,
          acquiredAt: now,
          expiresAt: expires,
        });
      }
      return { granted, renewed, conflicts: [] };
    }
  }

  // ── wait queue ────────────────────────────────────────────────────────────

  async enqueueWaiter(
    projectId: string,
    agent: AgentRef,
    targets: Target[],
    opts: { acquire: boolean; intent: string; jobId?: string; deadline: number; leaseMs: number }
  ): Promise<string> {
    const id = newId("w");
    this.db
      .query(
        "INSERT INTO waiters (id, project_id, agent_id, targets, acquire, intent, job_id, deadline, lease_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        id,
        projectId,
        agent.id,
        JSON.stringify(targets),
        opts.acquire ? 1 : 0,
        opts.intent,
        opts.jobId ?? null,
        opts.deadline,
        opts.leaseMs
      );
    return id;
  }

  async tryWaiter(waiterId: string, now: number) {
    return this.db.transaction((): WaitOutcome | { status: "gone" } | null => {
      const w = this.db.query("SELECT project_id FROM waiters WHERE id = ?").get(waiterId) as {
        project_id: string;
      } | null;
      if (!w) return { status: "gone" };
      this.serviceQueue(w.project_id, now);
      const row = this.db.query("SELECT result FROM waiters WHERE id = ?").get(waiterId) as {
        result: string | null;
      } | null;
      if (!row) return { status: "gone" };
      if (!row.result) return null;
      this.db.query("DELETE FROM waiters WHERE id = ?").run(waiterId);
      return JSON.parse(row.result) as WaitOutcome;
    })();
  }

  /**
   * Hand freed targets to the queue, oldest first. Runs inside every transaction
   * that can free a lock, so a release and the hand-off to the next waiter are one
   * atomic step: nobody can slip in between them, on this hub or any other.
   */
  private serviceQueue(projectId: string, now: number): void {
    // Unserved waiters leave at their deadline. Served ones stay until their agent collects
    // the hand-off (see collectServed), so a grant is never lost, for at most a day.
    this.db
      .query(
        "DELETE FROM waiters WHERE project_id = ? AND ((result IS NULL AND deadline < ?) OR deadline < ?)"
      )
      .run(projectId, now, now - SERVED_KEEP_MS);
    const queue = this.db
      .query("SELECT * FROM waiters WHERE project_id = ? AND result IS NULL ORDER BY seq")
      .all(projectId) as WaiterRow[];
    if (!queue.length) return;
    const pending: WaiterRow[] = [];
    for (const w of queue) {
      const targets = JSON.parse(w.targets) as Target[];
      // An earlier acquiring waiter from someone else on an overlapping target goes first.
      const blocked = pending.some(
        (a) =>
          a.acquire &&
          a.agent_id !== w.agent_id &&
          (JSON.parse(a.targets) as Target[]).some((x) => targets.some((y) => relation(x, y)))
      );
      const busy =
        !blocked &&
        this.lockRows(
          "WHERE l.project_id = ? AND l.agent_id != ? AND l.expires_at > ?",
          projectId,
          w.agent_id,
          now
        ).some((l) => targets.some((t) => relation(t, l)));
      if (blocked || busy) {
        pending.push(w);
        continue;
      }
      let result: WaitOutcome;
      if (!w.acquire) result = { status: "free" };
      else {
        const agentRow = this.db
          .query("SELECT * FROM agents WHERE id = ? AND ended_at IS NULL")
          .get(w.agent_id) as AgentRow | null;
        if (!agentRow) {
          this.db.query("DELETE FROM waiters WHERE id = ?").run(w.id);
          continue;
        }
        const out = this.acquireSync(
          projectId,
          agentRef(agentRow),
          targets,
          w.intent,
          w.job_id ?? undefined,
          w.lease_ms,
          now
        );
        if (out.conflicts.length) {
          pending.push(w);
          continue;
        }
        result = { status: "granted", locks: out.granted, renewed: out.renewed };
      }
      this.db.query("UPDATE waiters SET result = ? WHERE id = ?").run(JSON.stringify(result), w.id);
    }
  }

  async dropWaiter(waiterId: string): Promise<WaitOutcome | null> {
    // A hand-off can land between the waiter's last check and its timeout; return it, never strand it.
    return this.db.transaction((): WaitOutcome | null => {
      const row = this.db.query("SELECT result FROM waiters WHERE id = ?").get(waiterId) as {
        result: string | null;
      } | null;
      this.db.query("DELETE FROM waiters WHERE id = ?").run(waiterId);
      return row?.result ? (JSON.parse(row.result) as WaitOutcome) : null;
    })();
  }

  async queueDepth(
    projectId: string,
    target: Target,
    exceptAgentId: string,
    now: number
  ): Promise<number> {
    const rows = this.db
      .query(
        "SELECT targets FROM waiters WHERE project_id = ? AND agent_id != ? AND deadline >= ? AND result IS NULL"
      )
      .all(projectId, exceptAgentId, now) as { targets: string }[];
    return rows.filter((r) => (JSON.parse(r.targets) as Target[]).some((t) => relation(t, target)))
      .length;
  }

  async release(projectId: string, agentId: string, targets: Target[] | "all"): Promise<Lock[]> {
    return this.db.transaction(() => {
      const held = this.lockRows("WHERE l.project_id = ? AND l.agent_id = ?", projectId, agentId);
      const out =
        targets === "all"
          ? held
          : held.filter((l) =>
              targets.some(
                (t) =>
                  t.path === l.path &&
                  (t.symbol === l.symbol || (t.symbol === "" && l.path === t.path))
              )
            );
      for (const l of out) this.db.query("DELETE FROM locks WHERE id = ?").run(l.id);
      if (out.length) this.serviceQueue(projectId, Date.now());
      return out;
    })();
  }

  async forceRelease(projectId: string, targets: Target[]): Promise<Lock[]> {
    return this.db.transaction(() => {
      const out: Lock[] = [];
      for (const t of targets) {
        for (const l of this.lockRows("WHERE l.project_id = ? AND l.path = ?", projectId, t.path)) {
          if (relation(t, l)) {
            this.db.query("DELETE FROM locks WHERE id = ?").run(l.id);
            out.push(l);
          }
        }
      }
      if (out.length) this.serviceQueue(projectId, Date.now());
      return out;
    })();
  }

  async expireAll(now: number): Promise<{ projectId: string; lock: Lock }[]> {
    return this.db.transaction(() => {
      const rows = this.db
        .query("SELECT id, project_id FROM locks WHERE expires_at <= ?")
        .all(now) as { id: string; project_id: string }[];
      if (rows.length === 0) return [];
      const byId = new Map(rows.map((r) => [r.id, r.project_id]));
      const gone = this.lockRows("WHERE l.expires_at <= ?", now);
      this.db.query("DELETE FROM locks WHERE expires_at <= ?").run(now);
      for (const projectId of new Set(byId.values())) this.serviceQueue(projectId, now);
      return gone.map((lock) => ({ projectId: byId.get(lock.id)!, lock }));
    })();
  }

  async collectServed(agentId: string): Promise<Handoff[]> {
    return this.db.transaction(() => {
      const rows = this.db
        .query("SELECT * FROM waiters WHERE agent_id = ? AND result IS NOT NULL ORDER BY seq")
        .all(agentId) as WaiterRow[];
      for (const r of rows) this.db.query("DELETE FROM waiters WHERE id = ?").run(r.id);
      return rows.map((r) => ({
        targets: JSON.parse(r.targets) as Target[],
        intent: r.intent,
        outcome: JSON.parse(r.result!) as WaitOutcome,
      }));
    })();
  }

  async expireContended(now: number, idleMs: number): Promise<{ projectId: string; lock: Lock }[]> {
    return this.db.transaction(() => {
      const waiters = this.db
        .query("SELECT * FROM waiters WHERE result IS NULL AND deadline >= ?")
        .all(now) as WaiterRow[];
      if (!waiters.length) return [];
      const out: { projectId: string; lock: Lock }[] = [];
      for (const projectId of new Set(waiters.map((w) => w.project_id))) {
        const queued = waiters
          .filter((w) => w.project_id === projectId)
          .map((w) => ({ agent: w.agent_id, targets: JSON.parse(w.targets) as Target[] }));
        const idle = this.db
          .query(
            `SELECT l.id FROM locks l JOIN agents a ON a.id = l.agent_id
             WHERE l.project_id = ? AND l.expires_at > ? AND a.last_seen_at < ?`
          )
          .all(projectId, now, now - idleMs) as { id: string }[];
        if (!idle.length) continue;
        const ids = new Set(idle.map((r) => r.id));
        const gone = this.lockRows("WHERE l.project_id = ?", projectId).filter(
          (l) =>
            ids.has(l.id) &&
            queued.some((q) => q.agent !== l.agent.id && q.targets.some((t) => relation(t, l)))
        );
        for (const l of gone) this.db.query("DELETE FROM locks WHERE id = ?").run(l.id);
        if (gone.length) this.serviceQueue(projectId, now);
        out.push(...gone.map((lock) => ({ projectId, lock })));
      }
      return out;
    })();
  }

  async listLocks(projectId: string): Promise<Lock[]> {
    return this.lockRows(
      "WHERE l.project_id = ? AND l.expires_at > ? ORDER BY l.path, l.symbol",
      projectId,
      Date.now()
    );
  }

  async locksOf(agentId: string): Promise<Lock[]> {
    return this.lockRows("WHERE l.agent_id = ? AND l.expires_at > ?", agentId, Date.now());
  }

  async renameLock(
    projectId: string,
    agentId: string,
    filePath: string,
    from: string,
    to: string
  ): Promise<boolean> {
    return this.db.transaction(() => {
      const clash = this.db
        .query("SELECT agent_id FROM locks WHERE project_id = ? AND path = ? AND symbol = ?")
        .get(projectId, filePath, to) as { agent_id: string } | null;
      if (clash && clash.agent_id !== agentId) return false;
      if (clash)
        this.db
          .query(
            "DELETE FROM locks WHERE project_id = ? AND agent_id = ? AND path = ? AND symbol = ?"
          )
          .run(projectId, agentId, filePath, from);
      else
        this.db
          .query(
            "UPDATE locks SET symbol = ? WHERE project_id = ? AND agent_id = ? AND path = ? AND symbol = ?"
          )
          .run(to, projectId, agentId, filePath, from);
      return true;
    })();
  }

  async moveLocks(projectId: string, from: string, to: string): Promise<Lock[]> {
    return this.db.transaction(() => {
      const moving = this.lockRows("WHERE l.project_id = ? AND l.path = ?", projectId, from);
      if (!moving.length) return [];
      const moved: Lock[] = [];
      for (const l of moving) {
        const taken = this.db
          .query("SELECT 1 FROM locks WHERE project_id = ? AND path = ? AND symbol = ?")
          .get(projectId, to, l.symbol);
        // Someone already holds the same unit at the destination; theirs stands.
        if (taken) this.db.query("DELETE FROM locks WHERE id = ?").run(l.id);
        else {
          this.db.query("UPDATE locks SET path = ? WHERE id = ?").run(to, l.id);
          moved.push({ ...l, path: to });
        }
      }
      for (const w of this.db
        .query("SELECT id, targets FROM waiters WHERE project_id = ?")
        .all(projectId) as { id: string; targets: string }[]) {
        const targets = JSON.parse(w.targets) as Target[];
        if (!targets.some((t) => t.path === from)) continue;
        const next = targets.map((t) => (t.path === from ? { ...t, path: to } : t));
        this.db
          .query("UPDATE waiters SET targets = ? WHERE id = ?")
          .run(JSON.stringify(next), w.id);
      }
      this.serviceQueue(projectId, Date.now());
      return moved;
    })();
  }

  private lockRows(where: string, ...args: (string | number)[]): Lock[] {
    const rows = this.db
      .query(
        `SELECT l.*, a.name AS agent_name, a.vendor, a.member, a.device FROM locks l
         JOIN agents a ON a.id = l.agent_id ${where}`
      )
      .all(...args) as LockRow[];
    return rows.map(toLock);
  }

  // ── jobs ──────────────────────────────────────────────────────────────────

  async postJob(
    projectId: string,
    by: string,
    input: { title: string; description: string; priority: Priority; dependencies: string[] }
  ): Promise<Job> {
    return this.db.transaction(() => {
      this.db.query("UPDATE projects SET job_seq = job_seq + 1 WHERE id = ?").run(projectId);
      const { job_seq } = this.db
        .query("SELECT job_seq FROM projects WHERE id = ?")
        .get(projectId) as { job_seq: number };
      const id = `J${job_seq}`;
      const now = Date.now();
      this.db
        .query(
          `INSERT INTO jobs (id, project_id, title, description, priority, status, dependencies, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'todo', ?, ?, ?, ?)`
        )
        .run(
          id,
          projectId,
          input.title,
          input.description,
          input.priority,
          JSON.stringify(input.dependencies),
          by,
          now,
          now
        );
      return this.jobRow(projectId, id)!;
    })();
  }

  async claimNext(projectId: string, agent: AgentRef, now: number): Promise<ClaimOutcome> {
    return this.db.transaction((): ClaimOutcome => {
      const todo = (
        this.db
          .query("SELECT * FROM jobs WHERE project_id = ? AND status = 'todo'")
          .all(projectId) as JobRow[]
      ).sort(
        (a, b) =>
          PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.created_at - b.created_at
      );
      const blocked: { id: string; title: string; waitingOn: string[] }[] = [];
      for (const row of todo) {
        const waitingOn = this.unmetDeps(projectId, row);
        if (waitingOn.length) {
          blocked.push({ id: row.id, title: row.title, waitingOn });
          continue;
        }
        this.db
          .query(
            "UPDATE jobs SET status = 'in_progress', assignee = ?, updated_at = ? WHERE project_id = ? AND id = ?"
          )
          .run(agent.id, now, projectId, row.id);
        return { kind: "claimed", job: this.jobRow(projectId, row.id)! };
      }
      return { kind: "none", blocked };
    })();
  }

  async claim(
    projectId: string,
    agent: AgentRef,
    jobId: string,
    now: number
  ): Promise<ClaimOutcome> {
    return this.db.transaction((): ClaimOutcome => {
      const row = this.db
        .query("SELECT * FROM jobs WHERE project_id = ? AND id = ?")
        .get(projectId, jobId) as JobRow | null;
      if (!row) return { kind: "missing" };
      if (row.status === "done" || row.status === "cancelled")
        return { kind: "unavailable", job: this.toJob(row), reason: "closed" };
      if (row.status === "in_progress") {
        if (row.assignee === agent.id) return { kind: "claimed", job: this.toJob(row) };
        return { kind: "unavailable", job: this.toJob(row), reason: "taken" };
      }
      if (this.unmetDeps(projectId, row).length)
        return { kind: "unavailable", job: this.toJob(row), reason: "blocked" };
      this.db
        .query(
          "UPDATE jobs SET status = 'in_progress', assignee = ?, updated_at = ? WHERE project_id = ? AND id = ?"
        )
        .run(agent.id, now, projectId, jobId);
      return { kind: "claimed", job: this.jobRow(projectId, jobId)! };
    })();
  }

  async completeJob(
    projectId: string,
    agentId: string,
    jobId: string,
    outcome: string,
    now: number
  ) {
    return this.db.transaction((): { job: Job; released: Lock[] } | { error: string } => {
      const row = this.db
        .query("SELECT * FROM jobs WHERE project_id = ? AND id = ?")
        .get(projectId, jobId) as JobRow | null;
      if (!row) return { error: `No job ${jobId}.` };
      if (row.status === "done") return { error: `${jobId} is already done.` };
      if (row.status === "cancelled") return { error: `${jobId} was cancelled.` };
      this.db
        .query(
          "UPDATE jobs SET status = 'done', outcome = ?, updated_at = ?, assignee = COALESCE(assignee, ?) WHERE project_id = ? AND id = ?"
        )
        .run(outcome, now, agentId, projectId, jobId);
      const released = this.lockRows("WHERE l.project_id = ? AND l.job_id = ?", projectId, jobId);
      this.db.query("DELETE FROM locks WHERE project_id = ? AND job_id = ?").run(projectId, jobId);
      if (released.length) this.serviceQueue(projectId, now);
      return { job: this.jobRow(projectId, jobId)!, released };
    })();
  }

  async releaseJob(projectId: string, jobId: string, now: number): Promise<Job | null> {
    const res = this.db
      .query(
        "UPDATE jobs SET status = 'todo', assignee = NULL, updated_at = ? WHERE project_id = ? AND id = ? AND status = 'in_progress'"
      )
      .run(now, projectId, jobId);
    return res.changes ? this.jobRow(projectId, jobId) : null;
  }

  async cancelJob(
    projectId: string,
    jobId: string,
    reason: string,
    now: number
  ): Promise<Job | null> {
    const res = this.db
      .query(
        "UPDATE jobs SET status = 'cancelled', outcome = ?, updated_at = ? WHERE project_id = ? AND id = ? AND status IN ('todo','in_progress')"
      )
      .run(reason, now, projectId, jobId);
    return res.changes ? this.jobRow(projectId, jobId) : null;
  }

  async listJobs(projectId: string, includeClosed: boolean): Promise<Job[]> {
    const rows = this.db
      .query(
        `SELECT * FROM jobs WHERE project_id = ? ${includeClosed ? "" : "AND status IN ('todo','in_progress')"}`
      )
      .all(projectId) as JobRow[];
    return rows
      .map((r) => this.toJob(r))
      .sort(
        (a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.createdAt - b.createdAt
      );
  }

  async getJob(projectId: string, jobId: string): Promise<Job | null> {
    return this.jobRow(projectId, jobId);
  }

  private unmetDeps(projectId: string, row: JobRow): string[] {
    const deps = JSON.parse(row.dependencies) as string[];
    return deps.filter((d) => {
      const dep = this.db
        .query("SELECT status FROM jobs WHERE project_id = ? AND id = ?")
        .get(projectId, d) as { status: string } | null;
      // A dependency on a job that does not exist can never be met; treat it as met rather than wedging the job forever.
      return dep !== null && dep.status !== "done";
    });
  }

  private jobRow(projectId: string, id: string): Job | null {
    const row = this.db
      .query("SELECT * FROM jobs WHERE project_id = ? AND id = ?")
      .get(projectId, id) as JobRow | null;
    return row ? this.toJob(row) : null;
  }

  private toJob(r: JobRow): Job {
    let assignee: AgentRef | undefined;
    if (r.assignee) {
      const a = this.db
        .query("SELECT * FROM agents WHERE id = ?")
        .get(r.assignee) as AgentRow | null;
      if (a) assignee = agentRef(a);
    }
    return {
      id: r.id,
      title: r.title,
      description: r.description,
      priority: r.priority,
      status: r.status,
      dependencies: JSON.parse(r.dependencies),
      assignee,
      createdBy: r.created_by,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      outcome: r.outcome ?? undefined,
    };
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
    this.db
      .query(
        `INSERT INTO devices (id, project_id, member, hostname, platform, tier, sealed, health, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id, id) DO UPDATE SET member = excluded.member, hostname = excluded.hostname, platform = excluded.platform,
           tier = excluded.tier, sealed = excluded.sealed, health = json_patch(devices.health, excluded.health),
           last_seen_at = excluded.last_seen_at`
      )
      .run(
        input.deviceId,
        p.projectId,
        p.memberName,
        input.hostname,
        input.platform,
        input.tier,
        JSON.stringify(input.sealed),
        JSON.stringify(input.health ?? {}),
        now
      );
  }

  async listDevices(projectId: string, now: number): Promise<Device[]> {
    const rows = this.db
      .query("SELECT * FROM devices WHERE project_id = ? AND last_seen_at > ? ORDER BY hostname")
      .all(projectId, now - 24 * 3600_000) as {
      id: string;
      member: string;
      hostname: string;
      platform: string;
      tier: EnforcementTier;
      sealed: string;
      health: string;
      last_seen_at: number;
    }[];
    return rows.map((r) => ({
      id: r.id,
      member: r.member,
      hostname: r.hostname,
      platform: r.platform,
      tier: r.tier,
      sealed: JSON.parse(r.sealed),
      health: JSON.parse(r.health),
      lastSeenAt: r.last_seen_at,
      online: now - r.last_seen_at < DEVICE_ONLINE_MS,
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
    const res = this.db
      .query(
        "INSERT INTO events (project_id, ts, type, agent, text, data) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(projectId, now, type, agent ? JSON.stringify(agent) : null, text, JSON.stringify(data));
    return { seq: Number(res.lastInsertRowid), ts: now, type, agent, text, data };
  }

  async listEvents(projectId: string, sinceSeq: number, limit: number): Promise<AxisEvent[]> {
    const rows = this.db
      .query(
        "SELECT * FROM (SELECT * FROM events WHERE project_id = ? AND seq > ? ORDER BY seq DESC LIMIT ?) ORDER BY seq"
      )
      .all(projectId, sinceSeq, limit) as {
      seq: number;
      ts: number;
      type: EventType;
      agent: string | null;
      text: string;
      data: string;
    }[];
    return rows.map((r) => ({
      seq: r.seq,
      ts: r.ts,
      type: r.type,
      agent: r.agent ? JSON.parse(r.agent) : undefined,
      text: r.text,
      data: JSON.parse(r.data),
    }));
  }

  // ── soul ──────────────────────────────────────────────────────────────────

  async getSoul(projectId: string) {
    const row = this.db
      .query("SELECT soul_context, soul_conventions FROM projects WHERE id = ?")
      .get(projectId) as { soul_context: string; soul_conventions: string } | null;
    return { context: row?.soul_context ?? "", conventions: row?.soul_conventions ?? "" };
  }

  async setSoul(projectId: string, soul: { context?: string; conventions?: string }) {
    if (soul.context !== undefined)
      this.db
        .query("UPDATE projects SET soul_context = ? WHERE id = ?")
        .run(soul.context, projectId);
    if (soul.conventions !== undefined)
      this.db
        .query("UPDATE projects SET soul_conventions = ? WHERE id = ?")
        .run(soul.conventions, projectId);
  }
}

function agentRef(r: Pick<AgentRow, "id" | "name" | "vendor" | "member" | "device">): AgentRef {
  return { id: r.id, name: r.name, vendor: r.vendor, member: r.member, device: r.device };
}

function toAgent(r: AgentRow, now: number): Agent {
  const idle = now - r.last_seen_at;
  return {
    ...agentRef(r),
    status: idle < ACTIVE_MS ? "active" : idle < IDLE_MS ? "idle" : "offline",
    task: r.task ?? undefined,
    startedAt: r.started_at,
    lastSeenAt: r.last_seen_at,
  };
}

function toLock(r: LockRow): Lock {
  return {
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
    acquiredAt: r.acquired_at,
    expiresAt: r.expires_at,
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
