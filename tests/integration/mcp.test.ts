import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { saveCredential, writeProjectConfig } from "../../src/client/config.ts";
import { rogueWrite, scratchDir, stopDaemon, until } from "../helpers/fs.ts";
import { REMOTE_HUB, liveHub } from "../helpers/server.ts";

/**
 * Two agents, each in its own host process, talking MCP over stdio to their own
 * `axis mcp` server, exactly as Claude Code or Cursor would. Everything below
 * the transport is real: hub, daemon, OS seals.
 */

const ROOT = path.resolve(import.meta.dir, "../..");
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
let repo: ReturnType<typeof scratchDir>;
let home: string;
let socket: string;
const clients: Client[] = [];

function env(member: string): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    AXIS_HOME: home,
    AXIS_SOCKET: socket,
    AXIS_SYSTEM_SOCKET: path.join(home, "no-system.sock"),
    AXIS_MEMBER: member,
    AXIS_AGENT_VENDOR: "test",
  };
}

async function connect(
  member: string,
  opts: { clientName?: string; env?: Record<string, string> } = {}
): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      path.join(ROOT, "tests/helpers/host.ts"),
      process.execPath,
      path.join(ROOT, "src/cli/main.ts"),
      "mcp",
    ],
    env: opts.env ?? env(member),
    cwd: repo.dir,
    stderr: "pipe",
  });
  const client = new Client({ name: opts.clientName ?? `test-${member}`, version: "1" });
  await client.connect(transport);
  clients.push(client);
  return client;
}

async function call(c: Client, name: string, args: Record<string, unknown> = {}): Promise<string> {
  const r = (await c.callTool({ name, arguments: args })) as {
    content: { type: string; text: string }[];
  };
  return r.content.map((x) => x.text).join("\n");
}

let ana: Client;
let ben: Client;

beforeAll(async () => {
  h = await liveHub();
  repo = scratchDir("axis-mcp-");
  home = mkdtempSync("/tmp/axh-");
  socket = path.join(home, "d.sock");
  mkdirSync(path.join(repo.dir, "src"));
  mkdirSync(path.join(repo.dir, ".git"));
  writeFileSync(path.join(repo.dir, "src/auth.ts"), AUTH);
  writeFileSync(
    path.join(repo.dir, "GUIDE.md"),
    "# Guide\n\n## Install\n\nrun it\n\n## Usage\n\nuse it\n"
  );
  writeProjectConfig(repo.dir, { hub: h.url, project: h.project, name: "acme" });
  const prev = process.env.AXIS_HOME;
  process.env.AXIS_HOME = home;
  saveCredential({
    hub: h.url,
    project: h.project,
    projectName: "acme",
    member: "dana",
    memberToken: h.danaToken,
  });
  process.env.AXIS_HOME = prev;
  ana = await connect("ana");
  ben = await connect("ben");
});

afterAll(async () => {
  for (const c of clients) await c.close().catch(() => {});
  await stopDaemon(socket);
  repo.dispose();
  rmSync(home, { recursive: true, force: true });
  h.close();
});

describe("MCP surface", () => {
  test("ten tools, one-line descriptions, small enough to be cheap in every session", async () => {
    const { tools } = await ana.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "axis_edit",
      "axis_job",
      "axis_lock",
      "axis_note",
      "axis_soul",
      "axis_status",
      "axis_symbols",
      "axis_unlock",
      "axis_wait",
      "axis_write",
    ]);
    for (const t of tools) expect(t.description!.length).toBeLessThan(140);
    const bytes = JSON.stringify(tools).length + (ana.getInstructions()?.length ?? 0);
    // ~4 bytes per token: the whole surface, instructions included, stays under ~1.3k tokens.
    expect(bytes).toBeLessThan(5200);
  });

  test("status introduces the agent and its enforcement tier", async () => {
    const out = await call(ana, "axis_status");
    expect(out).toContain("you are ana/test");
    expect(out).toMatch(/enforcement here: guard/);
  });
});

describe("two agents, one file, different functions", () => {
  test("ana edits login: the edit lands, login is auto-locked, the file is sealed", async () => {
    const out = await call(ana, "axis_edit", {
      path: "src/auth.ts",
      old: "return u;",
      new: "return u.trim();",
      why: "trim usernames",
    });
    expect(out).toMatch(/^OK wrote src\/auth.ts \[Auth.login\] · auto-locked Auth.login/);
    expect(readFileSync(path.join(repo.dir, "src/auth.ts"), "utf8")).toContain("return u.trim();");
    expect(rogueWrite(path.join(repo.dir, "src/auth.ts"), "x")).toMatch(/^(EPERM|EACCES)$/);
  });

  test("ben is denied login with ana's reason, the free functions, and advice", async () => {
    const out = await call(ben, "axis_edit", {
      path: "src/auth.ts",
      old: "return u.trim();",
      new: "return u;",
    });
    const lines = out.split("\n");
    expect(lines[0]).toBe("DENIED src/auth.ts#Auth.login");
    expect(lines[1]).toMatch(
      /^ {2}ana\/test@.+: "trim usernames" · active (now|\ds) ago · held .+ · lease \d+m/
    );
    expect(out).toContain("free in src/auth.ts: Auth.logout");
    expect(out).toMatch(/→ (wait|work_elsewhere): /);
    expect(out).toContain("Nothing was written.");
  });

  test("ben edits logout in the same file at the same time", async () => {
    const out = await call(ben, "axis_edit", {
      path: "src/auth.ts",
      old: "return true;",
      new: "return false;",
    });
    expect(out).toMatch(/^OK wrote src\/auth.ts \[Auth.logout\]/);
    const text = readFileSync(path.join(repo.dir, "src/auth.ts"), "utf8");
    expect(text).toContain("return u.trim();");
    expect(text).toContain("return false;");
  });

  test("symbols shows who holds what", async () => {
    const out = await call(ben, "axis_symbols", { path: "src/auth.ts" });
    expect(out).toMatch(/Auth.login method L2-4 ← ana\/test: "trim usernames"/);
    expect(out).toMatch(/Auth.logout method L6-8 ← you/);
  });

  test("Markdown locks by section: an edit takes one heading, symbols shows it", async () => {
    const out = await call(ana, "axis_edit", {
      path: "GUIDE.md",
      old: "use it",
      new: "use it well",
    });
    expect(out).toMatch(/^OK wrote GUIDE.md \[Usage\]/);
    const syms = await call(ben, "axis_symbols", { path: "GUIDE.md" });
    expect(syms).toMatch(/^GUIDE.md \(markdown\):/);
    expect(syms).toMatch(/Install section L3-5\n/);
    expect(syms).toMatch(/Usage section L7-9 ← ana\/test/);
    await call(ana, "axis_unlock", { targets: ["GUIDE.md#Usage"] });
  });

  test("ben waits; ana unlocks; ben is handed the lock and told about it", async () => {
    const waiting = call(ben, "axis_wait", {
      targets: ["src/auth.ts#Auth.login"],
      why: "revert trim",
      seconds: 20,
    });
    await Bun.sleep(300);
    const t0 = Date.now();
    const unlocked = await call(ana, "axis_unlock");
    expect(unlocked).toMatch(/^OK released src\/auth.ts#Auth.login/);
    const out = await waiting;
    expect(out).toMatch(/^OK locked src\/auth.ts#Auth.login \(waited \d+\.\ds\)/);
    // Prompt hand-off, not the 20s timeout (a hosted hub adds real network round trips).
    expect(Date.now() - t0).toBeLessThan(REMOTE_HUB ? 8000 : 2000);
    // Ana learns about the hand-off from the team trailer on her next result(s), without asking.
    const next = await call(ana, "axis_note", { text: "login is ben's now" });
    expect(unlocked + next).toMatch(
      /\nteam:[\s\S]*ben\/test locked src\/auth.ts#Auth.login after waiting \d+\.\ds: revert trim/
    );
  });

  test("write a single symbol by name", async () => {
    const out = await call(ben, "axis_write", {
      path: "src/auth.ts",
      symbol: "Auth.login",
      content: "  login(u: string) {\n    return u.toLowerCase();\n  }",
    });
    expect(out).toMatch(/^OK wrote src\/auth.ts \[Auth.login\]/);
    expect(readFileSync(path.join(repo.dir, "src/auth.ts"), "utf8")).toContain(
      "return u.toLowerCase();"
    );
  });

  test("new files are created and locked", async () => {
    const out = await call(ana, "axis_edit", {
      path: "src/new.ts",
      old: "",
      new: "export const x = 1;\n",
    });
    expect(out).toMatch(/^OK wrote src\/new.ts/);
    expect(readFileSync(path.join(repo.dir, "src/new.ts"), "utf8")).toBe("export const x = 1;\n");
  });
});

describe("jobs, notes, soul", () => {
  test("post, claim, finish: finishing releases the job's locks", async () => {
    expect(
      await call(ana, "axis_job", { do: "post", title: "add rate limiting", priority: "high" })
    ).toMatch(/^OK posted J1 \[todo\/high\] add rate limiting/);
    expect(await call(ana, "axis_job", { do: "claim" })).toMatch(/^CLAIMED J1: add rate limiting/);
    await call(ana, "axis_edit", {
      path: "src/limit.ts",
      old: "",
      new: "export function limit() {}\n",
    });
    const done = await call(ana, "axis_job", {
      do: "done",
      outcome: "token bucket in src/limit.ts",
    });
    expect(done).toMatch(/^OK J1 done, released src\/limit.ts/);
    expect(await call(ben, "axis_job", { do: "list" })).toContain("J1 [done] add rate limiting");
  });

  test("notes and soul are shared", async () => {
    await call(ana, "axis_soul", {
      context: "Payments service",
      conventions: "No default exports.",
    });
    expect(await call(ben, "axis_soul")).toContain("No default exports.");
    expect(await call(ben, "axis_note")).toContain("login is ben's now");
  });

  test("a closed session releases its locks for everyone", async () => {
    await clients[1]!.close(); // ben's host exits
    const released = await until(
      async () => !(await call(ana, "axis_status")).includes("ben/test@"),
      5000,
      100
    );
    expect(released).toBe(true);
    expect(
      await call(ana, "axis_lock", { targets: ["src/auth.ts#Auth.login"], why: "mine again" })
    ).toMatch(/^OK locked src\/auth.ts#Auth.login/);
  });
});

test("a host that scrubs the environment is still named from the MCP handshake", async () => {
  // Codex passes MCP servers an allow-listed environment: no vendor markers at all.
  const scrubbed = Object.fromEntries(
    Object.entries(env("cody")).filter(
      ([k]) => !/^(AXIS_AGENT_VENDOR|CLAUDE|CURSOR|CODEX|GEMINI|WINDSURF|CLINE|AIDER)/.test(k)
    )
  );
  const cody = await connect("cody", { clientName: "codex-mcp-client", env: scrubbed });
  expect(await call(cody, "axis_status")).toContain("you are cody/codex");
});
