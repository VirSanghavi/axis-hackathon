import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  SYSTEM_SOCKET,
  axisHome,
  ensurePrivateSocketDir,
  readCredentials,
  userSocket,
} from "../client/config.ts";
import type { WriteRequest } from "../enforce/gateway.ts";
import type { EnforcementTier, WriteResult } from "../protocol/types.ts";
import type { Settled } from "./daemon.ts";

export interface DaemonStatus {
  tier: EnforcementTier;
  mechanism: string;
  system: boolean;
  pid: number;
  deviceId: string;
  workspaces: {
    root: string;
    hub: string;
    project: string;
    sealed: string[];
    orphaned: string[];
    hubOk: boolean;
    lastError?: string;
  }[];
}

/** Talks to axisd over its unix socket. Prefers the root (kernel-tier) daemon when it is installed. */
export class DaemonClient {
  constructor(readonly socket: string) {}

  static async find(): Promise<DaemonClient | null> {
    for (const s of [SYSTEM_SOCKET, userSocket()]) {
      if (!existsSync(s)) continue;
      if (s !== SYSTEM_SOCKET) ensurePrivateSocketDir(s);
      const c = new DaemonClient(s);
      if (
        await c.status().then(
          () => true,
          () => false
        )
      )
        return c;
    }
    return null;
  }

  /** Find a running daemon, or start the user-level one in the background and wait for it. */
  static async ensure(): Promise<DaemonClient> {
    const found = await DaemonClient.find();
    if (found) return found;
    spawnDaemon();
    const c = new DaemonClient(userSocket());
    for (let i = 0; i < 60; i++) {
      if (
        await c.status().then(
          () => true,
          () => false
        )
      )
        return c;
      await Bun.sleep(100);
    }
    throw new Error(`axisd did not start. See ${path.join(axisHome(), "axisd.log")}.`);
  }

  private async call<T>(route: string, body?: unknown): Promise<T> {
    const res = await fetch(`http://axisd${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      unix: this.socket,
    } as RequestInit);
    const data = (await res.json()) as T & { error?: string };
    if (!res.ok) throw new Error(data.error ?? `axisd error ${res.status}`);
    return data;
  }

  /** The root daemon shows a workspace's details only to holders of its member token. */
  status() {
    return this.call<DaemonStatus>("/status", {
      tokens: readCredentials().map((c) => c.memberToken),
    });
  }

  /** Register a workspace, completing the root daemon's ownership challenge when it asks for one. */
  async register(reg: { root: string; hub: string; project: string; memberToken: string }) {
    type Out =
      | { ok: true; root: string; tier: EnforcementTier; mechanism: string; sealed: number }
      | { challenge: string; file: string };
    let res = await this.call<Out>("/register", reg);
    if ("challenge" in res) {
      mkdirSync(path.dirname(res.file), { recursive: true });
      writeFileSync(res.file, "axis ownership proof\n");
      res = await this.call<Out>("/register", { ...reg, challenge: res.challenge });
    }
    if ("challenge" in res) throw new Error("axisd ownership challenge failed");
    return res;
  }

  unregister(root: string, memberToken: string) {
    return this.call<{ ok: true }>("/unregister", { root, memberToken });
  }

  write(agentToken: string, request: WriteRequest, root?: string) {
    return this.call<WriteResult>("/write", { agentToken, request, root });
  }

  /** Several files as one change: all of it lands, or none of it. */
  writeMany(agentToken: string, requests: WriteRequest[], root?: string) {
    return this.call<WriteResult[]>("/write", { agentToken, requests, root });
  }

  read(agentToken: string, filePath: string, root?: string) {
    return this.call<{ path: string; content: string; hash: string; exists: boolean }>("/read", {
      agentToken,
      path: filePath,
      root,
    });
  }

  seen(filePath: string, content: string, root: string, memberToken: string) {
    return this.call<{ hash: string | null }>("/seen", {
      path: filePath,
      content,
      root,
      memberToken,
    });
  }

  reconcile(root: string, memberToken: string) {
    return this.call<{ sealed: number }>("/reconcile", { root, memberToken });
  }

  /** An agent's own edit tool is about to change `paths`: see {@link Daemon} edit windows. */
  openWindow(agentToken: string, paths: string[], root: string) {
    return this.call<{ status: "open"; paths: string[] } | { status: "denied"; message: string }>(
      "/window/open",
      { agentToken, paths, root }
    );
  }

  closeWindow(agentToken: string, paths: string[], root: string) {
    return this.call<{ results: Settled[] }>("/window/close", { agentToken, paths, root });
  }
}

/** The command that re-runs this same program (works from source and from the compiled binary). */
export function selfCommand(...args: string[]): string[] {
  const entry = process.argv[1];
  const fromSource = !!entry && /\.(ts|js|mjs)$/.test(entry);
  return fromSource ? [process.execPath, entry!, ...args] : [process.execPath, ...args];
}

function spawnDaemon(): void {
  mkdirSync(axisHome(), { recursive: true, mode: 0o700 });
  const log = openSync(path.join(axisHome(), "axisd.log"), "a");
  const [cmd, ...args] = selfCommand("daemon");
  // Own session, so the daemon outlives the agent/terminal that started it.
  const child = spawn(cmd!, args, {
    detached: true,
    stdio: ["ignore", log, log],
    env: process.env,
  });
  child.unref();
}
