import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Gateway, hashText } from "../../src/enforce/gateway.ts";
import type { Sealer } from "../../src/enforce/seal.ts";
import { scratchDir } from "../helpers/fs.ts";
import { liveHub } from "../helpers/server.ts";

/**
 * Section- and key-level locks on files with no grammar, through the real
 * gateway and a real hub: auto-locking, denial, 3-way merge and symbol writes.
 * Sealing is not under test here, so the sealer is a no-op.
 */

const README = `# Axis

Locks for agents.

## Install

Run the script.

## Usage

axis init

## FAQ

Because.
`;

const PKG = `{
  "name": "axis",
  "scripts": {
    "test": "bun test",
    "lint": "prettier --check"
  }
}
`;

const noSeal: Sealer = { tier: "off", mechanism: "none", seal: (p) => p, unseal: (p) => p };

let h: Awaited<ReturnType<typeof liveHub>>;
let ws: ReturnType<typeof scratchDir>;
let gw: Gateway;

beforeAll(async () => {
  h = await liveHub();
  ws = scratchDir("axis-fallback-");
  writeFileSync(path.join(ws.dir, "README.md"), README);
  writeFileSync(path.join(ws.dir, "package.json"), PKG);
  writeFileSync(path.join(ws.dir, "notes.txt"), "a\nb\n");
  gw = new Gateway(ws.dir, noSeal, () => {});
});

afterAll(() => {
  ws.dispose();
  h.close();
});

const read = (rel: string) => readFileSync(path.join(ws.dir, rel), "utf8");

describe("fallback units through the gateway", () => {
  test("two agents edit different Markdown sections; a third is denied the held one", async () => {
    const ana = await h.agent(h.dana, "ana", "laptop");
    const ben = await h.agent(h.ben, "ben", "desktop");
    const cy = await h.agent(h.ben, "cy", "desktop");
    const [a, b] = await Promise.all([
      gw.apply(ana, {
        op: "edit",
        path: "README.md",
        oldString: "Run the script.",
        newString: "Run the installer.",
      }),
      gw.apply(ben, {
        op: "edit",
        path: "README.md",
        oldString: "Because.",
        newString: "Because it works.",
      }),
    ]);
    expect(a).toMatchObject({ status: "applied", autoLocked: ["README.md#Install"] });
    expect(b).toMatchObject({ status: "applied", autoLocked: ["README.md#FAQ"] });
    expect(read("README.md")).toBe(
      README.replace("Run the script.", "Run the installer.").replace(
        "Because.",
        "Because it works."
      )
    );

    const denied = await gw.apply(cy, {
      op: "edit",
      path: "README.md",
      oldString: "Run the installer.",
      newString: "Run it.",
    });
    expect(denied.status).toBe("denied");
    if (denied.status === "denied")
      expect(denied.acquire.conflicts.map((c) => c.target)).toEqual(["README.md#Install"]);

    // A stale whole-file write that only changes another section merges with both edits.
    const mine = README.replace("axis init", "axis init --here");
    const c = await gw.apply(cy, {
      op: "write",
      path: "README.md",
      content: mine,
      baseHash: hashText(README),
    });
    expect(c).toMatchObject({ status: "applied", merged: true, touched: ["Usage"] });
    expect(read("README.md")).toContain("Run the installer.");
    expect(read("README.md")).toContain("Because it works.");
    expect(read("README.md")).toContain("axis init --here");

    // A new subsection by symbol lands inside its parent. Ana's lock on Install covers it;
    // anyone else is told Install encloses it.
    const windows = {
      op: "symbol" as const,
      path: "README.md",
      symbol: "Install.Windows",
      content: "### Windows\n\nwinget install axis",
    };
    const e = await gw.apply(cy, windows);
    expect(e.status).toBe("denied");
    if (e.status === "denied") expect(e.acquire.conflicts[0]!.relation).toBe("encloses");
    const d = await gw.apply(ana, windows);
    expect(d).toMatchObject({ status: "applied", autoLocked: [], touched: ["Install.Windows"] });
    expect(read("README.md")).toContain(
      "Run the installer.\n\n### Windows\n\nwinget install axis\n\n## Usage"
    );
    for (const x of [ana, ben, cy]) await x.endAgent();
  });

  test("two agents edit adjacent package.json scripts at once and the file stays valid", async () => {
    const ana = await h.agent(h.dana, "ana2", "laptop");
    const ben = await h.agent(h.ben, "ben2", "desktop");
    const [a, b] = await Promise.all([
      gw.apply(ana, {
        op: "edit",
        path: "package.json",
        oldString: '"bun test"',
        newString: '"bun test --bail"',
      }),
      gw.apply(ben, {
        op: "edit",
        path: "package.json",
        oldString: '"prettier --check"',
        newString: '"prettier --check ."',
      }),
    ]);
    expect(a).toMatchObject({ status: "applied", autoLocked: ["package.json#scripts.test"] });
    expect(b).toMatchObject({ status: "applied", autoLocked: ["package.json#scripts.lint"] });
    expect(JSON.parse(read("package.json")).scripts).toEqual({
      test: "bun test --bail",
      lint: "prettier --check .",
    });

    // Replacing one key by symbol must keep the file valid JSON.
    const bad = await gw.apply(ana, {
      op: "symbol",
      path: "package.json",
      symbol: "name",
      content: '  "name": "axis2"',
    });
    expect(bad).toMatchObject({ status: "error", code: "parse" });
    expect(JSON.parse(read("package.json")).name).toBe("axis");
    for (const x of [ana, ben]) await x.endAgent();
  });

  test("a file with no grammar and no structure still locks whole", async () => {
    const ana = await h.agent(h.dana, "ana3", "laptop");
    const r = await gw.apply(ana, {
      op: "edit",
      path: "notes.txt",
      oldString: "a\n",
      newString: "A\n",
    });
    expect(r).toMatchObject({ status: "applied", autoLocked: ["notes.txt"], touched: ["(file)"] });
    await ana.endAgent();
  });
});
