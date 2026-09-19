import { afterEach, describe, expect, test } from "bun:test";
import { advise, validateTargets } from "../../src/hub/hub.ts";
import {
  covers,
  encloses,
  formatTarget,
  parseTarget,
  relation,
} from "../../src/protocol/target.ts";
import type { HolderFacts } from "../../src/protocol/types.ts";
import { until } from "../helpers/fs.ts";
import { testHub } from "../helpers/hub.ts";

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanup) c();
  cleanup = [];
});
async function setup(opts?: Parameters<typeof testHub>[0]) {
  const t = await testHub(opts);
  cleanup.push(t.close);
  return t;
}

describe("targets", () => {
  test("parse and format round-trip", () => {
    expect(parseTarget("./src/a.ts#Auth.login")).toEqual({
      path: "src/a.ts",
      symbol: "Auth.login",
    });
    expect(parseTarget("src/a.ts")).toEqual({ path: "src/a.ts", symbol: "" });
    expect(formatTarget(parseTarget("src/a.ts#(top)"))).toBe("src/a.ts#(top)");
  });

  test("relations nest by dotted path, and the file encloses everything", () => {
    const t = (s: string) => parseTarget(s);
    expect(relation(t("a.ts#A.b"), t("a.ts#A.b"))).toBe("same");
    expect(relation(t("a.ts#A.b"), t("a.ts#A"))).toBe("encloses");
    expect(relation(t("a.ts#A.b"), t("a.ts"))).toBe("encloses");
    expect(relation(t("a.ts"), t("a.ts#A.b"))).toBe("within");
    expect(relation(t("a.ts#A.b"), t("a.ts#A.c"))).toBeNull();
    expect(relation(t("a.ts#A"), t("a.ts#AB"))).toBeNull(); // prefix is not nesting
    expect(relation(t("a.ts#A"), t("b.ts#A"))).toBeNull();
    expect(encloses("", "(top)")).toBe(true);
    expect(covers(t("a.ts#A"), t("a.ts#A.b"))).toBe(true);
    expect(covers(t("a.ts#A.b"), t("a.ts#A"))).toBe(false);
  });

  test("validation accepts real symbol names and rejects escapes", () => {
    const ok = validateTargets([
      "src/a.ts",
      "src/a.ts#Auth.login",
      "src/a.ts#(top)",
      "src/a.py#dup@2",
      "src/a.rs#Vec<T>.push",
      "src/a.ts#$init",
    ]);
    expect(ok.errors).toEqual([]);
    expect(ok.targets).toHaveLength(6);
    const bad = validateTargets(["../etc/passwd", "/abs.ts", "", "a.ts#no spaces"]);
    expect(bad.errors.map((e) => e.code)).toEqual([
      "outside_project",
      "outside_project",
      "empty",
      "bad_symbol",
    ]);
    expect(validateTargets([]).errors[0]!.code).toBe("empty");
  });
});

describe("locks", () => {
  test("sibling functions in one file lock independently; the class and file conflict", async () => {
    const { hub, agent } = await setup();
    const a = await agent("ana");
    const b = await agent("ben", "desktop");
    expect((await hub.acquire(a, ["src/auth.ts#Auth.login"], "fix login")).status).toBe("granted");
    expect((await hub.acquire(b, ["src/auth.ts#Auth.logout"], "fix logout")).status).toBe(
      "granted"
    );

    const cls = await hub.acquire(b, ["src/auth.ts#Auth"], "refactor class");
    expect(cls.status).toBe("denied");
    if (cls.status !== "denied") throw 0;
    expect(cls.conflicts).toHaveLength(1);
    expect(cls.conflicts[0]!.relation).toBe("within");
    expect(cls.conflicts[0]!.lock.intent).toBe("fix login");

    const file = await hub.acquire(b, ["src/auth.ts"], "rewrite");
    expect(file.status).toBe("denied");
  });

  test("a denial carries the holder's reason, freshness, lease and advice", async () => {
    const { hub, agent } = await setup();
    const a = await agent("ana");
    const b = await agent("ben");
    await hub.acquire(a, ["src/auth.ts"], "migrating to argon2");
    const r = await hub.acquire(b, ["src/auth.ts#Auth.login"], "fix typo");
    if (r.status !== "denied") throw new Error("expected denial");
    expect(r.conflicts[0]!.relation).toBe("encloses");
    const h = r.holders[0]!;
    expect(h.agent.name).toBe("ana");
    expect(h.idleMs).toBeLessThan(1000);
    expect(h.expiresInMs).toBeGreaterThan(9 * 60_000);
    expect(h.online).toBe(true);
    expect(r.advice.action).toBe("wait"); // active holder, no other jobs
  });

  test("all-or-nothing: a partly blocked batch grants nothing", async () => {
    const { hub, agent } = await setup();
    const a = await agent("ana");
    const b = await agent("ben");
    await hub.acquire(a, ["x.ts#f"], "f");
    expect((await hub.acquire(b, ["y.ts", "x.ts#f"], "both")).status).toBe("denied");
    expect(await hub.store.locksOf(b.agent!.id)).toHaveLength(0);
  });

  test("re-acquiring renews; an enclosing lock covers and subsumes your own narrower ones", async () => {
    const { hub, agent } = await setup();
    const a = await agent("ana");
    await hub.acquire(a, ["x.ts#A.b"], "b");
    const again = await hub.acquire(a, ["x.ts#A.b"], "b, restated");
    expect(again.status === "granted" && again.renewed).toEqual(["x.ts#A.b"]);
    const up = await hub.acquire(a, ["x.ts#A"], "whole class");
    expect(up.status).toBe("granted");
    const mine = await hub.store.locksOf(a.agent!.id);
    expect(mine.map(formatTarget)).toEqual(["x.ts#A"]);
    const inner = await hub.acquire(a, ["x.ts#A.c"], "c");
    expect(inner.status === "granted" && inner.renewed).toEqual(["x.ts#A"]);
  });

  test("intent is required", async () => {
    const { hub, agent } = await setup();
    const a = await agent("ana");
    await expect(hub.acquire(a, ["x.ts"], "  ")).rejects.toThrow(/intent is required/);
  });

  test("release frees exactly what was named; release of a file frees its symbols", async () => {
    const { hub, agent } = await setup();
    const a = await agent("ana");
    await hub.acquire(a, ["x.ts#f", "x.ts#g", "y.ts"], "work");
    const r1 = await hub.release(a, ["x.ts#f", "z.ts"]);
    expect(r1.released).toEqual(["x.ts#f"]);
    expect(r1.notHeld).toEqual(["z.ts"]);
    const r2 = await hub.release(a, ["x.ts"]);
    expect(r2.released).toEqual(["x.ts#g"]);
    const r3 = await hub.release(a, "all");
    expect(r3.released).toEqual(["y.ts"]);
  });

  test("an ended session releases everything and requeues its job", async () => {
    const { hub, agent, member } = await setup();
    const a = await agent("ana");
    const job = await hub.postJob(member, { title: "ship it" });
    await hub.claim(a, job.id);
    await hub.acquire(a, ["x.ts"], "x", job.id);
    const released = await hub.endAgent(a);
    expect(released).toHaveLength(1);
    expect((await hub.store.getJob(a.projectId, job.id))!.status).toBe("todo");
  });

  test("leases lapse: the sweep frees and announces them", async () => {
    const { hub, agent, projectId } = await setup({ leaseMs: 150, sweepMs: 50 });
    const a = await agent("ana");
    const b = await agent("ben");
    await hub.acquire(a, ["x.ts"], "x");
    // The sweep is periodic; wait for it rather than guessing how long a loaded database takes.
    expect(
      await until(
        async () =>
          (await hub.store.listEvents(projectId, 0, 50)).some((e) => e.type === "lock.expired"),
        5000
      )
    ).toBe(true);
    expect(await hub.store.listLocks(projectId)).toHaveLength(0);
    expect((await hub.acquire(b, ["x.ts"], "mine now")).status).toBe("granted");
  });

  test("force release breaks a lock and records who and why", async () => {
    const { hub, agent, member, projectId } = await setup();
    const a = await agent("ana");
    await hub.acquire(a, ["x.ts#f"], "f");
    await expect(hub.forceRelease(member, ["x.ts"], "")).rejects.toThrow(/reason/);
    const broken = await hub.forceRelease(member, ["x.ts"], "ana crashed");
    expect(broken).toHaveLength(1);
    const e = (await hub.store.listEvents(projectId, 0, 10)).find((x) => x.type === "lock.forced")!;
    expect(e.text).toContain("ana crashed");
  });

  test("concurrent acquires on one target: exactly one wins", async () => {
    const { hub, agent } = await setup();
    const agents = await Promise.all(Array.from({ length: 12 }, (_, i) => agent(`a${i}`)));
    const results = await Promise.all(agents.map((p) => hub.acquire(p, ["hot.ts#f"], "race")));
    expect(results.filter((r) => r.status === "granted")).toHaveLength(1);
  });
});

/**
 * The wait queue, as a table of orderings. Each test names the order in which
 * release (R), wait (W) and a competing acquire (C) arrive.
 */
describe("wait queue orderings", () => {
  test("W then R: the waiter gets the lock the moment it frees", async () => {
    // A 10s fallback poll: returning within 2s proves the release woke the waiter.
    const { hub, agent } = await setup({ pollMs: 10_000 });
    const [a, b] = [await agent("ana"), await agent("ben")];
    await hub.acquire(a, ["x.ts#f"], "f");
    const waiting = hub.wait(b, ["x.ts#f"], { intent: "after ana", timeoutMs: 5000 });
    await Bun.sleep(50);
    const t0 = Date.now();
    await hub.release(a, ["x.ts#f"]);
    const r = await waiting;
    expect(r.status).toBe("granted");
    expect(Date.now() - t0).toBeLessThan(2000);
    expect((await hub.store.locksOf(b.agent!.id)).map(formatTarget)).toEqual(["x.ts#f"]);
  });

  test("R then W: already free, granted immediately", async () => {
    const { hub, agent } = await setup();
    const b = await agent("ben");
    const r = await hub.wait(b, ["x.ts#f"], { intent: "go", timeoutMs: 5000 });
    expect(r.status).toBe("granted");
    expect(r.waitedMs).toBeLessThan(200);
  });

  test("W, then R and C at once: the queued waiter wins, the newcomer is denied", async () => {
    const { hub, agent } = await setup();
    const [a, b, c] = [await agent("ana"), await agent("ben"), await agent("cy")];
    await hub.acquire(a, ["x.ts#f"], "f");
    const waiting = hub.wait(b, ["x.ts#f"], { intent: "queued first", timeoutMs: 5000 });
    await Bun.sleep(30);
    // Release and a competing acquire in the same tick: the hand-off is atomic with the release.
    const [, cRes] = await Promise.all([
      hub.release(a, ["x.ts#f"]),
      hub.acquire(c, ["x.ts#f"], "cut in"),
    ]);
    const r = await waiting;
    expect(r.status).toBe("granted");
    expect(cRes.status).toBe("denied");
    // Either C ran before the release (blocked by ana) or after it (blocked by ben, already handed the lock). Never C.
    if (cRes.status === "denied")
      expect(["ana", "ben"]).toContain(cRes.conflicts[0]!.lock.agent.name);
    expect((await hub.store.locksOf(b.agent!.id)).map(formatTarget)).toEqual(["x.ts#f"]);
  });

  test("two waiters: first come, first served, second is handed it on the next release", async () => {
    const { hub, agent } = await setup();
    const [a, b, c] = [await agent("ana"), await agent("ben"), await agent("cy")];
    await hub.acquire(a, ["x.ts"], "file");
    const wb = hub.wait(b, ["x.ts#f"], { intent: "b", timeoutMs: 5000 });
    await Bun.sleep(20);
    const wc = hub.wait(c, ["x.ts#f"], { intent: "c", timeoutMs: 5000 });
    await Bun.sleep(20);
    const d = await hub.acquire(await agent("dee"), ["x.ts#f"], "peek");
    expect(d.status === "denied" && d.holders[0]!.queue).toBe(2);
    await hub.release(a, "all");
    expect((await wb).status).toBe("granted");
    await hub.release(b, "all");
    expect((await wc).status).toBe("granted");
  });

  test("a waiter behind a non-overlapping waiter is not blocked by it", async () => {
    const { hub, agent } = await setup();
    const [a, b, c] = [await agent("ana"), await agent("ben"), await agent("cy")];
    await hub.acquire(a, ["x.ts#f"], "f");
    const wb = hub.wait(b, ["x.ts#f"], { intent: "b", timeoutMs: 3000 });
    await Bun.sleep(20);
    const rc = await hub.wait(c, ["x.ts#g"], { intent: "c", timeoutMs: 3000 });
    expect(rc.status).toBe("granted");
    await hub.release(a, "all");
    expect((await wb).status).toBe("granted");
  });

  test("W with no R: times out with fresh facts and leaves the queue", async () => {
    const { hub, agent, projectId } = await setup();
    const [a, b] = [await agent("ana"), await agent("ben")];
    await hub.acquire(a, ["x.ts"], "long job");
    const r = await hub.wait(b, ["x.ts"], { intent: "x", timeoutMs: 1000 });
    expect(r.status).toBe("timeout");
    if (r.status !== "timeout") throw 0;
    expect(r.holders[0]!.agent.name).toBe("ana");
    expect(r.advice.action).toBeDefined();
    expect(
      await hub.store.queueDepth(projectId, { path: "x.ts", symbol: "" }, a.agent!.id, Date.now())
    ).toBe(0);
  });

  test("R arrives while the timed-out waiter is leaving: the hand-off is returned, never stranded", async () => {
    const { hub, agent } = await setup();
    const [a, b] = [await agent("ana"), await agent("ben")];
    await hub.acquire(a, ["x.ts"], "x");
    const id = await hub.store.enqueueWaiter(
      b.projectId,
      b.agent!,
      [{ path: "x.ts", symbol: "" }],
      { acquire: true, intent: "i", deadline: Date.now() + 10_000, leaseMs: 60_000 }
    );
    await hub.release(a, "all"); // serves the queue: ben now owns x.ts
    const dropped = await hub.store.dropWaiter(id);
    expect(dropped?.status).toBe("granted");
    expect((await hub.store.locksOf(b.agent!.id)).map(formatTarget)).toEqual(["x.ts"]);
  });

  test("lease lapse hands off to the waiter (holder crashed, never releases)", async () => {
    const { hub, agent } = await setup({ leaseMs: 200, sweepMs: 50 });
    const [a, b] = [await agent("ana"), await agent("ben")];
    await hub.acquire(a, ["x.ts"], "x");
    const r = await hub.wait(b, ["x.ts"], { intent: "after crash", timeoutMs: 3000 });
    expect(r.status).toBe("granted");
  });

  test("an ended waiter leaves the queue and does not block others", async () => {
    const { hub, agent } = await setup();
    const [a, b, c] = [await agent("ana"), await agent("ben"), await agent("cy")];
    await hub.acquire(a, ["x.ts"], "x");
    const wb = hub.wait(b, ["x.ts"], { intent: "b", timeoutMs: 3000 });
    await Bun.sleep(20);
    const wc = hub.wait(c, ["x.ts"], { intent: "c", timeoutMs: 3000 });
    await Bun.sleep(20);
    await hub.endAgent(b);
    await hub.release(a, "all");
    expect((await wc).status).toBe("granted");
    expect((await wb).status).toBe("timeout");
  });

  test("acquire:false waits for free without taking it", async () => {
    const { hub, agent, projectId } = await setup();
    const [a, b] = [await agent("ana"), await agent("ben")];
    await hub.acquire(a, ["x.ts"], "x");
    const w = hub.wait(b, ["x.ts"], { acquire: false, timeoutMs: 3000 });
    await Bun.sleep(20);
    await hub.release(a, "all");
    expect((await w).status).toBe("free");
    expect(await hub.store.listLocks(projectId)).toHaveLength(0);
  });

  test("job completion releases the job's locks and serves the queue", async () => {
    const { hub, agent, member } = await setup();
    const [a, b] = [await agent("ana"), await agent("ben")];
    const job = await hub.postJob(member, { title: "t" });
    await hub.claim(a, job.id);
    await hub.acquire(a, ["x.ts"], "x", job.id);
    const w = hub.wait(b, ["x.ts"], { intent: "b", timeoutMs: 3000 });
    await Bun.sleep(20);
    const done = await hub.completeJob(a, job.id, "shipped");
    expect(done.released).toEqual(["x.ts"]);
    expect((await w).status).toBe("granted");
  });
});

describe("jobs", () => {
  test("claimNext takes the highest priority unblocked job; dependencies gate claiming", async () => {
    const { hub, agent, member } = await setup();
    const a = await agent("ana");
    const low = await hub.postJob(member, { title: "low", priority: "low" });
    const crit = await hub.postJob(member, {
      title: "crit",
      priority: "critical",
      dependencies: [low.id],
    });
    const high = await hub.postJob(member, { title: "high", priority: "high" });
    const first = await hub.claim(a);
    expect(first.status === "claimed" && first.job.id).toBe(high.id);
    const second = await hub.claim(a);
    expect(second.status === "claimed" && second.job.id).toBe(low.id);
    const blocked = await hub.claim(a, crit.id);
    expect(blocked.status === "unavailable" && blocked.reason).toBe("blocked");
    await hub.completeJob(a, low.id, "done");
    expect((await hub.claim(a, crit.id)).status).toBe("claimed");
  });

  test("concurrent claimNext: each job goes to exactly one agent", async () => {
    const { hub, agent, member } = await setup();
    for (let i = 0; i < 3; i++) await hub.postJob(member, { title: `j${i}` });
    const agents = await Promise.all(Array.from({ length: 6 }, (_, i) => agent(`a${i}`)));
    const results = await Promise.all(agents.map((p) => hub.claim(p)));
    const claimed = results.flatMap((r) => (r.status === "claimed" ? [r.job.id] : []));
    expect(claimed.sort()).toEqual(["J1", "J2", "J3"]);
  });

  test("complete requires an outcome; cancel and release move status", async () => {
    const { hub, agent, member } = await setup();
    const a = await agent("ana");
    const j = await hub.postJob(member, { title: "t" });
    await hub.claim(a, j.id);
    await expect(hub.completeJob(a, j.id, "")).rejects.toThrow(/outcome/);
    expect((await hub.releaseJob(a, j.id)).status).toBe("todo");
    expect((await hub.cancelJob(a, j.id, "not needed")).status).toBe("cancelled");
    await expect(hub.completeJob(a, j.id, "x")).rejects.toThrow(/cancelled/);
  });
});

describe("advice", () => {
  const holder = (over: Partial<HolderFacts>): HolderFacts => ({
    agent: { id: "a", name: "ana", vendor: "t", member: "m", device: "d" },
    idleMs: 5_000,
    heldMs: 60_000,
    expiresInMs: 9 * 60_000,
    online: true,
    queue: 0,
    ...over,
  });
  test("active holder and open jobs: work elsewhere, naming the next job", () => {
    const a = advise([holder({})], [{ id: "J4", title: "docs", priority: "medium" }]);
    expect(a.action).toBe("work_elsewhere");
    expect(a.why).toContain("J4");
  });
  test("active holder, nothing else to do: wait", () => {
    expect(advise([holder({ queue: 2 })], []).action).toBe("wait");
  });
  test("quiet holder: wait, it frees soon", () => {
    expect(advise([holder({ idleMs: 5 * 60_000 })], []).action).toBe("wait");
  });
  test("long-silent holder: take over", () => {
    expect(
      advise([holder({ idleMs: 30 * 60_000 })], [{ id: "J1", title: "x", priority: "low" }]).action
    ).toBe("take_over");
  });
  test("maxWaitMs is the longest remaining lease", () => {
    expect(
      advise([holder({ expiresInMs: 1000 }), holder({ expiresInMs: 5000 })], []).maxWaitMs
    ).toBe(5000);
  });
});

describe("events", () => {
  test("listEvents(0, 1) is the latest event", async () => {
    const { hub, member, projectId } = await setup();
    await hub.note(member, "one");
    await hub.note(member, "two");
    const [last] = await hub.store.listEvents(projectId, 0, 1);
    expect(last!.text).toBe("two");
  });
  test("subscribers receive events; a throwing subscriber cannot break the write path", async () => {
    const { hub, member, projectId } = await setup();
    const got: string[] = [];
    hub.subscribe(projectId, () => {
      throw new Error("bad listener");
    });
    hub.subscribe(projectId, (e) => got.push(e.text));
    await hub.note(member, "hello");
    expect(got).toEqual(["hello"]);
  });
});
