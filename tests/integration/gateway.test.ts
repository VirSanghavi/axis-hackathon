import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Gateway } from "../../src/enforce/gateway.ts";
import { detectSealer, noSealer } from "../../src/enforce/seal.ts";
import { formatTarget } from "../../src/protocol/target.ts";
import { rogueWrite, scratchDir } from "../helpers/fs.ts";
import { liveHub } from "../helpers/server.ts";

/**
 * The gateway on its own: a real hub over HTTP, real files, a real seal, no
 * daemon. Everything a write does to the lock table is checked here.
 */

const AUTH = `import { db } from "./db";

export class Auth {
  login(u: string) {
    return u;
  }

  logout() {
    return true;
  }
}
`;

let h: Awaited<ReturnType<typeof liveHub>>;
let repo: ReturnType<typeof scratchDir>;
let gw: Gateway;
const file = (rel = "src/auth.ts") => path.join(repo.dir, rel);
const mine = async (a: { myLocks(): Promise<{ path: string; symbol: string }[]> }) =>
  (await a.myLocks()).map(formatTarget).sort();

beforeAll(async () => {
  h = await liveHub();
  repo = scratchDir("axis-gw-");
  gw = new Gateway(repo.dir, await detectSealer({ prefer: "guard" }), () => {});
});
afterAll(() => {
  repo.dispose();
  h.close();
});

function reset() {
  mkdirSync(path.dirname(file()), { recursive: true });
  for (const f of ["src/auth.ts", "src/users.ts"]) {
    try {
      Bun.spawnSync(
        process.platform === "darwin" ? ["chflags", "nouchg", file(f)] : ["chmod", "u+w", file(f)]
      );
    } catch {
      /* not there yet */
    }
  }
  writeFileSync(file(), AUTH);
  writeFileSync(file("src/users.ts"), "export function find(id: string) {\n  return id;\n}\n");
}

describe("locks follow the code", () => {
  test("renaming a method carries its lock to the new name", async () => {
    reset();
    const ana = await h.agent(h.dana, "ana", "laptop");
    await gw.apply(ana, {
      op: "edit",
      path: "src/auth.ts",
      oldString: "return u;",
      newString: "return u.trim();",
    });
    expect(await mine(ana)).toEqual(["src/auth.ts#Auth.login"]);
    const r = await gw.apply(ana, {
      op: "edit",
      path: "src/auth.ts",
      oldString: "login(u: string)",
      newString: "signIn(u: string)",
    });
    expect(r.status).toBe("applied");
    expect(await mine(ana)).toEqual(["src/auth.ts#Auth.signIn"]);
    await ana.endAgent();
  });

  test("deleting a method releases its lock", async () => {
    reset();
    const ana = await h.agent(h.dana, "ana", "laptop");
    await gw.apply(ana, {
      op: "edit",
      path: "src/auth.ts",
      oldString: "return true;",
      newString: "return false;",
    });
    expect(await mine(ana)).toEqual(["src/auth.ts#Auth.logout"]);
    await gw.apply(ana, {
      op: "edit",
      path: "src/auth.ts",
      oldString: "\n  logout() {\n    return false;\n  }\n",
      newString: "",
    });
    expect(await mine(ana)).toEqual([]);
    await ana.endAgent();
  });
});

describe("imports and glue, (top)", () => {
  test("are locked for the write even when the writer holds a function, then released", async () => {
    reset();
    const ana = await h.agent(h.dana, "ana", "laptop");
    await ana.acquire(["src/auth.ts#Auth.login"], "login work");
    const r = await gw.apply(ana, {
      op: "edit",
      path: "src/auth.ts",
      oldString: 'import { db } from "./db";',
      newString: 'import { db, cache } from "./db";',
    });
    expect(r.status === "applied" && r.autoLocked).toEqual(["src/auth.ts#(top)"]);
    expect(await mine(ana)).toEqual(["src/auth.ts#Auth.login"]);
    await ana.endAgent();
  });

  test("are refused while a teammate holds them, even to a writer holding a function in the file", async () => {
    reset();
    const ana = await h.agent(h.dana, "ana", "laptop");
    const ben = await h.agent(h.ben, "ben", "desktop");
    await ana.acquire(["src/auth.ts#Auth.login"], "login work");
    await ben.acquire(["src/auth.ts#(top)"], "reorganising imports");
    const r = await gw.apply(ana, {
      op: "edit",
      path: "src/auth.ts",
      oldString: 'import { db } from "./db";',
      newString: 'import { db, cache } from "./db";',
    });
    expect(r.status).toBe("denied");
    expect(readFileSync(file(), "utf8")).toContain('import { db } from "./db";');
    await ana.endAgent();
    await ben.endAgent();
  });
});

describe("a change across files lands whole or not at all", () => {
  test("when any file is held by a teammate, no file is written and nothing is locked", async () => {
    reset();
    const ana = await h.agent(h.dana, "ana", "laptop");
    const ben = await h.agent(h.ben, "ben", "desktop");
    await ben.acquire(["src/users.ts#find"], "changing find");
    const rs = await gw.applyMany(ana, [
      { op: "edit", path: "src/auth.ts", oldString: "return u;", newString: "return find(u);" },
      { op: "edit", path: "src/users.ts", oldString: "return id;", newString: "return id.trim();" },
    ]);
    expect(rs.map((r) => r.status)).toEqual(["denied", "denied"]);
    expect(readFileSync(file(), "utf8")).toBe(AUTH);
    expect(await mine(ana)).toEqual([]);
    await ben.release("all");
    const ok = await gw.applyMany(ana, [
      { op: "edit", path: "src/auth.ts", oldString: "return u;", newString: "return find(u);" },
      { op: "edit", path: "src/users.ts", oldString: "return id;", newString: "return id.trim();" },
    ]);
    expect(ok.map((r) => r.status)).toEqual(["applied", "applied"]);
    expect(readFileSync(file(), "utf8")).toContain("return find(u);");
    expect(readFileSync(file("src/users.ts"), "utf8")).toContain("return id.trim();");
    expect(await mine(ana)).toEqual(["src/auth.ts#Auth.login", "src/users.ts#find"]);
    await ana.endAgent();
    await ben.endAgent();
  });

  test("when one file's merge conflicts, the other file is not written either", async () => {
    reset();
    const ana = await h.agent(h.dana, "ana", "laptop");
    const ben = await h.agent(h.ben, "ben", "desktop");
    const { hash: base } = gw.read("src/auth.ts");
    await gw.apply(ben, {
      op: "edit",
      path: "src/auth.ts",
      oldString: "return u;",
      newString: "return u.toLowerCase();",
    });
    await ben.release("all");
    const rs = await gw.applyMany(ana, [
      {
        op: "write",
        path: "src/auth.ts",
        content: AUTH.replace("return u;", "return u.trim();"),
        baseHash: base,
      },
      { op: "edit", path: "src/users.ts", oldString: "return id;", newString: "return id.trim();" },
    ]);
    expect(rs.map((r) => r.status)).toEqual(["conflict", "error"]);
    expect(readFileSync(file("src/users.ts"), "utf8")).toContain("return id;");
    await ana.endAgent();
    await ben.endAgent();
  });

  test("the same file twice in one batch is refused up front", async () => {
    const ana = await h.agent(h.dana, "ana", "laptop");
    const rs = await gw.applyMany(ana, [
      { op: "edit", path: "src/auth.ts", oldString: "a", newString: "b" },
      { op: "edit", path: "./src/auth.ts", oldString: "c", newString: "d" },
    ]);
    expect(rs.every((r) => r.status === "error" && /once in a batch/.test(r.message))).toBe(true);
    await ana.endAgent();
  });
});

describe("without a daemon", () => {
  test("the in-process gateway still locks and merges but never seals, so nothing is left frozen", async () => {
    reset();
    const loose = new Gateway(repo.dir, noSealer(), () => {});
    const ana = await h.agent(h.dana, "ana", "laptop");
    const r = await loose.apply(ana, {
      op: "edit",
      path: "src/auth.ts",
      oldString: "return u;",
      newString: "return u.trim();",
    });
    expect(r.status).toBe("applied");
    expect(await mine(ana)).toEqual(["src/auth.ts#Auth.login"]);
    expect(rogueWrite(file(), "still writable\n")).toBe("written");
    await ana.endAgent();
  });
});
