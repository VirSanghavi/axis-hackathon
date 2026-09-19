import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";

/**
 * Where Axis keeps things.
 *
 *   <repo>/.axis/axis.json      committed. Which hub + project this repo uses.
 *   ~/.axis/credentials.json    per machine, 0600. Member tokens, never committed.
 *   ~/.axis/device.json         per machine. Stable device id.
 *   ~/.axis/axisd.sock          the user-level daemon's socket (/tmp/axis-<uid>/ if that path is too long).
 *   /var/run/axis/axisd.sock    the root (kernel-tier) daemon's socket, if installed.
 */

export const HOSTED_HUB =
  process.env.AXIS_DEFAULT_HUB ?? "https://enqocfrutvwvvzcfymxs.supabase.co/functions/v1/axis";
export const LOCAL_HUB = "http://127.0.0.1:4455";

/**
 * Supabase runs an edge function in the region nearest the caller unless told
 * otherwise; the hub makes several database round trips per call, so it should
 * run next to its database. Clients pin it with the `x-region` header.
 */
export const HOSTED_HUB_REGION = "us-west-2";

export function hubRegion(baseUrl: string): string | undefined {
  if (process.env.AXIS_HUB_REGION) return process.env.AXIS_HUB_REGION;
  return baseUrl.replace(/\/+$/, "") === HOSTED_HUB ? HOSTED_HUB_REGION : undefined;
}

export function axisHome(): string {
  return process.env.AXIS_HOME ?? path.join(os.homedir(), ".axis");
}

export const SYSTEM_SOCKET = process.env.AXIS_SYSTEM_SOCKET ?? "/var/run/axis/axisd.sock";

/** Unix socket paths are capped at 104 bytes on macOS (108 on Linux). */
const MAX_SOCKET_PATH = 100;

export function userSocket(): string {
  if (process.env.AXIS_SOCKET) return process.env.AXIS_SOCKET;
  const preferred = path.join(axisHome(), "axisd.sock");
  if (Buffer.byteLength(preferred) <= MAX_SOCKET_PATH) return preferred;
  // A home too deep for a socket: use a short path in a private per-user directory under /tmp.
  const id = createHash("sha256").update(preferred).digest("hex").slice(0, 12);
  return `/tmp/axis-${process.getuid?.() ?? 0}/${id}.sock`;
}

/**
 * Create (or check) the directory a user socket lives in: a real directory, owned
 * by us, closed to everyone else. Anywhere shared like /tmp, another user could
 * pre-create it to capture our tokens, so we refuse any directory we don't own.
 */
export function ensurePrivateSocketDir(socket: string): void {
  const dir = path.dirname(socket);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  const uid = process.getuid?.();
  if (!st.isDirectory() || (uid !== undefined && st.uid !== uid)) {
    throw new Error(
      `${dir} is not a directory owned by you; refusing to use it for the Axis socket.`
    );
  }
  if (st.mode & 0o077) chmodSync(dir, 0o700);
}

export interface ProjectConfig {
  hub: string;
  project: string;
  name: string;
}

export interface Credential {
  hub: string;
  project: string;
  projectName: string;
  member: string;
  memberToken: string;
}

/** Walk up from `start` to the directory holding `.axis/axis.json`, else the git root. */
export function findWorkspaceRoot(start: string = process.cwd()): string | null {
  let dir = path.resolve(start);
  let gitRoot: string | null = null;
  while (true) {
    if (existsSync(path.join(dir, ".axis", "axis.json"))) return dir;
    if (!gitRoot && existsSync(path.join(dir, ".git"))) gitRoot = dir;
    const up = path.dirname(dir);
    if (up === dir) return gitRoot;
    dir = up;
  }
}

export function readProjectConfig(root: string): ProjectConfig | null {
  const f = path.join(root, ".axis", "axis.json");
  if (!existsSync(f)) return null;
  try {
    const c = JSON.parse(readFileSync(f, "utf8")) as Partial<ProjectConfig>;
    if (!c.hub || !c.project) return null;
    return { hub: c.hub, project: c.project, name: c.name ?? path.basename(root) };
  } catch {
    return null;
  }
}

export function writeProjectConfig(root: string, cfg: ProjectConfig): void {
  mkdirSync(path.join(root, ".axis"), { recursive: true });
  writeFileSync(path.join(root, ".axis", "axis.json"), JSON.stringify(cfg, null, 2) + "\n");
}

function credentialsFile(): string {
  return path.join(axisHome(), "credentials.json");
}

export function readCredentials(): Credential[] {
  try {
    return JSON.parse(readFileSync(credentialsFile(), "utf8")).credentials ?? [];
  } catch {
    return [];
  }
}

export function findCredential(hub: string, project: string): Credential | null {
  const norm = (u: string) => u.replace(/\/+$/, "");
  return readCredentials().find((c) => norm(c.hub) === norm(hub) && c.project === project) ?? null;
}

export function saveCredential(c: Credential): void {
  const all = readCredentials().filter((x) => !(x.hub === c.hub && x.project === c.project));
  all.push(c);
  mkdirSync(axisHome(), { recursive: true, mode: 0o700 });
  writeFileSync(credentialsFile(), JSON.stringify({ credentials: all }, null, 2), { mode: 0o600 });
  chmodSync(credentialsFile(), 0o600);
}

export function deviceId(): string {
  const f = path.join(axisHome(), "device.json");
  try {
    return JSON.parse(readFileSync(f, "utf8")).id;
  } catch {
    const id = `d_${os
      .hostname()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .slice(0, 24)}-${randomBytes(3).toString("hex")}`;
    mkdirSync(axisHome(), { recursive: true, mode: 0o700 });
    writeFileSync(f, JSON.stringify({ id }));
    return id;
  }
}

/** Env markers exposed by agent hosts (ported from Axis v1 agent-identity). */
export function detectVendor(env: NodeJS.ProcessEnv = process.env): string {
  if (env.AXIS_AGENT_VENDOR) return env.AXIS_AGENT_VENDOR;
  if (env.CURSOR_TRACE_ID || env.CURSOR_SESSION_ID || env.CURSOR_AGENT) return "cursor";
  if (env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT || env.CLAUDE_CODE_SSE_PORT)
    return "claude-code";
  if (env.CODEX_MANAGED_BY_NPM || env.CODEX_SANDBOX || env.CODEX_HOME) return "codex";
  if (env.WINDSURF_SESSION_ID || env.WINDSURF_SESSION) return "windsurf";
  if (env.GEMINI_CLI || env.GEMINI_SESSION_ID) return "gemini";
  if (env.CLINE_TASK_ID) return "cline";
  if (env.AIDER_MODEL || env.AIDER_SESSION_ID) return "aider";
  return "agent";
}

/**
 * The vendor named by an MCP client's `initialize` clientInfo, for hosts that scrub
 * the environment of the servers they launch (Codex passes only an allow-list).
 */
export function vendorFromClient(name: string | undefined): string | undefined {
  const n = (name ?? "").toLowerCase();
  for (const [needle, vendor] of [
    ["codex", "codex"],
    ["claude", "claude-code"],
    ["cursor", "cursor"],
    ["gemini", "gemini"],
    ["windsurf", "windsurf"],
    ["cline", "cline"],
    ["visual studio code", "vscode"],
  ] as const)
    if (n.includes(needle)) return vendor;
  return undefined;
}

export function memberName(): string {
  return process.env.AXIS_MEMBER ?? os.userInfo().username;
}
