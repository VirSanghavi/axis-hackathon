import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { wireHosts as wire } from "../../src/cli/agents.ts";
import { scratchDir } from "../helpers/fs.ts";

// `axis init` wires every agent host it finds. Home is a scratch dir and nothing
// counts as installed, so the test never reads or writes this machine's configs.
let root: ReturnType<typeof scratchDir>;
let home: ReturnType<typeof scratchDir>;
const saved = process.env.CODEX_HOME;
const wireHosts = (dir: string) => wire(dir, { home: home.dir, installed: () => false });
const read = (f: string) => JSON.parse(readFileSync(f, "utf8"));

beforeEach(() => {
  root = scratchDir("axis-wire-");
  home = scratchDir("axis-home-");
  delete process.env.CODEX_HOME;
});
afterEach(() => {
  if (saved) process.env.CODEX_HOME = saved;
  root.dispose();
  home.dispose();
});

test("claude code and cursor always; the rest only where they are used", () => {
  const hosts = wireHosts(root.dir).map((w) => w.host);
  expect(hosts.slice(0, 4)).toEqual(["claude-code", "claude-code hooks", "cursor", "cursor hooks"]);
  expect(hosts).not.toContain("gemini cli");
  expect(hosts).not.toContain("windsurf");
  expect(hosts).not.toContain("codex");
  expect(read(path.join(root.dir, ".mcp.json")).mcpServers.axis).toEqual({
    command: "axis",
    args: ["mcp"],
  });
});

test("every host gets the right file and shape, other servers survive, re-runs change nothing", () => {
  mkdirSync(path.join(root.dir, ".vscode"));
  mkdirSync(path.join(home.dir, ".gemini"));
  mkdirSync(path.join(home.dir, ".codeium", "windsurf"), { recursive: true });
  mkdirSync(path.join(home.dir, ".codex"));
  mkdirSync(path.join(root.dir, ".cursor"));
  writeFileSync(
    path.join(root.dir, ".cursor", "mcp.json"),
    JSON.stringify({ mcpServers: { other: { command: "x" } } })
  );

  const first = wireHosts(root.dir);
  expect(first.map((w) => w.host)).toEqual([
    "claude-code",
    "claude-code hooks",
    "cursor",
    "cursor hooks",
    "codex",
    "codex hooks",
    "vs code",
    "gemini cli",
    "gemini hooks",
    "windsurf",
  ]);
  expect(first.every((w) => w.changed && !w.conflict)).toBe(true);

  expect(read(path.join(root.dir, ".vscode", "mcp.json"))).toEqual({
    servers: { axis: { type: "stdio", command: "axis", args: ["mcp"] } },
  });
  expect(read(path.join(root.dir, ".gemini", "settings.json")).mcpServers.axis.command).toBe(
    "axis"
  );
  expect(
    read(path.join(home.dir, ".codeium", "windsurf", "mcp_config.json")).mcpServers.axis.args
  ).toEqual(["mcp"]);
  const toml = readFileSync(path.join(home.dir, ".codex", "config.toml"), "utf8");
  expect(toml).toContain('[mcp_servers.axis]\ncommand = "axis"');
  expect(toml).toContain('[mcp_servers.axis.tools.axis_wait]\napproval_mode = "approve"');
  expect(toml.match(/approval_mode/g)).toHaveLength(10);
  // Codex scrubs the environment of MCP servers; Axis settings must be forwarded by name.
  expect(toml).toMatch(/^args = \["mcp"\]\nenv_vars = \[.*"AXIS_HOME".*"AXIS_SOCKET".*\]$/m);
  expect(read(path.join(root.dir, ".cursor", "mcp.json")).mcpServers.other).toEqual({
    command: "x",
  });
  const hooks = read(path.join(root.dir, ".claude", "settings.json")).hooks;
  expect(hooks.PreToolUse[0].matcher).toBe("Edit|MultiEdit|Write");
  const cursor = read(path.join(root.dir, ".cursor", "hooks.json"));
  expect(cursor.version).toBe(1);
  expect(cursor.hooks.preToolUse).toEqual([
    { type: "command", command: "axis hook cursor", matcher: "Write", timeout: 30 },
  ]);
  const codexHooks = read(path.join(home.dir, ".codex", "hooks.json")).hooks;
  expect(codexHooks.PreToolUse[0]).toEqual({
    matcher: "apply_patch|Edit|Write",
    hooks: [{ type: "command", command: "axis hook codex", timeout: 30 }],
  });
  expect(codexHooks.PostToolUse[0].hooks[0].command).toBe("axis hook codex");
  const gemini = read(path.join(root.dir, ".gemini", "settings.json"));
  expect(gemini.mcpServers.axis.command).toBe("axis");
  expect(gemini.hooks.BeforeTool[0].matcher).toBe("write_file|replace");

  expect(wireHosts(root.dir).some((w) => w.changed)).toBe(false);
});

test("a global config's foreign axis server is reported and left alone", () => {
  const dir = path.join(home.dir, ".codeium", "windsurf");
  mkdirSync(dir, { recursive: true });
  const foreign = { mcpServers: { axis: { command: "npx", args: ["axis-v1"] } } };
  writeFileSync(path.join(dir, "mcp_config.json"), JSON.stringify(foreign));
  const w = wireHosts(root.dir).find((x) => x.host === "windsurf")!;
  expect(w.conflict).toMatch(/left it alone/);
  expect(read(path.join(dir, "mcp_config.json"))).toEqual(foreign);
  expect(existsSync(path.join(root.dir, ".mcp.json"))).toBe(true);
});

test("an axis block from an older install gains env forwarding once, and keeps the rest", () => {
  mkdirSync(path.join(home.dir, ".codex"));
  const file = path.join(home.dir, ".codex", "config.toml");
  writeFileSync(
    file,
    'model = "o3"\n\n[mcp_servers.axis]\ncommand = "axis"\nargs = ["mcp"]\nstartup_timeout_sec = 20\n\n[mcp_servers.other]\ncommand = "x"\n'
  );
  expect(wireHosts(root.dir).find((w) => w.host === "codex")!.changed).toBe(true);
  const toml = readFileSync(file, "utf8");
  expect(toml).toContain(
    '[mcp_servers.axis]\ncommand = "axis"\nargs = ["mcp"]\nenv_vars = ["AXIS_HOME"'
  );
  expect(toml).toContain('startup_timeout_sec = 20\n\n[mcp_servers.other]\ncommand = "x"');
  expect(toml.match(/env_vars/g)).toHaveLength(1);
  expect(wireHosts(root.dir).find((w) => w.host === "codex")!.changed).toBe(false);
});

test("an installed program is enough to wire its host", () => {
  const hosts = wire(root.dir, { home: home.dir, installed: (c) => c === "gemini" }).map(
    (w) => w.host
  );
  expect(hosts).toContain("gemini cli");
  expect(hosts).toContain("gemini hooks");
  expect(hosts).not.toContain("vs code");
});

test("the user's own hooks survive and ours is never duplicated", () => {
  mkdirSync(path.join(home.dir, ".codex"));
  const mine = { matcher: "Bash", hooks: [{ type: "command", command: "my-audit" }] };
  writeFileSync(
    path.join(home.dir, ".codex", "hooks.json"),
    JSON.stringify({ hooks: { PreToolUse: [mine] } })
  );
  wireHosts(root.dir);
  wireHosts(root.dir);
  const pre = read(path.join(home.dir, ".codex", "hooks.json")).hooks.PreToolUse;
  expect(pre).toHaveLength(2);
  expect(pre[0]).toEqual(mine);
});

test("git hooks re-check locks after checkout, merge and rebase, next to the user's own", () => {
  Bun.spawnSync(["git", "init", "-q", root.dir]);
  const hooks = path.join(root.dir, ".git", "hooks");
  mkdirSync(hooks, { recursive: true });
  writeFileSync(path.join(hooks, "post-merge"), "#!/bin/sh\necho mine\n");
  const first = wireHosts(root.dir).find((w) => w.host === "git hooks")!;
  expect(first.changed).toBe(true);
  for (const name of ["post-checkout", "post-merge", "post-rewrite"]) {
    const text = readFileSync(path.join(hooks, name), "utf8");
    expect(text).toContain("axis sync --quiet");
    expect(statSync(path.join(hooks, name)).mode & 0o111).toBeTruthy();
  }
  expect(readFileSync(path.join(hooks, "post-merge"), "utf8")).toStartWith(
    "#!/bin/sh\necho mine\n"
  );
  expect(wireHosts(root.dir).find((w) => w.host === "git hooks")!.changed).toBe(false);
});

test("outside a git repository there are no git hooks to wire", () => {
  expect(wireHosts(root.dir).some((w) => w.host === "git hooks")).toBe(false);
});
