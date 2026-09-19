import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { DaemonClient } from "../../src/daemon/client.ts";
import { Daemon } from "../../src/daemon/daemon.ts";
import { formatTarget } from "../../src/protocol/target.ts";
import { rogueWrite, scratchDir, until } from "../helpers/fs.ts";
import { liveHub } from "../helpers/server.ts";

/**
 * The disk moves under the locks: git mv, an editor's rename, a delete, a file
 * replaced by a new inode, a symlink planted to escape the workspace. The
 * daemon must follow, re-seal, or say so out loud, never lapse silently.
 */

let h: Awaited<ReturnType<typeof liveHub>>;
let repo: ReturnType<typeof scratchDir>;
let outside: ReturnType<typeof scratchDir>;
let sockDir: string;
let daemon: Daemon;
let client: DaemonClient;
const f = (rel: string) => path.join(repo.dir, rel);
const git = (...args: string[]) =>
  Bun.spawnSync(["git", "-C", repo.dir, ...args], { stdout: "pipe", stderr: "pipe" });
const unseal = (abs: string) =>
  Bun.spawnSync(process.platform === "darwin" ? ["chflags", "nouchg", abs] : ["chmod", "u+w", abs]);
const src = (name: string) =>
  `export function ${name}() {\n  return "${name}";\n}\n\nexport function other() {\n  return 1;\n}\n`;

beforeAll(async () => {
  h = await liveHub();
  repo = scratchDir("axis-disk-");
  outside = scratchDir("axis-outside-");
  sockDir = mkdtempSync("/tmp/axd-");
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  mkdirSync(f("src"));
  for (const n of ["moved", "renamed", "deleted", "replaced"])
    writeFileSync(f(`src/${n}.ts`), src(n));
  git("add", "-A");
  git("commit", "-qm", "init");
  daemon = new Daemon({
    socket: path.join(sockDir, "d.sock"),
    stateFile: path.join(sockDir, "state.json"),
    deviceId: "disk-test",
    prefer: "guard",
    verifyMs: 50,
    log: () => {},
  });
  await daemon.start();
  client = new DaemonClient(path.join(sockDir, "d.sock"));
  await client.register({
    root: repo.dir,
    hub: h.url,
    project: h.project,
    memberToken: h.danaToken,
  });
});

afterAll(async () => {
  await daemon.stop();
  repo.dispose();
  outside.dispose();
  rmSync(sockDir, { recursive: true, force: true });
  h.close();
});

const locksAt = async (p: string) =>
  (await h.dana.locks()).filter((l) => l.path === p).map(formatTarget);
const sealed = (rel: string) => rogueWrite(f(rel), "x") !== "written";

describe("a locked file moves", () => {
  test("git mv: the locks follow to the new path, which is sealed there", async () => {
    const ana = await h.agent(h.dana, "ana", "laptop");
    await ana.acquire(["src/moved.ts#moved"], "working on moved");
    await client.reconcile(repo.dir, h.danaToken);
    expect(sealed("src/moved.ts")).toBe(true);
    unseal(f("src/moved.ts"));
    mkdirSync(f("src/lib"));
    expect(git("mv", "src/moved.ts", "src/lib/moved.ts").exitCode).toBe(0);
    expect(await until(async () => (await locksAt("src/lib/moved.ts")).length === 1, 5000)).toBe(
      true
    );
    expect(await locksAt("src/moved.ts")).toEqual([]);
    expect(await until(() => sealed("src/lib/moved.ts"), 3000)).toBe(true);
    await ana.endAgent();
  });

  test("an editor's rename (delete + untracked copy, content changed a little): the locks follow", async () => {
    const ana = await h.agent(h.dana, "ana", "laptop");
    await ana.acquire(["src/renamed.ts#renamed"], "working on renamed");
    await client.reconcile(repo.dir, h.danaToken);
    unseal(f("src/renamed.ts"));
    const text = readFileSync(f("src/renamed.ts"), "utf8");
    rmSync(f("src/renamed.ts"));
    writeFileSync(f("src/names.ts"), text.replace("return 1;", "return 2;"));
    expect(await until(async () => (await locksAt("src/names.ts")).length === 1, 5000)).toBe(true);
    await ana.endAgent();
  });
});

describe("a locked file disappears", () => {
  test("the team is told once, the device reports it, and it clears when the file is back", async () => {
    const ana = await h.agent(h.dana, "ana", "laptop");
    await ana.acquire(["src/deleted.ts#deleted"], "working on deleted");
    await client.reconcile(repo.dir, h.danaToken);
    unseal(f("src/deleted.ts"));
    rmSync(f("src/deleted.ts"));
    const orphaned = async () =>
      (await h.dana.events(0, 200)).filter(
        (e) => e.type === "lock.orphaned" && e.text.includes("src/deleted.ts")
      );
    expect(await until(async () => (await orphaned()).length === 1, 5000)).toBe(true);
    await Bun.sleep(300);
    expect(await orphaned()).toHaveLength(1);
    expect((await client.status()).workspaces[0]!.orphaned).toEqual(["src/deleted.ts"]);
    expect(await locksAt("src/deleted.ts")).toEqual(["src/deleted.ts#deleted"]);
    // The device report is sent after the announcement, asynchronously: poll for it.
    const reported = async () =>
      (await h.dana.snapshot(0)).devices.find((d) => d.id === "disk-test")?.health.orphaned;
    expect(
      await until(async () => JSON.stringify(await reported()) === '["src/deleted.ts"]', 5000)
    ).toBe(true);
    git("checkout", "--", "src/deleted.ts");
    expect(
      await until(async () => (await client.status()).workspaces[0]!.orphaned.length === 0, 3000)
    ).toBe(true);
    expect(await until(() => sealed("src/deleted.ts"), 3000)).toBe(true);
    await ana.endAgent();
  });
});

describe("a locked file is replaced", () => {
  test("a new inode swapped in under the seal is sealed again within a second", async () => {
    const ana = await h.agent(h.dana, "ana", "laptop");
    await ana.acquire(["src/replaced.ts#replaced"], "working on replaced");
    await client.reconcile(repo.dir, h.danaToken);
    unseal(f("src/replaced.ts"));
    writeFileSync(f("src/replaced.tmp"), src("replaced"));
    renameSync(f("src/replaced.tmp"), f("src/replaced.ts"));
    expect(await until(() => sealed("src/replaced.ts"), 3000)).toBe(true);
    await ana.endAgent();
  });
});

describe("the workspace boundary", () => {
  test("a lock through a symlinked directory never seals the file outside", async () => {
    writeFileSync(path.join(outside.dir, "victim.txt"), "outside\n");
    symlinkSync(outside.dir, f("escape"));
    const ana = await h.agent(h.dana, "ana", "laptop");
    await ana.acquire(["escape/victim.txt"], "trying to escape");
    await client.reconcile(repo.dir, h.danaToken);
    await Bun.sleep(150);
    expect(rogueWrite(path.join(outside.dir, "victim.txt"), "still mine\n")).toBe("written");
    await ana.endAgent();
  });
});

describe("the root daemon's world-reachable socket", () => {
  test("workspace details, reconcile and seen need the workspace's member token", async () => {
    const sock = path.join(sockDir, "root.sock");
    const root = new Daemon({
      socket: sock,
      stateFile: path.join(sockDir, "root.json"),
      deviceId: "r",
      prefer: "guard",
      log: () => {},
    });
    (root as unknown as { system: boolean }).system = true;
    await root.start();
    try {
      const c = new DaemonClient(sock);
      await c.register({
        root: repo.dir,
        hub: h.url,
        project: h.project,
        memberToken: h.danaToken,
      });
      const post = (route: string, body: unknown) =>
        fetch(`http://axisd${route}`, {
          method: "POST",
          body: JSON.stringify(body),
          unix: sock,
        } as RequestInit).then((r) => r.json() as Promise<Record<string, unknown>>);
      expect((await post("/status", {})).workspaces).toEqual([]);
      expect(((await post("/status", { tokens: ["nope"] })).workspaces as unknown[]).length).toBe(
        0
      );
      expect(
        ((await post("/status", { tokens: [h.danaToken] })).workspaces as unknown[]).length
      ).toBe(1);
      expect((await post("/reconcile", { root: repo.dir })).error).toMatch(/memberToken/);
      expect((await post("/seen", { root: repo.dir, path: f("x"), content: "x" })).hash).toBeNull();
      expect(
        (
          await post("/seen", {
            root: repo.dir,
            path: f("x"),
            content: "x",
            memberToken: h.danaToken,
          })
        ).hash
      ).toBeString();
    } finally {
      await root.stop();
    }
  });
});
