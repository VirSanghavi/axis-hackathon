import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensurePrivateSocketDir } from "../client/config.ts";
import { HubClient } from "../client/hub-client.ts";
import { Gateway, type WriteRequest, spliceSymbol } from "../enforce/gateway.ts";
import { parseTarget } from "../protocol/target.ts";
import { splitLines } from "../symbols/coverage.ts";
import { findSymbol, parseSymbols } from "../symbols/parser.ts";
import { findMove } from "./moves.ts";
import { type Sealer, detectSealer, isRoot } from "../enforce/seal.ts";
import type { EnforcementTier, Lock, WriteResult } from "../protocol/types.ts";

/**
 * axisd: one per machine (per user, or one root daemon for the kernel tier).
 *
 * For every registered workspace it keeps the filesystem in step with the
 * team's lock table: any file locked by ANY agent on ANY device is sealed on
 * this machine; everything else is left alone. It is level-triggered, not
 * edge-triggered: each pass computes the desired sealed set from the hub's
 * current locks and converges to it, so a missed event, a restart, or a hub
 * outage can never leave a file wrongly writable or wrongly sealed for long.
 *
 * It also serves the write gateway on a local socket. Sealed files change
 * only through it, and only for agents holding covering locks.
 */

export interface WorkspaceReg {
  root: string;
  hub: string;
  project: string;
  memberToken: string;
  /** Workspace owner, recorded at registration (root daemon writes files back as this user). */
  uid?: number;
  gid?: number;
  /** Files this daemon had sealed (absolute), so a successor after a crash or restart can release stale seals. */
  sealedFiles?: string[];
  /** Their inodes when sealed, so a successor tells a file replaced during the outage from one it simply adopted. */
  sealedInodes?: Record<string, number>;
}

interface Workspace extends WorkspaceReg {
  realRoot: string;
  client: HubClient;
  gateway: Gateway;
  sealed: Set<string>; // absolute paths
  hubOk: boolean;
  lastError?: string;
  stopped: boolean;
  /** Event sequence of the newest lock snapshot applied; older snapshots arriving late are ignored. */
  appliedSeq: number;
  /** The lock table as of `appliedSeq`, re-checked against the disk between hub changes. */
  locks: Lock[];
  /** Inode of each sealed file when it was sealed: a different inode means it was replaced. */
  inodes: Map<string, number>;
  /** Device reports are serialized per workspace: two in flight can land out of order and stale. */
  reporting: boolean;
  reportAgain: boolean;
  /** Content hash of each locked file when last seen, to recognise it after a move. */
  seenHash: Map<string, string>;
  /** Locked paths missing on this machine that the team has already been told about. */
  orphans: Set<string>;
}

export interface DaemonOptions {
  socket: string;
  stateFile: string;
  deviceId: string;
  /** Pass "guard" to force the user-level tier (tests), "off" to disable sealing. */
  prefer?: EnforcementTier;
  /** Longest a lock watch parks at the hub before re-asking (the hub answers the moment anything changes). */
  watchMs?: number;
  /** How often the disk is re-checked against the lock table between hub changes. */
  verifyMs?: number;
  /** This build's version, reported with the device's health. */
  version?: string;
  /** Longest an agent's native edit may keep a file unsealed without its post-tool hook. */
  windowMs?: number;
  log?: (msg: string) => void;
}

export class Daemon {
  private sealer!: Sealer;
  private workspaces = new Map<string, Workspace>();
  private server?: ReturnType<typeof Bun.serve>;
  private challenges = new Map<string, { root: string; expires: number }>();
  private agentProjects = new Map<string, string>();
  private reportTimer?: ReturnType<typeof setInterval>;
  private watchdog?: ReturnType<typeof setInterval>;
  private verifyTimer?: ReturnType<typeof setInterval>;
  readonly system = isRoot();

  constructor(private opts: DaemonOptions) {}

  get tier(): EnforcementTier {
    return this.sealer.tier;
  }

  private log(msg: string) {
    (this.opts.log ?? ((m) => console.error(`[axisd ${new Date().toISOString()}] ${m}`)))(msg);
  }

  async start(): Promise<void> {
    this.sealer = await detectSealer({ prefer: this.opts.prefer });
    this.log(
      `enforcement tier: ${this.sealer.tier} (${this.sealer.mechanism})${this.system ? ", running as root" : ""}`
    );
    if (this.system) mkdirSync(path.dirname(this.opts.socket), { recursive: true });
    else ensurePrivateSocketDir(this.opts.socket);
    if (existsSync(this.opts.socket)) {
      // A live daemon already owns this socket: refuse to start a second one.
      const alive = await fetch("http://axisd/status", {
        unix: this.opts.socket,
      } as RequestInit).then(
        () => true,
        () => false
      );
      if (alive) throw new Error(`Another axisd is already serving ${this.opts.socket}.`);
      unlinkSync(this.opts.socket);
    }
    this.server = Bun.serve({ unix: this.opts.socket, fetch: (req) => this.handle(req) });
    chmodSync(this.opts.socket, this.system ? 0o666 : 0o600);
    this.watchSocket(statSync(this.opts.socket).ino);
    for (const reg of this.loadState()) {
      try {
        await this.addWorkspace(reg, false);
      } catch (e) {
        this.log(`could not restore ${reg.root}: ${(e as Error).message}`);
      }
    }
    // Heartbeat for the dashboard's device list; changes are reported the moment they happen.
    this.reportTimer = setInterval(() => void this.reportAll(), 30_000);
    // Between hub changes the disk can still move under the locks (git checkout, a rename,
    // a delete): re-check the current lock table against it every second.
    this.verifyTimer = setInterval(() => {
      // Only once a real snapshot has landed: until then the adopted seals must stay (fail closed).
      for (const w of this.workspaces.values())
        if (!w.stopped && w.appliedSeq >= 0) this.apply(w, w.locks, w.appliedSeq);
    }, this.opts.verifyMs ?? 1_000);
  }

  /**
   * One daemon per socket. If the socket disappears (its home was deleted) this
   * daemon is orphaned: release everything and exit. If another daemon has taken
   * the socket over, exit WITHOUT unsealing: the successor adopted the sealed set
   * from the state file and is converging it now.
   */
  private watchSocket(ino: number): void {
    this.watchdog = setInterval(() => {
      let now: number | null = null;
      try {
        now = statSync(this.opts.socket).ino;
      } catch {
        /* gone */
      }
      if (now === ino) return;
      clearInterval(this.watchdog);
      if (now === null) {
        this.log("socket removed; releasing seals and exiting");
        void this.stop().then(() => process.exit(0));
      } else {
        this.log("another axisd took over the socket; exiting and leaving its seals to it");
        for (const w of this.workspaces.values()) w.stopped = true;
        this.server?.stop(true);
        process.exit(0);
      }
    }, 2_000);
  }

  /** Graceful stop: unseal everything so no file is left frozen without a daemon to manage it. */
  async stop(): Promise<void> {
    clearInterval(this.watchdog);
    clearInterval(this.verifyTimer);
    clearInterval(this.reportTimer);
    for (const w of this.workspaces.values()) {
      w.stopped = true;
      this.sealer.unseal([...w.sealed]);
      w.sealed.clear();
    }
    this.saveState();
    await this.reportAll();
    this.server?.stop(true);
    try {
      unlinkSync(this.opts.socket);
    } catch {
      /* already gone */
    }
  }

  // ── workspaces ──────────────────────────────────────────────────────────

  private async addWorkspace(reg: WorkspaceReg, persist = true): Promise<Workspace> {
    const realRoot = realpathSync(reg.root);
    const existing = this.workspaces.get(realRoot);
    if (existing && existing.project === reg.project && existing.hub === reg.hub) {
      existing.memberToken = reg.memberToken;
      existing.client = new HubClient(reg.hub, reg.memberToken);
      return existing;
    }
    if (existing) this.removeWorkspace(realRoot);
    const client = new HubClient(reg.hub, reg.memberToken);
    // A new registration must prove its token. A restored one is trusted as saved, so a hub
    // outage at startup never drops a workspace (and strands its seals): the watch loop retries.
    if (persist) await client.me();
    const owner =
      this.system && reg.uid !== undefined ? { uid: reg.uid, gid: reg.gid ?? reg.uid } : undefined;
    const w: Workspace = {
      ...reg,
      realRoot,
      client,
      // Adopt what a previous daemon sealed; the first snapshot releases whatever is no longer locked.
      sealed: new Set(
        (reg.sealedFiles ?? []).filter((p) => p.startsWith(realRoot + path.sep) && existsSync(p))
      ),
      hubOk: true,
      stopped: false,
      appliedSeq: -1,
      locks: [],
      inodes: new Map(Object.entries(reg.sealedInodes ?? {})),
      reporting: false,
      reportAgain: false,
      seenHash: new Map(),
      orphans: new Set(),
      gateway: new Gateway(
        realRoot,
        this.sealer,
        (abs) => {
          // The gateway swaps in a new inode on every write; record it so it is not mistaken for a replacement.
          // Persisted every time, so a successor after a crash compares against the current inode.
          this.remember(w, abs);
          w.sealed.add(abs);
          this.saveState();
        },
        owner
      ),
    };
    this.workspaces.set(realRoot, w);
    if (persist) this.saveState();
    this.follow(w);
    this.log(`watching ${realRoot} (project ${reg.project} on ${reg.hub})`);
    return w;
  }

  private removeWorkspace(realRoot: string): void {
    const w = this.workspaces.get(realRoot);
    if (!w) return;
    w.stopped = true;
    this.sealer.unseal([...w.sealed]);
    this.workspaces.delete(realRoot);
    this.saveState();
  }

  /**
   * Follow the hub's lock table with a long poll: the hub answers the moment
   * anything in the project changes, or after `watchMs` with nothing new. One
   * request per change (or per idle interval) works the same against the local
   * hub and a hosted one, where WebSockets and tight polling are not an option.
   */
  private follow(w: Workspace): void {
    void (async () => {
      let seq = -1;
      let failures = 0;
      while (!w.stopped) {
        try {
          const r = await w.client.watchLocks(seq, seq < 0 ? 0 : (this.opts.watchMs ?? 25_000));
          if (w.stopped) return;
          seq = r.seq;
          failures = 0;
          w.hubOk = true;
          w.lastError = undefined;
          this.apply(w, r.locks, r.seq);
        } catch (e) {
          if (w.stopped) return;
          // Fail closed: keep every existing seal while the hub is unreachable.
          w.hubOk = false;
          w.lastError = (e as Error).message;
          await Bun.sleep(Math.min(500 * 2 ** failures++, 10_000));
        }
      }
    })();
  }

  /** One-shot convergence (registration, `axis doctor`). */
  private async reconcile(w: Workspace): Promise<void> {
    try {
      const r = await w.client.watchLocks(-1, 0);
      w.hubOk = true;
      w.lastError = undefined;
      this.apply(w, r.locks, r.seq);
    } catch (e) {
      w.hubOk = false;
      w.lastError = (e as Error).message;
    }
  }

  /**
   * Make the sealed set exactly the set of existing files that anyone on the team
   * has locked. Runs on every hub change and every `verifyMs` in between, so a
   * file replaced, moved or deleted underneath a lock is noticed within a second.
   */
  private apply(w: Workspace, locks: Lock[], seq: number): void {
    // Level-triggered, but never backwards: a snapshot taken before one already applied is stale.
    if (seq < w.appliedSeq) return;
    w.appliedSeq = seq;
    w.locks = locks;
    const desired = new Set<string>();
    const missing = new Set<string>();
    for (const l of locks) {
      const abs = path.join(w.realRoot, l.path);
      if (!abs.startsWith(w.realRoot + path.sep)) continue;
      let st;
      try {
        st = lstatSync(abs);
      } catch {
        if (w.seenHash.has(l.path) || w.orphans.has(l.path)) missing.add(l.path);
        continue; // locked but not created yet
      }
      if (!st.isFile()) continue;
      // An agent's native edit is in flight: leave it open until the edit settles.
      if (this.windows.has(abs)) {
        desired.add(abs);
        w.sealed.delete(abs);
        continue;
      }
      // Never seal through a symlinked directory: as root that would freeze files outside the workspace.
      if (!this.contained(w, abs)) continue;
      desired.add(abs);
      // Replaced underneath us (the chmod tier cannot stop a rename): seal the new file. An
      // adopted seal with no recorded inode is trusted and recorded, never sealed twice: the
      // chmod tier would take the sealed mode for the original and never make it writable again.
      const ino = w.inodes.get(abs);
      if (w.sealed.has(abs) && ino === undefined) w.inodes.set(abs, st.ino);
      else if (w.sealed.has(abs) && ino !== st.ino) w.sealed.delete(abs);
    }
    const toSeal = [...desired].filter((p) => !w.sealed.has(p) && !this.windows.has(p));
    const toUnseal = [...w.sealed].filter((p) => !desired.has(p));
    if (toSeal.length)
      for (const p of this.sealer.seal(toSeal)) {
        w.sealed.add(p);
        this.remember(w, p);
      }
    if (toUnseal.length) {
      this.sealer.unseal(toUnseal.filter((p) => existsSync(p)));
      for (const p of toUnseal) {
        w.sealed.delete(p);
        w.inodes.delete(p);
      }
    }
    for (const rel of [...w.orphans]) if (!missing.has(rel)) w.orphans.delete(rel);
    if (missing.size) void this.chase(w, [...missing]);
    if (toSeal.length || toUnseal.length) {
      this.saveState();
      this.log(
        `${path.basename(w.realRoot)}: sealed ${toSeal.length}, unsealed ${toUnseal.length} (now ${w.sealed.size})`
      );
      void this.report(w);
    }
  }

  private contained(w: Workspace, abs: string): boolean {
    try {
      return realpathSync(abs) === abs;
    } catch {
      return false;
    }
  }

  /** Note a sealed file's inode and content, to tell a replacement or a move apart later. */
  private remember(w: Workspace, abs: string): void {
    try {
      w.inodes.set(abs, lstatSync(abs).ino);
      const rel = path.relative(w.realRoot, abs).split(path.sep).join("/");
      w.seenHash.set(rel, w.gateway.cache.put(readFileSync(abs, "utf8")));
    } catch {
      /* vanished */
    }
  }

  private chasing = new Set<string>();

  /**
   * Locked files that disappeared. A move (git mv, an editor rename, a checkout
   * that renamed it) carries its locks to the new path for the whole team; a
   * plain disappearance is announced once, so enforcement never lapses silently.
   */
  private async chase(w: Workspace, rels: string[]): Promise<void> {
    for (const rel of rels) {
      const key = `${w.realRoot}\0${rel}`;
      if (this.chasing.has(key) || w.orphans.has(rel)) continue;
      this.chasing.add(key);
      try {
        const cached = w.seenHash.get(rel);
        const symbols = w.locks.filter((l) => l.path === rel).map((l) => l.symbol);
        const to = findMove(
          w.realRoot,
          rel,
          cached ? w.gateway.cache.get(cached) : undefined,
          symbols
        );
        if (to) {
          const { moved } = await w.client.moveLocks(rel, to);
          w.seenHash.delete(rel);
          this.log(`${rel} moved to ${to}; ${moved.length} lock(s) followed`);
          continue;
        }
        await w.client.reportOrphaned(rel, "deleted or moved without a trace");
        w.orphans.add(rel);
        this.log(`${rel} is locked but gone; told the team`);
        void this.report(w);
      } catch (e) {
        this.log(`could not settle missing ${rel}: ${(e as Error).message}`);
      } finally {
        this.chasing.delete(key);
      }
    }
  }

  private async report(w: Workspace): Promise<void> {
    // One at a time, and always the state as it is when the request goes out: two reports in
    // flight can arrive out of order, and the last one wins on the hub.
    if (w.reporting) {
      w.reportAgain = true;
      return;
    }
    w.reporting = true;
    try {
      do {
        w.reportAgain = false;
        await w.client.reportDevice({
          deviceId: this.opts.deviceId,
          hostname: os.hostname(),
          platform: `${process.platform}-${process.arch}`,
          tier: this.sealer.tier,
          sealed: [...w.sealed].map((p) => path.relative(w.realRoot, p).split(path.sep).join("/")),
          health: { orphaned: [...w.orphans], version: this.opts.version },
        });
      } while (w.reportAgain);
    } catch {
      /* next tick */
    } finally {
      w.reporting = false;
    }
  }

  private async reportAll(): Promise<void> {
    await Promise.all([...this.workspaces.values()].map((w) => this.report(w)));
  }

  // ── socket API ──────────────────────────────────────────────────────────

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    try {
      const body =
        req.method === "POST"
          ? ((await req.json().catch(() => ({}))) as Record<string, unknown>)
          : {};
      switch (url.pathname) {
        case "/status":
          return ok(this.status(Array.isArray(body.tokens) ? body.tokens.map(String) : []));
        case "/register":
          return ok(await this.register(body));
        case "/unregister": {
          // Unregistering unseals the workspace, so it needs the same member token it was registered with.
          const w = this.findWorkspace("", String(body.root ?? ""));
          if (w && body.memberToken !== w.memberToken)
            throw new Error("memberToken does not match this workspace");
          if (w) this.removeWorkspace(w.realRoot);
          return ok({ ok: true });
        }
        case "/write":
          return ok(await this.write(body));
        case "/read": {
          const w = this.requireWorkspace(String(body.path ?? ""), body.root as string | undefined);
          // The root daemon can read anything; only hand content to an agent of this project.
          if (this.system) await this.agentFor(w, String(body.agentToken ?? ""));
          const r = w.gateway.read(String(body.path));
          return ok({ path: r.rel, content: r.content, hash: r.hash, exists: r.exists });
        }
        case "/seen": {
          // Hooks report the version an agent just read, so its later full-file write can be merged.
          const w = this.findWorkspace(String(body.path ?? ""), body.root as string | undefined);
          if (w && typeof body.content === "string" && this.member(w, body))
            return ok({ hash: w.gateway.cache.put(body.content) });
          return ok({ hash: null });
        }
        case "/window/open":
          return ok(await this.openWindow(body));
        case "/window/close":
          return ok(await this.closeWindow(body));
        case "/shutdown": {
          // User daemon only (its socket is 0600). The root daemon is stopped through launchd/systemd.
          if (this.system)
            throw new Error("the kernel enforcer is managed by the OS service manager");
          setTimeout(() => void this.stop().then(() => process.exit(0)), 10);
          return ok({ ok: true });
        }
        case "/reconcile": {
          const w = this.findWorkspace("", String(body.root ?? ""));
          if (!w) throw new Error(`No registered workspace at ${String(body.root ?? "")}.`);
          if (!this.member(w, body)) throw new Error("memberToken does not match this workspace");
          await this.reconcile(w);
          return ok({ sealed: w.sealed.size });
        }
      }
      return err(404, `no route ${url.pathname}`);
    } catch (e) {
      return err(400, (e as Error).message);
    }
  }

  /**
   * The root daemon's socket is reachable by every local user, so workspace
   * details (paths, sealed files) go only to callers holding that workspace's
   * member token. The user daemon's socket is private to its owner.
   */
  status(tokens: string[] = []) {
    return {
      tier: this.sealer.tier,
      mechanism: this.sealer.mechanism,
      system: this.system,
      pid: process.pid,
      deviceId: this.opts.deviceId,
      workspaces: [...this.workspaces.values()]
        .filter((w) => !this.system || tokens.includes(w.memberToken))
        .map((w) => ({
          root: w.realRoot,
          hub: w.hub,
          project: w.project,
          sealed: [...w.sealed].map((p) => path.relative(w.realRoot, p)),
          orphaned: [...w.orphans],
          hubOk: w.hubOk,
          lastError: w.lastError,
        })),
    };
  }

  private member(w: Workspace, body: Record<string, unknown>): boolean {
    return typeof body.memberToken === "string" && body.memberToken === w.memberToken;
  }

  /**
   * Registration. The user daemon's socket is 0600, so only its owner can reach it.
   * The root daemon's socket is world-reachable, so a caller must prove it can write
   * inside the workspace (by creating a challenge file there) before root will seal
   * or write anything in it, and it only ever writes back as that file's owner.
   */
  private async register(body: Record<string, unknown>) {
    const root = String(body.root ?? "");
    if (!root || !existsSync(root) || !statSync(root).isDirectory())
      throw new Error("root must be an existing directory");
    const reg: WorkspaceReg = {
      root,
      hub: String(body.hub ?? ""),
      project: String(body.project ?? ""),
      memberToken: String(body.memberToken ?? ""),
    };
    if (!reg.hub || !reg.project || !reg.memberToken)
      throw new Error("hub, project and memberToken are required");

    if (this.system) {
      const nonce = body.challenge ? String(body.challenge) : "";
      const pending = nonce ? this.challenges.get(nonce) : undefined;
      if (!pending || pending.root !== realpathSync(root) || pending.expires < Date.now()) {
        const fresh = randomBytes(16).toString("hex");
        this.challenges.set(fresh, { root: realpathSync(root), expires: Date.now() + 60_000 });
        return {
          challenge: fresh,
          file: path.join(realpathSync(root), ".axis", `challenge-${fresh}`),
        };
      }
      const file = path.join(pending.root, ".axis", `challenge-${nonce}`);
      const st = existsSync(file) ? statSync(file) : null;
      const rootSt = statSync(pending.root);
      if (!st || st.uid === 0 || st.uid !== rootSt.uid)
        throw new Error("challenge file missing or not owned by the workspace owner");
      this.challenges.delete(nonce);
      rmSync(file, { force: true });
      reg.uid = st.uid;
      reg.gid = st.gid;
    }
    const w = await this.addWorkspace(reg);
    await this.reconcile(w);
    return {
      ok: true,
      root: w.realRoot,
      tier: this.sealer.tier,
      mechanism: this.sealer.mechanism,
      sealed: w.sealed.size,
    };
  }

  // ── edit windows (native edit tools of Codex, Cursor, Gemini) ─────────────

  private windows = new Map<string, EditWindow>();
  private agentIds = new Map<string, string>();

  /**
   * An agent's own edit tool is about to change these files (its pre-tool hook).
   * If a teammate holds one of them whole, refuse up front. Otherwise remember
   * each file as it is now and lift its seal until the post-tool hook settles it.
   */
  private async openWindow(body: Record<string, unknown>) {
    const agentToken = String(body.agentToken ?? "");
    const paths = Array.isArray(body.paths) ? body.paths.map(String) : [];
    if (!paths.length) throw new Error("paths are required");
    const w = this.requireWorkspace(paths[0]!, body.root as string | undefined);
    const agent = await this.agentFor(w, agentToken);
    const me = await this.agentId(agent, agentToken);
    const locks = await agent.locks();
    const opened: { abs: string; rel: string }[] = [];
    const refused: string[] = [];
    for (const p of paths) {
      const { rel, abs } = w.gateway.resolve(p);
      const whole = locks.find((l) => l.path === rel && l.symbol === "" && l.agent.id !== me);
      const busy = this.windows.get(abs);
      if (whole)
        refused.push(
          `${rel} is locked whole by ${whole.agent.name}: "${whole.intent}". axis_wait(["${rel}"]) takes it when they finish.`
        );
      else if (busy && busy.agentToken !== agentToken)
        refused.push(
          `${rel} is being edited by another agent on this machine right now; retry in a moment.`
        );
      else opened.push({ abs, rel });
    }
    if (refused.length) return { status: "denied", message: refused.join("\n") };
    for (const { abs, rel } of opened) {
      const prior = this.windows.get(abs);
      if (prior) clearTimeout(prior.timer);
      const base =
        prior?.base !== undefined ? prior.base : existsSync(abs) ? readFileSync(abs, "utf8") : null;
      if (w.sealed.has(abs)) this.sealer.unseal([abs]);
      this.windows.set(abs, {
        agentToken,
        rel,
        root: w.realRoot,
        base,
        // A tool that never reports back must not leave the file open.
        timer: setTimeout(() => void this.settle(w, agent, [abs]), this.opts.windowMs ?? 120_000),
      });
    }
    return { status: "open", paths: opened.map((o) => o.rel) };
  }

  /** The agent's edit tool finished (its post-tool hook): settle every file it had open, together. */
  private async closeWindow(body: Record<string, unknown>) {
    const agentToken = String(body.agentToken ?? "");
    const paths = Array.isArray(body.paths) ? body.paths.map(String) : [];
    const byRoot = new Map<string, string[]>();
    for (const [abs, win] of this.windows) {
      if (win.agentToken !== agentToken) continue;
      const w = this.workspaces.get(win.root);
      if (!w) continue;
      if (paths.length && !paths.some((p) => w.gateway.resolve(p).abs === abs)) continue;
      byRoot.set(win.root, [...(byRoot.get(win.root) ?? []), abs]);
    }
    const results: Settled[] = [];
    for (const [root, abses] of byRoot) {
      const w = this.workspaces.get(root)!;
      results.push(...(await this.settle(w, await this.agentFor(w, agentToken), abses)));
    }
    return { results };
  }

  /**
   * Put the files back as they were, then commit the agent's versions through the
   * gateway as one batch: it locks what the edit touched, in every file at once,
   * and merges like any Axis write. If a teammate holds part of it, the batch is
   * committed again without those parts (their functions stay as they were), and
   * the agent's full attempt is saved so no work is lost.
   */
  private async settle(w: Workspace, agent: HubClient, abses: string[]): Promise<Settled[]> {
    const out: Settled[] = [];
    const edits: { abs: string; rel: string; base: string | null; now: string }[] = [];
    try {
      for (const abs of abses) {
        const win = this.windows.get(abs);
        if (!win) continue;
        clearTimeout(win.timer);
        this.windows.delete(abs);
        const now = existsSync(abs) ? readFileSync(abs, "utf8") : null;
        if (now === win.base) out.push({ path: win.rel, status: "unchanged" });
        else if (now === null)
          out.push(await this.settleRemoval(w, agent, win.rel, abs, win.base!));
        else edits.push({ abs, rel: win.rel, base: win.base, now });
      }
      if (!edits.length) return out;
      for (const e of edits) w.gateway.restore(e.abs, e.base);
      const request = (e: (typeof edits)[0], content: string): WriteRequest => ({
        op: "write",
        path: e.rel,
        content,
        baseHash: w.gateway.cache.put(e.base ?? ""),
      });
      const first = await w.gateway.applyMany(
        agent,
        edits.map((e) => request(e, e.now))
      );
      if (first.every((r) => r.status === "applied"))
        return [
          ...out,
          ...first.map((r, i) => ({ path: edits[i]!.rel, status: "applied" as const, result: r })),
        ];
      const saved = edits.map((e) => w.gateway.saveAside(e.rel, e.now));
      const denied = first.find((r) => r.status === "denied");
      if (denied?.status !== "denied")
        return [
          ...out,
          ...first.map((r, i) => ({
            path: edits[i]!.rel,
            status: "reverted" as const,
            result: r,
            saved: saved[i],
          })),
        ];
      // Keep everything a teammate does not hold; a file held whole goes back entirely.
      const conflicts = denied.acquire.conflicts.map((c) => c.target);
      const kept: (string | null)[] = [];
      for (const e of edits) {
        const mine = conflicts.filter((c) => c === e.rel || c.startsWith(`${e.rel}#`));
        kept.push(mine.length ? await keepAllowed(e.rel, e.base ?? "", e.now, mine) : e.now);
      }
      const retry = edits
        .map((e, i) => ({ e, i, text: kept[i] }))
        .filter(
          (x): x is { e: (typeof edits)[0]; i: number; text: string } =>
            x.text !== null && x.text !== (x.e.base ?? "")
        );
      const second = retry.length
        ? await w.gateway.applyMany(
            agent,
            retry.map((x) => request(x.e, x.text))
          )
        : [];
      const landed = second.length > 0 && second.every((r) => r.status === "applied");
      for (const [i, e] of edits.entries()) {
        const j = retry.findIndex((x) => x.i === i);
        const partOf = conflicts.some((c) => c === e.rel || c.startsWith(`${e.rel}#`));
        if (landed && j >= 0)
          out.push(
            partOf
              ? { path: e.rel, status: "partial", result: second[j], denied, saved: saved[i] }
              : { path: e.rel, status: "applied", result: second[j] }
          );
        else {
          if (landed) w.gateway.restore(e.abs, e.base);
          out.push({ path: e.rel, status: "reverted", result: denied, saved: saved[i] });
        }
      }
      return out;
    } finally {
      this.apply(w, w.locks, w.appliedSeq);
    }
  }

  /** The edit deleted or moved the file: allowed only to an agent that can hold the whole file. */
  private async settleRemoval(
    w: Workspace,
    agent: HubClient,
    rel: string,
    abs: string,
    base: string
  ): Promise<Settled> {
    const res = await agent.acquire([rel], "removing or moving this file");
    if (res.status === "granted") {
      const to = findMove(
        w.realRoot,
        rel,
        base,
        w.locks.filter((l) => l.path === rel).map((l) => l.symbol)
      );
      if (to) await agent.moveLocks(rel, to);
      else await agent.release([rel]);
      return { path: rel, status: to ? "moved" : "removed", to: to ?? undefined };
    }
    w.gateway.restore(abs, base);
    return {
      path: rel,
      status: "reverted",
      result: res.status === "denied" ? { status: "denied", path: rel, acquire: res } : undefined,
    };
  }

  private async agentId(agent: HubClient, token: string): Promise<string> {
    let id = this.agentIds.get(token);
    if (!id) {
      id = (await agent.me()).principal.agent?.id ?? "";
      this.agentIds.set(token, id);
    }
    return id;
  }

  /** One write (`request`) or an all-or-nothing batch across files (`requests`). */
  private async write(body: Record<string, unknown>): Promise<WriteResult | WriteResult[]> {
    const agentToken = String(body.agentToken ?? "");
    const batch = Array.isArray(body.requests);
    const requests = (batch ? body.requests : [body.request]) as (WriteRequest | undefined)[];
    if (!agentToken || !requests.length || requests.some((r) => !r?.path))
      throw new Error("agentToken and a path for every request are required");
    const w = this.requireWorkspace(requests[0]!.path, body.root as string | undefined);
    const agent = await this.agentFor(w, agentToken);
    const rels = requests.map((r) =>
      r!.path.startsWith("/") ? path.relative(w.realRoot, r!.path) : r!.path
    );
    // Another agent's native edit of one of these files is in flight: let it settle first.
    for (const rel of rels) {
      let abs = "";
      try {
        abs = w.gateway.resolve(rel).abs;
      } catch {
        /* the gateway reports a bad path itself */
      }
      for (let i = 0; abs && i < 150; i++) {
        const win = this.windows.get(abs);
        if (!win || win.agentToken === agentToken) break;
        await Bun.sleep(100);
      }
    }
    const results = await w.gateway.applyMany(
      agent,
      requests.map((r, i) => ({ ...r!, path: rels[i]! }) as WriteRequest)
    );
    return batch ? results : results[0]!;
  }

  /** A hub client for an agent token, proven to belong to this workspace's project. */
  private async agentFor(w: Workspace, agentToken: string): Promise<HubClient> {
    if (!agentToken) throw new Error("an agent session token is required");
    const agent = new HubClient(w.hub, agentToken);
    let project = this.agentProjects.get(agentToken);
    if (!project) {
      const me = await agent.me();
      if (me.principal.kind !== "agent") throw new Error("writes need an agent session token");
      project = me.principal.projectId;
      this.agentProjects.set(agentToken, project);
    }
    if (project !== w.project) throw new Error("that agent belongs to a different project");
    return agent;
  }

  private findWorkspace(p: string, root?: string): Workspace | undefined {
    if (root) {
      try {
        return this.workspaces.get(realpathSync(root));
      } catch {
        return undefined;
      }
    }
    if (!path.isAbsolute(p))
      return this.workspaces.size === 1 ? [...this.workspaces.values()][0] : undefined;
    let best: Workspace | undefined;
    for (const w of this.workspaces.values()) {
      const r = w.realRoot;
      let target = p;
      try {
        target = realpathSync(path.dirname(p)) + path.sep + path.basename(p);
      } catch {
        /* parent may not exist yet */
      }
      if (
        (target.startsWith(r + path.sep) || target.startsWith(w.root + path.sep)) &&
        (!best || r.length > best.realRoot.length)
      )
        best = w;
    }
    return best;
  }

  private requireWorkspace(p: string, root?: string): Workspace {
    const w = this.findWorkspace(p, root);
    if (!w)
      throw new Error(`No registered workspace contains ${p}. Run \`axis init\` in the repo.`);
    return w;
  }

  // ── persistence ─────────────────────────────────────────────────────────

  private loadState(): WorkspaceReg[] {
    try {
      return JSON.parse(readFileSync(this.opts.stateFile, "utf8")).workspaces ?? [];
    } catch {
      return [];
    }
  }

  private saveState(): void {
    mkdirSync(path.dirname(this.opts.stateFile), { recursive: true, mode: 0o700 });
    const workspaces: WorkspaceReg[] = [...this.workspaces.values()].map(
      ({ root, hub, project, memberToken, uid, gid, sealed, inodes }) => ({
        root,
        hub,
        project,
        memberToken,
        uid,
        gid,
        sealedFiles: [...sealed],
        sealedInodes: Object.fromEntries(
          [...sealed].flatMap((p) => {
            const ino = inodes.get(p);
            return ino === undefined ? [] : [[p, ino]];
          })
        ),
      })
    );
    writeFileSync(this.opts.stateFile, JSON.stringify({ workspaces }, null, 2), { mode: 0o600 });
  }
}

interface EditWindow {
  agentToken: string;
  rel: string;
  root: string;
  /** The file before the edit; null if it did not exist. */
  base: string | null;
  timer: ReturnType<typeof setTimeout>;
}

export interface Settled {
  path: string;
  status: "unchanged" | "applied" | "partial" | "reverted" | "removed" | "moved";
  result?: WriteResult;
  /** For a partial settle: the denial for the parts that were put back. */
  denied?: WriteResult;
  /** Where the agent's full attempt was saved when any of it was put back. */
  saved?: string;
  to?: string;
}

/**
 * The agent's version with every unit a teammate holds put back as it was in
 * `base`. Null when a teammate holds the whole file (nothing can be kept).
 */
async function keepAllowed(
  rel: string,
  base: string,
  mine: string,
  conflicts: string[]
): Promise<string | null> {
  const symbols = conflicts.map((c) => parseTarget(c).symbol);
  if (symbols.some((s) => s === "")) return null;
  const before = await parseSymbols(rel, base);
  const lines = splitLines(base);
  let text = mine;
  for (const name of symbols) {
    const hit = findSymbol(before.symbols, name);
    if (!hit) return null;
    text = await spliceSymbol(rel, text, name, lines.slice(hit.start, hit.end + 1).join(""));
  }
  return text;
}

function ok(data: unknown): Response {
  return Response.json(data);
}

function err(status: number, error: string): Response {
  return Response.json({ error }, { status });
}
