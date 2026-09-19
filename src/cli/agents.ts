import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Wire Axis into every agent host we know, idempotently. Re-running never
 * duplicates an entry and never drops the user's other servers or hooks.
 */

export interface WiredHost {
  host: string;
  file: string;
  changed: boolean;
  /** Set when an entry we don't own is already there. */
  conflict?: string;
  /** Something the person has to do once in that host. */
  note?: string;
}

const MCP_ENTRY = { command: "axis", args: ["mcp"] };
const HOOK_CMD = "axis hook claude";

function readJson(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error(`${file} is not valid JSON; fix it and re-run \`axis init\`.`);
  }
}

function writeJson(file: string, data: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

/** Add `axis` under `key` (mcpServers for most hosts, servers for VS Code). */
function addMcpServer(
  file: string,
  host: string,
  key = "mcpServers",
  entry: Record<string, unknown> = MCP_ENTRY,
  global = false
): WiredHost {
  const data = readJson(file);
  const servers = (data[key] ?? {}) as Record<string, unknown>;
  const before = JSON.stringify(servers.axis);
  // A global config is shared by every project, so an `axis` server that isn't ours stays.
  if (global && servers.axis && before !== JSON.stringify(entry))
    return { host, file, changed: false, conflict: "has a different axis server; left it alone" };
  servers.axis = entry;
  data[key] = servers;
  const changed = before !== JSON.stringify(entry);
  if (changed) writeJson(file, data);
  return { host, file, changed };
}

/** Where this machine's global configs live and which programs it has (tests substitute their own). */
export interface HostEnv {
  home: string;
  installed: (cmd: string) => boolean;
}

const machine: HostEnv = { home: os.homedir(), installed: (cmd) => Bun.which(cmd) !== null };

type HookGroup = { matcher?: string; hooks: { type: string; command: string; timeout?: number }[] };

function addClaudeHooks(file: string): WiredHost {
  const data = readJson(file);
  const hooks = (data.hooks ?? {}) as Record<string, HookGroup[]>;
  let changed = false;
  const ensure = (event: string, matcher: string) => {
    const groups = (hooks[event] ??= []);
    const has = groups.some(
      (g) => g.matcher === matcher && g.hooks.some((h) => h.command === HOOK_CMD)
    );
    if (!has) {
      groups.push({ matcher, hooks: [{ type: "command", command: HOOK_CMD, timeout: 30 }] });
      changed = true;
    }
  };
  ensure("PreToolUse", "Edit|MultiEdit|Write");
  ensure("PostToolUse", "Read");
  data.hooks = hooks;
  if (changed) writeJson(file, data);
  return { host: "claude-code hooks", file, changed };
}

/** Axis's MCP tools, pre-approved in Codex so they work under `codex exec` and without a prompt per call. */
const CODEX_TOOLS = [
  "axis_status",
  "axis_edit",
  "axis_write",
  "axis_lock",
  "axis_unlock",
  "axis_wait",
  "axis_symbols",
  "axis_job",
  "axis_note",
  "axis_soul",
];

/**
 * Codex launches MCP servers with a scrubbed environment, so any Axis setting the
 * user exported (a non-default home, hub, or socket) must be forwarded by name.
 */
const CODEX_ENV_VARS = `env_vars = [${[
  "AXIS_HOME",
  "AXIS_HUB",
  "AXIS_MEMBER",
  "AXIS_SOCKET",
  "AXIS_SYSTEM_SOCKET",
  "AXIS_WORKSPACE_ROOT",
  "AXIS_AGENT_VENDOR",
]
  .map((v) => `"${v}"`)
  .join(", ")}]`;

/** Codex config is global, so an `axis` server that isn't ours (e.g. Axis v1) is reported, never overwritten. */
function addCodex(home: string): WiredHost | null {
  const dir = process.env.CODEX_HOME ?? path.join(home, ".codex");
  if (!existsSync(dir)) return null;
  const file = path.join(dir, "config.toml");
  let text = existsSync(file) ? readFileSync(file, "utf8") : "";
  const existing = /^\[mcp_servers\.axis\]\n((?:(?!\[).*\n?)*)/m.exec(text);
  if (existing) {
    const ours =
      /^command\s*=\s*"axis"\s*$/m.test(existing[1] ?? "") &&
      /^args\s*=\s*\["mcp"\]\s*$/m.test(existing[1] ?? "");
    if (!ours)
      return {
        host: "codex",
        file,
        changed: false,
        conflict: "has a different [mcp_servers.axis]; left it alone",
      };
  } else
    text += `${text && !text.endsWith("\n") ? "\n" : ""}\n[mcp_servers.axis]\ncommand = "axis"\nargs = ["mcp"]\n${CODEX_ENV_VARS}\n`;
  // Our block from an older Axis: add the env forwarding in place.
  const needsEnv = !!existing && !/^env_vars\s*=/m.test(existing[1] ?? "");
  if (needsEnv)
    text = text.replace(
      /^(\[mcp_servers\.axis\]\n(?:(?!\[).*\n)*?args\s*=.*\n)/m,
      `$1${CODEX_ENV_VARS}\n`
    );
  const missing = CODEX_TOOLS.filter(
    (t) => !new RegExp(`^\\[mcp_servers\\.axis\\.tools\\.${t}\\]$`, "m").test(text)
  );
  for (const t of missing) text += `\n[mcp_servers.axis.tools.${t}]\napproval_mode = "approve"\n`;
  const changed = !existing || needsEnv || missing.length > 0;
  if (changed) writeFileSync(file, text);
  return { host: "codex", file, changed };
}

type CmdHook = { type: string; command: string; timeout?: number };

/**
 * Codex, Gemini: Claude-style `{hooks: {Event: [{matcher, hooks: [cmd]}]}}`. Our entry is
 * found by its command, so re-running updates it in place and never touches the user's own.
 */
function addEventHooks(
  file: string,
  host: string,
  events: string[],
  matcher: string,
  command: string
): WiredHost {
  const data = readJson(file);
  const hooks = (data.hooks ?? {}) as Record<string, HookGroup[]>;
  const before = JSON.stringify(hooks);
  for (const event of events) {
    const groups = (hooks[event] ?? []).filter((g) => !g.hooks.some((h) => h.command === command));
    groups.push({ matcher, hooks: [{ type: "command", command, timeout: 30 }] });
    hooks[event] = groups;
  }
  data.hooks = hooks;
  const changed = JSON.stringify(hooks) !== before;
  if (changed) writeJson(file, data);
  return { host, file, changed };
}

/** Cursor: `{version: 1, hooks: {event: [{command, matcher}]}}`. */
function addCursorHooks(file: string): WiredHost {
  const command = "axis hook cursor";
  const data = readJson(file);
  const hooks = (data.hooks ?? {}) as Record<string, (CmdHook & { matcher?: string })[]>;
  const before = JSON.stringify(data);
  for (const event of ["preToolUse", "postToolUse", "postToolUseFailure"]) {
    const list = (hooks[event] ?? []).filter((h) => h.command !== command);
    list.push({ type: "command", command, matcher: "Write", timeout: 30 });
    hooks[event] = list;
  }
  data.version = 1;
  data.hooks = hooks;
  const changed = JSON.stringify(data) !== before;
  if (changed) writeJson(file, data);
  return { host: "cursor hooks", file, changed };
}

const GIT_HOOK_LINE = "command -v axis >/dev/null 2>&1 && axis sync --quiet || true";

/**
 * After git rewrites the working tree (checkout, merge, pull, rebase), have the
 * daemon re-check every lock at once: locked files git moved carry their locks,
 * missing ones are announced, replaced ones are sealed again. Appended to any
 * existing hook, in whatever hooks directory git uses (core.hooksPath included).
 */
function addGitHooks(root: string): WiredHost | null {
  const r = Bun.spawnSync(["git", "-C", root, "rev-parse", "--git-path", "hooks"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  if (r.exitCode !== 0) return null;
  const dir = path.resolve(root, r.stdout.toString().trim());
  mkdirSync(dir, { recursive: true });
  let changed = false;
  for (const name of ["post-checkout", "post-merge", "post-rewrite"]) {
    const file = path.join(dir, name);
    const text = existsSync(file) ? readFileSync(file, "utf8") : "";
    if (text.includes(GIT_HOOK_LINE)) continue;
    const head = text ? (text.endsWith("\n") ? text : text + "\n") : "#!/bin/sh\n";
    writeFileSync(
      file,
      `${head}# axis: re-check locks after git changed the working tree\n${GIT_HOOK_LINE}\n`
    );
    chmodSync(file, 0o755);
    changed = true;
  }
  return { host: "git hooks", file: dir, changed };
}

export function wireHosts(root: string, env: HostEnv = machine): WiredHost[] {
  const out: WiredHost[] = [
    addMcpServer(path.join(root, ".mcp.json"), "claude-code"),
    addClaudeHooks(path.join(root, ".claude", "settings.json")),
    addMcpServer(path.join(root, ".cursor", "mcp.json"), "cursor"),
    addCursorHooks(path.join(root, ".cursor", "hooks.json")),
  ];
  const git = addGitHooks(root);
  if (git) out.push(git);
  const codex = addCodex(env.home);
  if (codex) {
    out.push(codex);
    // Codex loads project hooks only from trusted folders, so its edit hooks go in the user's
    // config; outside an Axis repo the hook does nothing.
    out.push({
      ...addEventHooks(
        path.join(process.env.CODEX_HOME ?? path.join(env.home, ".codex"), "hooks.json"),
        "codex hooks",
        ["PreToolUse", "PostToolUse"],
        "apply_patch|Edit|Write",
        "axis hook codex"
      ),
      // Codex runs a new hook only after its user has reviewed it; that trust is theirs to give.
      note: "approve the Axis hook once in Codex (it asks on next start, or /hooks)",
    });
  }
  // Hosts below are wired only when this machine or repo already uses them.
  const home = env.home;
  if (existsSync(path.join(root, ".vscode")) || env.installed("code"))
    out.push(
      addMcpServer(path.join(root, ".vscode", "mcp.json"), "vs code", "servers", {
        type: "stdio",
        ...MCP_ENTRY,
      })
    );
  if (existsSync(path.join(home, ".gemini")) || env.installed("gemini")) {
    const settings = path.join(root, ".gemini", "settings.json");
    out.push(addMcpServer(settings, "gemini cli"));
    out.push(
      addEventHooks(
        settings,
        "gemini hooks",
        ["BeforeTool", "AfterTool"],
        "write_file|replace",
        "axis hook gemini"
      )
    );
  }
  const windsurf = path.join(home, ".codeium", "windsurf");
  if (existsSync(windsurf))
    out.push(
      addMcpServer(
        path.join(windsurf, "mcp_config.json"),
        "windsurf",
        "mcpServers",
        MCP_ENTRY,
        true
      )
    );
  return out;
}

/** Agent hosts on this machine whose config already runs the axis MCP server (read only). */
export function wiredHosts(root: string, env: HostEnv = machine): string[] {
  const has = (file: string, key = "mcpServers") => {
    try {
      return !!(JSON.parse(readFileSync(file, "utf8"))[key] ?? {}).axis;
    } catch {
      return false;
    }
  };
  const codex = path.join(process.env.CODEX_HOME ?? path.join(env.home, ".codex"), "config.toml");
  const out: string[] = [];
  if (has(path.join(root, ".mcp.json"))) out.push("claude-code");
  if (has(path.join(root, ".cursor", "mcp.json"))) out.push("cursor");
  if (existsSync(codex) && /^\[mcp_servers\.axis\]$/m.test(readFileSync(codex, "utf8")))
    out.push("codex");
  if (has(path.join(root, ".vscode", "mcp.json"), "servers")) out.push("vs code");
  if (has(path.join(root, ".gemini", "settings.json"))) out.push("gemini cli");
  if (has(path.join(env.home, ".codeium", "windsurf", "mcp_config.json"))) out.push("windsurf");
  return out;
}
