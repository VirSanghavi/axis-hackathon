import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DaemonClient } from "../../src/daemon/client.ts";
import { rogueWrite, scratchDir, until } from "../helpers/fs.ts";
import { REMOTE_HUB, liveHub } from "../helpers/server.ts";

/**
 * Daemons die, restart, and get replaced. Whatever the order of those events
 * and of lock changes on the hub, no file may stay sealed once nobody holds its
 * lock, and no locked file may be left writable. Each daemon here is a real
 * subprocess, killed with SIGKILL where the test calls for a crash.
 */

const ROOT = path.resolve(import.meta.dir, "../..");
let h: Awaited<ReturnType<typeof liveHub>>;
let repo: ReturnType<typeof scratchDir>;
let home: string;
let socket: string;
const procs: ReturnType<typeof Bun.spawn>[] = [];

function startDaemon() {
  const p = Bun.spawn([process.execPath, path.join(ROOT, "src/cli/main.ts"), "daemon"], {
    env: {
      ...process.env,
      AXIS_HOME: home,
      AXIS_SOCKET: socket,
      AXIS_SYSTEM_SOCKET: path.join(home, "none.sock"),
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  procs.push(p);
  return p;
}

async function ready(): Promise<DaemonClient> {
  const c = new DaemonClient(socket);
  expect(
    await until(
      () =>
        c.status().then(
          () => true,
          () => false
        ),
      10_000
    )
  ).toBe(true);
  return c;
}

const file = () => path.join(repo.dir, "a.txt");
const sealed = () => rogueWrite(file(), "probe\n") !== "written";

beforeAll(async () => {
  h = await liveHub();
  repo = scratchDir("axis-life-");
  home = mkdtempSync("/tmp/axl-");
  socket = path.join(home, "d.sock");
  writeFileSync(file(), "hello\n");
});

afterAll(async () => {
  for (const p of procs) p.kill("SIGKILL");
  repo.dispose();
  rmSync(home, { recursive: true, force: true });
  h.close();
});

describe("daemon lifecycle orderings", () => {
  test("crash while sealed, lock released during the outage, restart: the stale seal is released", async () => {
    const a = startDaemon();
    const d = await ready();
    await d.register({ root: repo.dir, hub: h.url, project: h.project, memberToken: h.danaToken });
    const ana = await h.agent(h.dana, "ana", "laptop");
    await ana.acquire(["a.txt"], "editing");
    expect(await until(sealed)).toBe(true);

    a.kill("SIGKILL"); // no chance to unseal
    await a.exited;
    await ana.release("all"); // the lock goes away while no daemon is running
    expect(sealed()).toBe(true); // still frozen: nobody has released the OS seal yet

    startDaemon(); // restores the workspace and adopts the persisted sealed set
    await ready();
    expect(await until(() => !sealed(), 10_000)).toBe(true);
    await ana.endAgent();
  });

  test("crash while sealed, lock still held, restart: the file stays sealed", async () => {
    const d = await ready();
    const ben = await h.agent(h.ben, "ben", "desktop");
    await ben.acquire(["a.txt"], "long refactor");
    expect(await until(sealed)).toBe(true);
    const { pid } = await d.status();
    process.kill(pid, "SIGKILL");
    await until(() =>
      d.status().then(
        () => false,
        () => true
      )
    );
    startDaemon();
    await ready();
    await Bun.sleep(500);
    expect(sealed()).toBe(true);
    await ben.release("all");
    expect(await until(() => !sealed(), 10_000)).toBe(true);
    await ben.endAgent();
  });

  test("a second daemon takes over the socket: the first exits without unsealing the successor's files", async () => {
    const d = await ready();
    const first = (await d.status()).pid;
    const ana = await h.agent(h.dana, "ana", "laptop");
    await ana.acquire(["a.txt"], "held across the handover");
    expect(await until(sealed)).toBe(true);

    unlinkSync(socket); // the successor replaces the socket
    startDaemon();
    const next = await ready();
    expect((await next.status()).pid).not.toBe(first);
    // The old daemon notices within its watchdog period and leaves.
    expect(
      await until(() => {
        try {
          process.kill(first, 0);
          return false;
        } catch {
          return true;
        }
      }, 10_000)
    ).toBe(true);
    expect(sealed()).toBe(true);
    await ana.release("all");
    expect(await until(() => !sealed(), 10_000)).toBe(true);
    await ana.endAgent();
  });

  test("an orphaned daemon (socket deleted, nobody took over) releases its seals and exits", async () => {
    const d = await ready();
    const pid = (await d.status()).pid;
    const ana = await h.agent(h.dana, "ana", "laptop");
    await ana.acquire(["a.txt"], "about to be orphaned");
    expect(await until(sealed)).toBe(true);
    unlinkSync(socket);
    expect(
      await until(() => {
        try {
          process.kill(pid, 0);
          return false;
        } catch {
          return true;
        }
      }, 10_000)
    ).toBe(true);
    expect(sealed()).toBe(false);
    await ana.endAgent();
  });

  // Needs a hub it can take down, so only against a local one.
  test.skipIf(!!REMOTE_HUB)(
    "restart while the hub is down keeps the workspace and its seals (fail closed)",
    async () => {
      startDaemon();
      const d = await ready();
      await d.register({
        root: repo.dir,
        hub: h.url,
        project: h.project,
        memberToken: h.danaToken,
      });
      const ana = await h.agent(h.dana, "ana", "laptop");
      await ana.acquire(["a.txt"], "x");
      expect(await until(sealed)).toBe(true);
      const { pid } = await d.status();
      process.kill(pid, "SIGKILL");
      h.stopServer();
      startDaemon();
      const again = await ready();
      await Bun.sleep(1000);
      expect(sealed()).toBe(true);
      expect((await again.status()).workspaces.map((w) => w.hubOk)).toEqual([false]);
    }
  );
});
