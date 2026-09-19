import { afterEach, describe, expect, test } from "bun:test";
import { formatTarget } from "../../src/protocol/target.ts";
import { testHub } from "../helpers/hub.ts";

/**
 * What happens to locks as the code underneath them changes and as agents come
 * and go: files move, symbols get renamed, waits are deferred or orphaned,
 * idle holders give way. Runs on SQLite, and on Postgres when AXIS_TEST_PG is set.
 */

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
const held = async (t: Awaited<ReturnType<typeof setup>>) =>
  (await t.hub.store.listLocks(t.projectId))
    .map((l) => `${l.agent.name}:${formatTarget(l)}`)
    .sort();

describe("files move", () => {
  test("every lock and queued wait on the old path moves with the file", async () => {
    const t = await setup();
    const ana = await t.agent("ana");
    const ben = await t.agent("ben");
    const cat = await t.agent("cat");
    await t.hub.acquire(ana, ["src/a.ts#login"], "trim");
    await t.hub.acquire(ben, ["src/a.ts#logout"], "rename");
    await t.hub.defer(cat, ["src/a.ts#login"], "after ana");
    const moved = await t.hub.moveFile(t.member, "src/a.ts", "src/auth/a.ts");
    expect(moved.map(formatTarget).sort()).toEqual(["src/auth/a.ts#login", "src/auth/a.ts#logout"]);
    expect(await held(t)).toEqual(["ana:src/auth/a.ts#login", "ben:src/auth/a.ts#logout"]);
    // The queued wait moved too: releasing at the new path hands it over.
    await t.hub.release(ana, ["src/auth/a.ts#login"]);
    const [handoff] = await t.hub.handoffs(cat);
    expect(handoff!.outcome.status).toBe("granted");
    expect(await held(t)).toContain("cat:src/auth/a.ts#login");
    const events = await t.hub.store.listEvents(t.projectId, 0, 50);
    expect(
      events.some((e) => e.type === "lock.moved" && /moved to src\/auth\/a.ts/.test(e.text))
    ).toBe(true);
  });

  test("a move onto a path someone already holds keeps their lock, and moving nothing is a no-op", async () => {
    const t = await setup();
    const ana = await t.agent("ana");
    const ben = await t.agent("ben");
    await t.hub.acquire(ana, ["a.ts#f"], "x");
    await t.hub.acquire(ben, ["b.ts#f"], "y");
    await t.hub.moveFile(t.member, "a.ts", "b.ts");
    expect(await held(t)).toEqual(["ben:b.ts#f"]);
    expect(await t.hub.moveFile(t.member, "gone.ts", "x.ts")).toEqual([]);
    await expect(t.hub.moveFile(t.member, "a.ts#f", "b.ts")).rejects.toThrow(/file paths/);
  });

  test("a vanished file is announced once per report, naming whose locks now protect nothing", async () => {
    const t = await setup();
    const ana = await t.agent("ana");
    await t.hub.acquire(ana, ["src/x.ts#f"], "x");
    const locks = await t.hub.orphaned(t.member, "src/x.ts", "deleted");
    expect(locks).toHaveLength(1);
    const [e] = await t.hub.store.listEvents(t.projectId, 0, 1);
    expect(e!.type).toBe("lock.orphaned");
    expect(e!.text).toMatch(
      /src\/x.ts is gone on dana's machine \(deleted\); ana's lock there protects nothing/
    );
    expect(await t.hub.orphaned(t.member, "src/nothing.ts", "")).toEqual([]);
  });
});

describe("symbols get renamed", () => {
  test("the holder's lock follows the new name; holding both drops the old one; a teammate's name is refused", async () => {
    const t = await setup();
    const ana = await t.agent("ana");
    const ben = await t.agent("ben");
    await t.hub.acquire(ana, ["a.ts#login"], "x");
    expect(await t.hub.renameSymbol(ana, "a.ts", "login", "signIn")).toBe(true);
    expect(await held(t)).toEqual(["ana:a.ts#signIn"]);
    await t.hub.acquire(ana, ["a.ts#old", "a.ts#fresh"], "x");
    expect(await t.hub.renameSymbol(ana, "a.ts", "old", "fresh")).toBe(true);
    expect(await held(t)).toEqual(["ana:a.ts#fresh", "ana:a.ts#signIn"]);
    await t.hub.acquire(ben, ["a.ts#theirs"], "y");
    await t.hub.acquire(ana, ["a.ts#mine"], "x");
    expect(await t.hub.renameSymbol(ana, "a.ts", "mine", "theirs")).toBe(false);
    expect(await held(t)).toContain("ana:a.ts#mine");
  });
});

describe("deferred hand-off", () => {
  test("free targets are granted at once; held ones are queued and handed over on release, reported once", async () => {
    const t = await setup();
    const ana = await t.agent("ana");
    const ben = await t.agent("ben");
    const now = await t.hub.defer(ben, ["b.ts"], "free already");
    expect(now.status).toBe("granted");
    await t.hub.acquire(ana, ["a.ts#f"], "busy");
    const q = await t.hub.defer(ben, ["a.ts#f"], "after ana");
    expect(q.status).toBe("queued");
    if (q.status === "queued") {
      expect(q.ahead).toBe(0);
      expect(q.denied.holders[0]!.agent.name).toBe("ana");
    }
    expect(await t.hub.handoffs(ben)).toEqual([]);
    await t.hub.release(ana, "all");
    const got = await t.hub.handoffs(ben);
    expect(got).toHaveLength(1);
    expect(got[0]!.outcome.status === "granted" && got[0]!.outcome.locks.map(formatTarget)).toEqual(
      ["a.ts#f"]
    );
    expect(await t.hub.handoffs(ben)).toEqual([]);
    const events = await t.hub.store.listEvents(t.projectId, 0, 50);
    expect(events.filter((e) => e.type === "lock.queued")).toHaveLength(1);
    expect(
      events.some((e) => e.type === "lock.granted" && /got a.ts#f from the queue/.test(e.text))
    ).toBe(true);
  });

  test("a second deferrer queues behind the first, first come first served", async () => {
    const t = await setup();
    const [ana, ben, cat] = [await t.agent("ana"), await t.agent("ben"), await t.agent("cat")];
    await t.hub.acquire(ana, ["a.ts"], "x");
    await t.hub.defer(ben, ["a.ts"], "second");
    const c = await t.hub.defer(cat, ["a.ts"], "third");
    expect(c.status === "queued" && c.ahead).toBe(1);
    await t.hub.release(ana, "all");
    expect((await t.hub.handoffs(ben)).length).toBe(1);
    expect(await t.hub.handoffs(cat)).toEqual([]);
    await t.hub.release(ben, "all");
    expect((await t.hub.handoffs(cat)).length).toBe(1);
  });

  test("a wait whose call died still hands over: the agent hears on its next call", async () => {
    const t = await setup();
    const ana = await t.agent("ana");
    const ben = await t.agent("ben");
    await t.hub.acquire(ana, ["a.ts"], "x");
    // A waiter enqueued by a call that never came back to collect (the client crashed).
    await t.hub.store.enqueueWaiter(t.projectId, ben.agent!, [{ path: "a.ts", symbol: "" }], {
      acquire: true,
      intent: "crashed waiter",
      deadline: Date.now() + 100,
      leaseMs: t.hub.leaseMs,
    });
    await t.hub.release(ana, "all");
    await Bun.sleep(150); // past its deadline: served waiters must survive cleanup until collected
    await t.hub.acquire(ana, ["other.ts"], "trigger a queue pass");
    expect(await held(t)).toContain("ben:a.ts");
    const got = await t.hub.handoffs(ben);
    expect(got).toHaveLength(1);
  });
});

describe("adaptive leases", () => {
  test("an idle holder loses a lock someone waits for; an active one or an unwanted one keeps it", async () => {
    const t = await setup({ contendedIdleMs: 150 });
    const [ana, ben, cat, dan] = [
      await t.agent("ana"),
      await t.agent("ben"),
      await t.agent("cat"),
      await t.agent("dan"),
    ];
    await t.hub.acquire(ana, ["a.ts"], "idle holder, wanted");
    await t.hub.acquire(cat, ["c.ts"], "idle holder, unwanted");
    await t.hub.acquire(dan, ["d.ts"], "active holder, wanted");
    await t.hub.defer(ben, ["a.ts"], "waiting on ana");
    await t.hub.defer(ben, ["d.ts"], "waiting on dan");
    await Bun.sleep(250);
    await t.hub.touch(dan);
    await t.hub.sweepIfDue(0);
    expect(await held(t)).toEqual(["ben:a.ts", "cat:c.ts", "dan:d.ts"]);
    const events = await t.hub.store.listEvents(t.projectId, 0, 50);
    expect(
      events.some(
        (e) => e.type === "lock.expired" && /ana's lock on a.ts lapsed early/.test(e.text)
      )
    ).toBe(true);
  });
});

describe("contention analytics", () => {
  test("denials, waits, hand-offs, who blocks whom and hold times come out of the event log", async () => {
    const t = await setup();
    const ana = await t.agent("ana");
    const ben = await t.agent("ben");
    const cat = await t.agent("cat");
    await t.hub.acquire(ana, ["a.ts#f"], "x");
    await t.hub.acquire(ben, ["a.ts#f"], "y");
    await t.hub.acquire(cat, ["a.ts#f"], "z");
    await t.hub.acquire(ben, ["a.ts#f"], "y again");
    const waiting = t.hub.wait(ben, ["a.ts#f"], { intent: "y", timeoutMs: 5000 });
    await Bun.sleep(60);
    await t.hub.release(ana, "all");
    expect((await waiting).status).toBe("granted");
    await t.hub.release(ben, "all");
    const c = await t.hub.contention(t.projectId);
    expect(c.totals.denials).toBe(3);
    expect(c.totals.waits).toBe(1);
    expect(c.hot[0]!.target).toBe("a.ts#f");
    expect(c.hot[0]!.denials).toBe(3);
    expect(c.hot[0]!.holders).toEqual(["ana"]);
    expect(c.pairs).toEqual([
      { blocker: "ana", blocked: "ben", count: 2 },
      { blocker: "ana", blocked: "cat", count: 1 },
    ]);
    expect(c.holds.count).toBe(2);
    expect(c.holds.medianMs).toBeGreaterThan(0);
  });
});
