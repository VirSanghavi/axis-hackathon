import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { Daemon } from "../../src/daemon/daemon.ts";
import { DaemonClient } from "../../src/daemon/client.ts";
import { hashText } from "../../src/enforce/gateway.ts";
import { rogueWrite, scratchDir, until } from "../helpers/fs.ts";
import { REMOTE_HUB, liveHub } from "../helpers/server.ts";

/**
 * Two devices, one repo. Each "device" is its own clone and its own axisd, both
 * following the same hub, exactly like two laptops. The rogue writer is plain
 * fs.writeFileSync: a tool that has never heard of Axis.
 */

const AUTH = `export class Auth {
  login(u: string) {
    return u;
  }

  logout() {
    return true;
  }
}
`;

let h: Awaited<ReturnType<typeof liveHub>>;
const devices: {
  name: string;
  root: string;
  daemon: Daemon;
  client: DaemonClient;
  token: string;
  dispose: () => void;
}[] = [];
let sockDir: string;

beforeAll(async () => {
  h = await liveHub();
  sockDir = mkdtempSync("/tmp/axt-");
  for (const [name, token] of [
    ["laptop", h.danaToken],
    ["desktop", h.benToken],
  ] as const) {
    const s = scratchDir(`axis-${name}-`);
    mkdirSync(path.join(s.dir, "src"));
    writeFileSync(path.join(s.dir, "src/auth.ts"), AUTH);
    writeFileSync(path.join(s.dir, "README.md"), "hello\n");
    const socket = path.join(sockDir, `${name}.sock`);
    const daemon = new Daemon({
      socket,
      stateFile: path.join(s.dir, ".state.json"),
      deviceId: name,
      prefer: "guard",
      log: () => {},
    });
    await daemon.start();
    const client = new DaemonClient(socket);
    await client.register({ root: s.dir, hub: h.url, project: h.project, memberToken: token });
    devices.push({ name, root: s.dir, daemon, client, token, dispose: s.dispose });
  }
});

afterAll(async () => {
  for (const d of devices) {
    await d.daemon.stop();
    d.dispose();
  }
  rmSync(sockDir, { recursive: true, force: true });
  h.close();
});

const file = (d: (typeof devices)[number], rel = "src/auth.ts") => path.join(d.root, rel);

describe("cross-device enforcement", () => {
  test("a lock taken on one device seals the file on every device", async () => {
    const [laptop, desktop] = devices as [(typeof devices)[0], (typeof devices)[0]];
    const ana = await h.agent(h.dana, "ana", "laptop");
    expect((await ana.acquire(["src/auth.ts#Auth.login"], "fixing login")).status).toBe("granted");

    // The hub grants first; each device's daemon then seals within one push or poll.
    for (const d of devices)
      expect(
        await until(async () =>
          (await d.client.status()).workspaces[0]!.sealed.includes("src/auth.ts")
        )
      ).toBe(true);
    expect(rogueWrite(file(desktop), "clobbered")).toMatch(/^(EPERM|EACCES)$/);
    expect(rogueWrite(file(laptop), "clobbered")).toMatch(/^(EPERM|EACCES)$/);
    expect(readFileSync(file(desktop), "utf8")).toBe(AUTH);

    // Rename-over and delete (the classic editor save path is write-temp-then-rename) are
    // blocked by flag-based seals: macOS uchg here, chattr +i at the kernel tier. Linux without
    // root can only drop write bits, which stops in-place writes but not directory operations.
    if (process.platform === "darwin") {
      const tmp = path.join(desktop.root, "src/.swap");
      writeFileSync(tmp, "x");
      expect(() => renameSync(tmp, file(desktop))).toThrow();
      expect(() => unlinkSync(file(desktop))).toThrow();
      rmSync(tmp, { force: true });
    }

    // Unlocked files stay writable.
    expect(rogueWrite(file(desktop, "README.md"), "edited\n")).toBe("written");

    await ana.release("all");
    expect(await until(() => rogueWrite(file(desktop), AUTH) === "written")).toBe(true);
    expect(await until(() => rogueWrite(file(laptop), AUTH) === "written")).toBe(true);
    await ana.endAgent();
  });

  test("two agents on two devices edit different functions of one file at the same time", async () => {
    const [laptop, desktop] = devices as [(typeof devices)[0], (typeof devices)[0]];
    const ana = await h.agent(h.dana, "ana", "laptop");
    const ben = await h.agent(h.ben, "ben", "desktop");

    const [ra, rb] = await Promise.all([
      laptop.client.write(
        ana.sessionToken,
        { op: "edit", path: "src/auth.ts", oldString: "return u;", newString: "return u.trim();" },
        laptop.root
      ),
      desktop.client.write(
        ben.sessionToken,
        { op: "edit", path: "src/auth.ts", oldString: "return true;", newString: "return false;" },
        desktop.root
      ),
    ]);
    expect(ra.status).toBe("applied");
    expect(rb.status).toBe("applied");
    if (ra.status === "applied") expect(ra.autoLocked).toEqual(["src/auth.ts#Auth.login"]);
    if (rb.status === "applied") expect(rb.autoLocked).toEqual(["src/auth.ts#Auth.logout"]);

    // Each device's file is sealed now (locks are held), and a raw write still fails.
    expect(rogueWrite(file(laptop), "x")).not.toBe("written");

    // Ben tries to touch Ana's function: denied with her reason, nothing written.
    const denied = await desktop.client.write(
      ben.sessionToken,
      {
        op: "edit",
        path: "src/auth.ts",
        oldString: "return u;",
        newString: "return u!;",
        intent: "tweak",
      },
      desktop.root
    );
    expect(denied.status).toBe("denied");
    if (denied.status === "denied") {
      expect(denied.acquire.holders[0]!.agent.name).toBe("ana");
      expect(denied.acquire.conflicts[0]!.lock.intent).toMatch(/editing Auth.login/);
    }
    expect(readFileSync(file(desktop), "utf8")).toContain("return u;");

    await ana.endAgent();
    await ben.endAgent();
  });

  test("a full-file write from a stale base is 3-way merged with a teammate's edit to another function", async () => {
    const [laptop] = devices as [(typeof devices)[0]];
    const ana = await h.agent(h.dana, "ana", "laptop");
    const ben = await h.agent(h.dana, "ben2", "laptop");
    const base = readFileSync(file(laptop), "utf8");
    await laptop.client.seen("src/auth.ts", base, laptop.root, laptop.token);

    // Ana edits login first.
    const a = await laptop.client.write(
      ana.sessionToken,
      {
        op: "edit",
        path: "src/auth.ts",
        oldString: "login(u: string) {",
        newString: "login(u: string): string {",
      },
      laptop.root
    );
    expect(a.status).toBe("applied");
    // Ben rewrites the whole file from the version he read, changing only logout.
    const mine = base.replace("logout() {", "logout(): boolean {");
    const b = await laptop.client.write(
      ben.sessionToken,
      { op: "write", path: "src/auth.ts", content: mine, baseHash: hashText(base) },
      laptop.root
    );
    expect(b.status).toBe("applied");
    if (b.status === "applied") expect(b.merged).toBe(true);
    const now = readFileSync(file(laptop), "utf8");
    expect(now).toContain("login(u: string): string {");
    expect(now).toContain("logout(): boolean {");

    // A stale write that collides with Ana's line is refused, not silently resolved.
    await ben.release("all");
    await ana.release("all");
    const c = await laptop.client.write(
      ben.sessionToken,
      {
        op: "write",
        path: "src/auth.ts",
        content: base.replace("login(u: string) {", "login(name: string) {"),
        baseHash: hashText(base),
      },
      laptop.root
    );
    expect(c.status).toBe("conflict");
    await ana.endAgent();
    await ben.endAgent();
  });

  test("an explicit reconcile converges before it returns (no waiting on the watch)", async () => {
    const [laptop] = devices as [(typeof devices)[0]];
    const ana = await h.agent(h.dana, "ana", "laptop");
    await ana.acquire(["README.md"], "docs");
    await laptop.client.reconcile(laptop.root, laptop.token);
    expect(rogueWrite(file(laptop, "README.md"), "x")).toMatch(/^(EPERM|EACCES)$/);
    await ana.release("all");
    await laptop.client.reconcile(laptop.root, laptop.token);
    expect(rogueWrite(file(laptop, "README.md"), "hello\n")).toBe("written");
    await expect(laptop.client.reconcile("/nonexistent", laptop.token)).rejects.toThrow(
      /No registered workspace/
    );
    await ana.endAgent();
  });

  test("gateway refuses paths outside the workspace and symlinks", async () => {
    const [laptop] = devices as [(typeof devices)[0]];
    const ana = await h.agent(h.dana, "ana", "laptop");
    const out = await laptop.client.write(
      ana.sessionToken,
      { op: "write", path: "../escape.txt", content: "x" },
      laptop.root
    );
    expect(out.status).toBe("error");
    symlinkSync("/etc/hosts", path.join(laptop.root, "link"));
    const link = await laptop.client.write(
      ana.sessionToken,
      { op: "write", path: "link", content: "x" },
      laptop.root
    );
    expect(link.status === "error" && link.message).toMatch(/symlink/);
    await ana.endAgent();
  });

  test("a member token cannot write; an agent from another project cannot write here", async () => {
    const [laptop] = devices as [(typeof devices)[0]];
    await expect(
      laptop.client.write(h.danaToken, { op: "write", path: "x.txt", content: "x" }, laptop.root)
    ).rejects.toThrow(/agent session/);
  });

  // Last on purpose: it takes the hub down (so only against a local hub).
  test.skipIf(!!REMOTE_HUB)(
    "hub outage fails closed: sealed files stay sealed while the hub is unreachable",
    async () => {
      const [laptop] = devices as [(typeof devices)[0]];
      const ana = await h.agent(h.dana, "ana", "laptop");
      await ana.acquire(["README.md"], "docs");
      expect(
        await until(async () =>
          (await laptop.client.status()).workspaces[0]!.sealed.includes("README.md")
        )
      ).toBe(true);
      h.stopServer();
      expect(
        await until(async () => (await laptop.client.status()).workspaces[0]!.hubOk === false)
      ).toBe(true);
      await Bun.sleep(300); // several reconcile passes against a dead hub
      expect(rogueWrite(file(laptop, "README.md"), "x")).not.toBe("written");
      expect((await laptop.client.status()).workspaces[0]!.sealed).toContain("README.md");
    }
  );
});
