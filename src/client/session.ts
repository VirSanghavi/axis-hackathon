import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentRef } from "../protocol/types.ts";
import { axisHome, detectVendor, memberName } from "./config.ts";
import { HubClient } from "./hub-client.ts";

/**
 * One agent identity per host session.
 *
 * A Claude Code session runs the Axis MCP server AND fires Axis hooks, as two
 * different processes. Both must act as the SAME agent, or the hook would be
 * blocked by the locks its own session took. They share the host process as a
 * common ancestor, so the identity is keyed by that pid: whoever arrives first
 * (normally the MCP server, at session start) creates it, the other adopts it.
 */

export interface AgentSession {
  token: string;
  agent: AgentRef;
  hostPid: number;
  project: string;
}

function sessionDir(): string {
  return path.join(axisHome(), "sessions");
}

function fileFor(project: string, hostPid: number): string {
  return path.join(sessionDir(), `${project}-${hostPid}.json`);
}

function parentOf(pid: number): number | null {
  if (pid <= 1) return null;
  const p = Bun.spawnSync(["ps", "-o", "ppid=", "-p", String(pid)], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const n = Number(p.stdout.toString().trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Ancestor pids, nearest first (bounded; hosts wrap hooks in one or two shells). */
export function ancestors(start = process.ppid, depth = 6): number[] {
  const out: number[] = [];
  let pid: number | null = start;
  while (pid && out.length < depth) {
    out.push(pid);
    pid = parentOf(pid);
  }
  return out;
}

const SHELLS = /^-?(sh|bash|zsh|dash|fish|ksh|env|timeout)$/;

function commOf(pid: number): string {
  const p = Bun.spawnSync(["ps", "-o", "comm=", "-p", String(pid)], {
    stdout: "pipe",
    stderr: "ignore",
  });
  return path.basename(p.stdout.toString().trim());
}

/**
 * The host (Claude Code, Cursor, Codex...) process this code runs under: the
 * nearest ancestor that is not a shell wrapper. MCP servers are spawned by the
 * host directly; hooks usually come through `sh -c`.
 */
export function hostPid(): number {
  for (const pid of ancestors(process.ppid, 4))
    if (pid > 1 && !SHELLS.test(commOf(pid))) return pid;
  // No visible host (launched by init, or across a namespace boundary like `docker exec`,
  // where the parent pid is 0): this process is its own session.
  return process.ppid > 1 ? process.ppid : process.pid;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function findSession(project: string, pids = ancestors()): AgentSession | null {
  for (const pid of pids) {
    const f = fileFor(project, pid);
    if (!existsSync(f)) continue;
    try {
      return JSON.parse(readFileSync(f, "utf8")) as AgentSession;
    } catch {
      /* corrupt: fall through */
    }
  }
  return null;
}

/** Adopt the host session's agent if one exists, otherwise start one keyed to `hostPid`. */
export async function ensureSession(
  hub: HubClient,
  project: string,
  hostPid: number,
  opts: { vendor?: string; name?: string } = {}
): Promise<AgentSession> {
  const existing = findSession(project, [hostPid]);
  if (existing) {
    try {
      await hub.withToken(existing.token).me();
      return existing;
    } catch {
      /* ended or revoked: start fresh */
    }
  }
  const vendor = opts.vendor ?? detectVendor();
  const started = await hub.startAgent({
    vendor,
    name: opts.name ?? `${memberName()}/${vendor}`,
    device: os.hostname(),
  });
  const session: AgentSession = { token: started.token, agent: started.agent, hostPid, project };
  mkdirSync(sessionDir(), { recursive: true, mode: 0o700 });
  writeFileSync(fileFor(project, hostPid), JSON.stringify(session), { mode: 0o600 });
  pruneDead(project);
  return session;
}

export function dropSession(s: AgentSession): void {
  rmSync(fileFor(s.project, s.hostPid), { force: true });
}

function pruneDead(project: string): void {
  try {
    for (const f of readdirSync(sessionDir())) {
      const m = f.match(new RegExp(`^${project}-(\\d+)\\.json$`));
      if (m && !alive(Number(m[1]))) rmSync(path.join(sessionDir(), f), { force: true });
    }
  } catch {
    /* best effort */
  }
}
