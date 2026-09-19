import { expect, test } from "bun:test";
import { migratePostgres } from "../../src/hub/postgres-schema.ts";
import { PostgresStore } from "../../src/hub/postgres-store.ts";
import { SqliteStore } from "../../src/hub/sqlite-store.ts";
import type { Store } from "../../src/hub/store.ts";
import { formatTarget, parseTarget } from "../../src/protocol/target.ts";
import type { AgentRef, Lock, Target } from "../../src/protocol/types.ts";

/**
 * SQLite and Postgres implement the same store by hand, queue servicing and
 * lock relations included. Drive both with one identical, seeded sequence of
 * operations and require the same answer, and the same lock table, after
 * every step. Any drift between the two is a bug in one of them.
 */

const PG = process.env.AXIS_TEST_PG;
const LEASE = 3_600_000;
const POOL = [
  "a.ts",
  "a.ts#X",
  "a.ts#X.m",
  "a.ts#X.n",
  "a.ts#Y",
  "a.ts#(top)",
  "b.ts",
  "b.ts#Z",
  "c.md",
];
const NAMES = ["ana", "ben", "cat", "dan", "eve"];

/** Deterministic PRNG (mulberry32), so a failure replays exactly. */
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class World {
  agents = new Map<string, AgentRef>();
  waiters: string[] = [];
  project = "";
  constructor(readonly store: Store) {}
  async init() {
    const p = await this.store.createProject("diff", "dana");
    this.project = p.project.id;
    const member = (await this.store.authenticate(p.memberToken))!;
    for (const name of NAMES) {
      const { agent } = await this.store.startAgent(member, { name, vendor: "t", device: "d" });
      this.agents.set(name, agent);
    }
  }
  /** Everything comparable about the lock table, ids stripped. */
  async table() {
    return (await this.store.listLocks(this.project))
      .map((l) => `${formatTarget(l)} ${l.agent.name} ${l.intent}`)
      .sort();
  }
}

const norm = (x: unknown): unknown => {
  if (Array.isArray(x)) {
    const items = x.map(norm);
    return items.every((i) => typeof i === "string") ? [...(items as string[])].sort() : items;
  }
  if (x && typeof x === "object") {
    const o = x as Record<string, unknown>;
    if ("path" in o && "symbol" in o && "agent" in o) {
      const l = o as unknown as Lock;
      return `${formatTarget(l)} ${l.agent.name}`;
    }
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o).sort())
      if (!["id", "acquiredAt", "expiresAt", "seq"].includes(k)) out[k] = norm(o[k]);
    return out;
  }
  return x;
};

const SEEDS = (process.env.AXIS_DIFF_SEEDS ?? "20260919,7,42").split(",").map(Number);

test.skipIf(!PG).each(SEEDS)(
  "sqlite and postgres agree on 600 random operations (seed %d)",
  async (seed) => {
    await migratePostgres(PG!);
    const worlds = [
      new World(new SqliteStore(":memory:")),
      new World(new PostgresStore(PG!, { max: 4 })),
    ];
    for (const w of worlds) await w.init();
    const rand = rng(seed);
    const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)]!;
    const targets = () => {
      const n = 1 + Math.floor(rand() * 2);
      return [...new Set(Array.from({ length: n }, () => pick(POOL)))].map(parseTarget) as Target[];
    };
    const base = Date.now();
    try {
      for (let step = 0; step < 600; step++) {
        const now = base + step;
        const who = pick(NAMES);
        const r = rand();
        let op: string;
        let run: (w: World) => Promise<unknown>;
        if (r < 0.35) {
          const t = targets();
          op = `acquire ${who} ${t.map(formatTarget)}`;
          run = (w) =>
            w.store.acquire(w.project, w.agents.get(who)!, t, `i${step}`, undefined, LEASE, now);
        } else if (r < 0.55) {
          const t = rand() < 0.3 ? ("all" as const) : targets();
          op = `release ${who} ${t === "all" ? "all" : t.map(formatTarget)}`;
          run = (w) => w.store.release(w.project, w.agents.get(who)!.id, t);
        } else if (r < 0.7) {
          const t = targets();
          const acquire = rand() < 0.8;
          op = `enqueue ${who} ${t.map(formatTarget)} acquire=${acquire}`;
          run = async (w) => {
            w.waiters.push(
              await w.store.enqueueWaiter(w.project, w.agents.get(who)!, t, {
                acquire,
                intent: `q${step}`,
                deadline: base + 10_000_000,
                leaseMs: LEASE,
              })
            );
            return "queued";
          };
        } else if (r < 0.8) {
          const i = Math.floor(rand() * 1000);
          op = `try waiter #${i}`;
          run = async (w) =>
            w.waiters.length ? w.store.tryWaiter(w.waiters[i % w.waiters.length]!, now) : "none";
        } else if (r < 0.85) {
          const i = Math.floor(rand() * 1000);
          op = `drop waiter #${i}`;
          run = async (w) =>
            w.waiters.length ? w.store.dropWaiter(w.waiters[i % w.waiters.length]!) : "none";
        } else if (r < 0.9) {
          const t = targets();
          op = `force ${t.map(formatTarget)}`;
          run = (w) => w.store.forceRelease(w.project, t);
        } else if (r < 0.93) {
          op = `collect ${who}`;
          run = (w) => w.store.collectServed(w.agents.get(who)!.id);
        } else if (r < 0.96) {
          const [from, to] = rand() < 0.5 ? ["a.ts", "d.ts"] : ["d.ts", "a.ts"];
          op = `move ${from} ${to}`;
          run = (w) => w.store.moveLocks(w.project, from, to);
        } else if (r < 0.98) {
          op = `rename ${who} a.ts X.m -> X.n`;
          run = (w) => w.store.renameLock(w.project, w.agents.get(who)!.id, "a.ts", "X.m", "X.n");
        } else {
          op = `queue depth a.ts#X for ${who}`;
          run = (w) =>
            w.store.queueDepth(w.project, parseTarget("a.ts#X"), w.agents.get(who)!.id, now);
        }
        const [x, y] = await Promise.all(worlds.map((w) => run(w)));
        const [tx, ty] = await Promise.all(worlds.map((w) => w.table()));
        const at = `step ${step}: ${op}`;
        expect({ at, result: norm(y) }).toEqual({ at, result: norm(x) });
        expect({ at, table: ty }).toEqual({ at, table: tx });
      }
    } finally {
      for (const w of worlds) w.store.close();
    }
  }
);
