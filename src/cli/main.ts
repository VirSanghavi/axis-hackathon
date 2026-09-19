#!/usr/bin/env bun
import pkg from "../../package.json" with { type: "json" };
import { existsSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  HOSTED_HUB,
  axisHome,
  deviceId,
  findWorkspaceRoot,
  memberName,
  readProjectConfig,
  saveCredential,
  userSocket,
  writeProjectConfig,
} from "../client/config.ts";
import { HubClient } from "../client/hub-client.ts";
import { accessToken, currentSession, signIn, signOut, type SignIn } from "../client/login.ts";
import { ensureSession, hostPid } from "../client/session.ts";
import { loadWorkspace, type Workspace } from "../client/workspace.ts";
import { DaemonClient } from "../daemon/client.ts";
import { ago, renderAcquire, renderJob, renderLocks, renderStats } from "../protocol/render.ts";
import { parseSymbols } from "../symbols/parser.ts";
import { wireHosts } from "./agents.ts";

const VERSION = pkg.version;

// ── tiny arg parser ──────────────────────────────────────────────────────────
function parse(argv: string[]) {
  const pos: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2);
      if (v !== undefined) flags[k!] = v;
      else if (argv[i + 1] && !argv[i + 1]!.startsWith("-")) flags[k!] = argv[++i]!;
      else flags[k!] = true;
    } else if (a === "-m" && argv[i + 1]) flags.m = argv[++i]!;
    else pos.push(a);
  }
  return { pos, flags };
}

// ── output ───────────────────────────────────────────────────────────────────
const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: number) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = c(1);
const dim = c(2);
const green = c(32);
const yellow = c(33);
const red = c(31);
const cyan = c(36);

function die(msg: string): never {
  console.error(red("✗ ") + msg);
  process.exit(1);
}

function need(): Workspace {
  const w = loadWorkspace();
  if (!w.ok) die(w.reason);
  return w.ws;
}

async function asAgent(ws: Workspace) {
  // CLI locks belong to your terminal session: they survive between commands and end with the shell.
  const s = await ensureSession(ws.hub, ws.config.project, hostPid(), {
    vendor: "cli",
    name: `${ws.credential.member}/cli`,
  });
  return { session: s, hub: ws.hub.withToken(s.token) };
}

async function protect(ws: Workspace) {
  const d = await DaemonClient.ensure();
  const r = await d.register({
    root: ws.root,
    hub: ws.config.hub,
    project: ws.config.project,
    memberToken: ws.credential.memberToken,
  });
  return r;
}

function tierLine(tier: string, mechanism: string): string {
  if (tier === "kernel")
    return green(`kernel (${mechanism})`) + dim(" · nothing without root can write a locked file");
  if (tier === "guard")
    return (
      yellow(`guard (${mechanism})`) + dim(" · run `axis enforcer install` for the kernel tier")
    );
  return red("off") + dim(" · this platform cannot seal files; locks are advisory here");
}

// ── commands ─────────────────────────────────────────────────────────────────
const HELP = `${bold("axis")} ${dim(VERSION)}: kernel-enforced, function-level locks for every coding agent on your team

${bold("Set up")}
  axis init [--hub URL] [--name NAME]   create a project for this repo (or finish joining one) and wire your agents
  axis join <invite> [--hub URL]        join a teammate's project on this machine
  axis login | axis logout              sign in to the hub (init and join do this for you)
  axis invite                           print the one-liner a teammate runs to join
  axis enforcer install                 kernel tier: seal with flags only root can clear (asks for your password once)

${bold("Work")}
  axis status                           who is online, what is locked, what is sealed on this machine
  axis lock <file[#Symbol]>... -m WHY   lock files or functions from your terminal
  axis unlock [target...]               release (all of yours if no targets)
  axis symbols <file>                   lockable functions in a file and who holds them
  axis jobs | axis post "title"         the job board
  axis open                             open the live dashboard

${bold("Run")}
  axis hub [--port 4455] [--db FILE] [--host 0.0.0.0]   self-host the coordination hub
  axis daemon                           run the enforcement daemon in the foreground
  axis mcp                              MCP server (your agent host starts this)
  axis doctor [--team]                  check everything end to end (--team: every device on the team)
  axis stats [--hours 24]               contention: what agents fight over, who waits on whom
  axis sync                             re-check locks against the working tree (git hooks run this)
  axis hook claude|codex|cursor|gemini  edit hook (your agent host runs this)
  axis stop                             stop the user daemon and unseal files
`;

function openUrl(url: string) {
  Bun.spawn([process.platform === "darwin" ? "open" : "xdg-open", url], {
    stdio: ["ignore", "ignore", "ignore"],
  });
}

async function browserSignIn(hub: string, cfg: SignIn) {
  console.log(
    `Signing in to ${dim(hub)} with ${cfg.provider[0]!.toUpperCase() + cfg.provider.slice(1)}. Opening your browser...`
  );
  const s = await signIn(cfg, (url) => {
    console.log(dim(`  If nothing opens, visit:\n  ${url}`));
    if (!process.env.AXIS_NO_BROWSER) openUrl(url);
  });
  console.log(`${green("✓")} Signed in as ${bold(s.email)}`);
  return s.accessToken;
}

/** The sign-in token this hub needs to create or join a project, signing in if needed. */
async function userToken(hub: string): Promise<string | undefined> {
  const cfg = await HubClient.authConfig(hub).catch((e: Error) => die(e.message));
  if (!cfg.required) return undefined;
  return (
    (await accessToken(cfg)) ?? (await browserSignIn(hub, cfg).catch((e: Error) => die(e.message)))
  );
}

async function cmdLogin(flags: Record<string, string | boolean>, out: boolean) {
  const root = findWorkspaceRoot();
  const hub = String(
    flags.hub ?? (root && readProjectConfig(root)?.hub) ?? process.env.AXIS_HUB ?? HOSTED_HUB
  );
  const cfg = await HubClient.authConfig(hub).catch((e: Error) => die(e.message));
  if (!cfg.required) return console.log(`${dim(hub)} does not need sign-in.`);
  if (out)
    return console.log(signOut(cfg) ? `${green("✓")} Signed out of ${dim(hub)}` : "Not signed in.");
  const s = currentSession(cfg);
  if (s && !flags.force && (await accessToken(cfg)))
    return console.log(
      `${green("✓")} Signed in as ${bold(s.email)} ${dim("(axis logout to switch)")}`
    );
  await browserSignIn(hub, cfg).catch((e: Error) => die(e.message));
}

async function cmdInit(flags: Record<string, string | boolean>) {
  const root = findWorkspaceRoot() ?? die("Run `axis init` inside a git repository.");
  let cfg = readProjectConfig(root);
  if (!cfg) {
    const hub = String(flags.hub ?? process.env.AXIS_HUB ?? HOSTED_HUB);
    const name = String(flags.name ?? path.basename(root));
    const created = await HubClient.createProject(
      hub,
      { name, member: memberName() },
      { adminSecret: process.env.AXIS_HUB_SECRET, userToken: await userToken(hub) }
    ).catch((e: Error) => die(e.message));
    cfg = { hub, project: created.project.id, name };
    writeProjectConfig(root, cfg);
    saveCredential({
      hub,
      project: cfg.project,
      projectName: name,
      member: created.member,
      memberToken: created.memberToken,
    });
    console.log(`${green("✓")} Created project ${bold(name)} as ${created.member}`);
    console.log(`  ${dim("Commit .axis/axis.json so teammates' clones find the same board.")}`);
  }
  const lookup = loadWorkspace(root);
  if (!lookup.ok)
    die(
      `${lookup.reason}\n  This repo already uses Axis; ask a teammate for an invite (\`axis invite\`).`
    );
  const ws = lookup.ws;
  const shown = (f: string) =>
    f.startsWith(root + path.sep) ? path.relative(root, f) : f.replace(os.homedir(), "~");
  for (const w of wireHosts(root)) {
    if (w.conflict)
      console.log(
        `${yellow("!")} ${w.host.padEnd(18)} ${dim(shown(w.file))} ${yellow(w.conflict)}`
      );
    else
      console.log(
        `${green("✓")} ${w.host.padEnd(18)} ${dim(shown(w.file))}${w.changed ? "" : dim(" (already set)")}${w.note ? `\n  ${yellow("→")} ${w.note}` : ""}`
      );
  }
  const r = await protect(ws).catch((e: Error) =>
    die(`Could not start the enforcement daemon: ${e.message}`)
  );
  console.log(`${green("✓")} enforcement        ${tierLine(r.tier, r.mechanism)}`);
  const { invite } = await ws.hub.invite();
  console.log(
    `\n${bold("Teammates join with:")}\n  ${cyan(`axis join ${invite}`)}  ${dim("(in their clone of this repo)")}`
  );
  console.log(`${bold("Dashboard:")} ${cyan("axis open")}`);
}

async function cmdJoin(pos: string[], flags: Record<string, string | boolean>) {
  const raw = pos[0] ?? die("Usage: axis join <invite>");
  // Accept either the bare code or a pasted "axis join <code>" / URL with the code at the end.
  const invite = raw.split(/[\s/]/).pop()!.trim();
  const root = findWorkspaceRoot();
  const existing = root ? readProjectConfig(root) : null;
  const hub = String(flags.hub ?? existing?.hub ?? process.env.AXIS_HUB ?? HOSTED_HUB);
  const joined = await HubClient.join(hub, invite, memberName(), await userToken(hub)).catch(
    (e: Error) => die(e.message)
  );
  saveCredential({
    hub,
    project: joined.projectId,
    projectName: joined.projectName,
    member: joined.member,
    memberToken: joined.memberToken,
  });
  console.log(`${green("✓")} Joined ${bold(joined.projectName)} as ${joined.member}`);
  if (root && !existing)
    writeProjectConfig(root, { hub, project: joined.projectId, name: joined.projectName });
  if (root) await cmdInit({});
}

async function cmdStatus() {
  const ws = need();
  const d = await DaemonClient.find();
  const snap = await ws.hub.snapshot(12).catch((e: Error) => die(e.message));
  const now = snap.serverTime;
  console.log(`${bold(snap.project.name)} ${dim(`· ${ws.config.hub}`)}`);
  if (d) {
    const st = await d.status();
    const mine = st.workspaces.find(
      (w) => w.root === ws.root || ws.root.endsWith(w.root) || w.root.endsWith(ws.root)
    );
    console.log(`enforcement  ${tierLine(st.tier, st.mechanism)}`);
    console.log(
      `sealed here  ${mine?.sealed.length ? mine.sealed.join(", ") : dim("nothing")}${mine && !mine.hubOk ? red(`  (hub unreachable: ${mine.lastError}; keeping seals)`) : ""}`
    );
  } else console.log(`enforcement  ${red("daemon not running")} ${dim("· `axis init` starts it")}`);
  const agents = snap.agents.filter((a) => a.status !== "offline");
  console.log(`\n${bold("Agents")} ${dim(`(${agents.length})`)}`);
  for (const a of agents)
    console.log(
      `  ${a.status === "active" ? green("●") : yellow("○")} ${a.name} ${dim(`@${a.device} · ${ago(now - a.lastSeenAt)}`)}${a.task ? `  ${a.task}` : ""}`
    );
  const devices = snap.devices.filter((x) => x.online);
  if (devices.length) {
    console.log(`\n${bold("Devices")}`);
    for (const x of devices)
      console.log(
        `  ${x.hostname.padEnd(24)} ${x.tier.padEnd(7)} ${dim(`${x.sealed.length} sealed · ${x.member}`)}`
      );
  }
  console.log(`\n${bold("Locks")}`);
  console.log(
    snap.locks.length
      ? renderLocks(snap.locks)
          .split("\n")
          .map((l) => "  " + l.trim())
          .join("\n")
      : dim("  none")
  );
  const open = snap.jobs.filter((j) => j.status === "todo" || j.status === "in_progress");
  console.log(`\n${bold("Jobs")}`);
  console.log(open.length ? open.map((j) => "  " + renderJob(j)).join("\n") : dim("  none open"));
}

async function cmdSymbols(pos: string[]) {
  const ws = need();
  const file = pos[0] ?? die("Usage: axis symbols <file>");
  const abs = path.resolve(file);
  if (!existsSync(abs)) die(`${file} does not exist`);
  const rel = path.relative(ws.root, abs);
  const parsed = await parseSymbols(rel, await Bun.file(abs).text());
  const locks = (await ws.hub.locks()).filter((l) => l.path === rel);
  if (!parsed.language) return console.log(`${rel}: no grammar; locks are whole-file.`);
  for (const s of parsed.symbols) {
    const h = locks.find(
      (l) => l.symbol === s.name || l.symbol === "" || s.name.startsWith(l.symbol + ".")
    );
    console.log(
      `${"  ".repeat(s.depth)}${s.name} ${dim(`${s.kind} L${s.start + 1}-${s.end + 1}`)}${h ? yellow(`  ← ${h.agent.name}: ${h.intent}`) : ""}`
    );
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, flags } = parse(rest);

  switch (cmd) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      return console.log(HELP);
    case "--version":
    case "version":
      return console.log(VERSION);

    case "init":
      return cmdInit(flags);
    case "join":
      return cmdJoin(pos, flags);
    case "login":
      return cmdLogin(flags, false);
    case "logout":
      return cmdLogin(flags, true);
    case "invite": {
      const ws = need();
      const { invite } = await ws.hub.invite();
      return console.log(`axis join ${invite}`);
    }
    case "status":
      return cmdStatus();

    case "lock": {
      const ws = need();
      if (!pos.length) die("Usage: axis lock <file[#Symbol]>... -m WHY");
      const { hub } = await asAgent(ws);
      const targets = pos.map((t) => {
        const [p, sym] = t.split("#");
        const rel = path.relative(ws.root, path.resolve(p!));
        return sym ? `${rel}#${sym}` : rel;
      });
      const r = await hub.acquire(
        targets,
        String(flags.m ?? flags.why ?? "locked from the terminal")
      );
      await protect(ws).then((_) =>
        DaemonClient.find().then((d) => d?.reconcile(ws.root, ws.credential.memberToken))
      );
      console.log(renderAcquire(r));
      return process.exit(r.status === "granted" ? 0 : 2);
    }
    case "unlock": {
      const ws = need();
      const { hub } = await asAgent(ws);
      const targets = pos.length
        ? pos.map((t) => {
            const [p, sym] = t.split("#");
            const rel = path.relative(ws.root, path.resolve(p!));
            return sym ? `${rel}#${sym}` : rel;
          })
        : "all";
      const r = await hub.release(targets);
      await DaemonClient.find().then((d) => d?.reconcile(ws.root, ws.credential.memberToken));
      return console.log(
        r.released.length ? `${green("✓")} released ${r.released.join(", ")}` : "nothing to release"
      );
    }
    case "locks": {
      const ws = need();
      return console.log(renderLocks(await ws.hub.locks()));
    }
    case "symbols":
      return cmdSymbols(pos);
    case "jobs": {
      const ws = need();
      const jobs = await ws.hub.jobs(!!flags.all);
      return console.log(jobs.length ? jobs.map(renderJob).join("\n") : "no jobs");
    }
    case "post": {
      const ws = need();
      const { hub } = await asAgent(ws);
      const j = await hub.postJob({
        title: pos.join(" ") || die('Usage: axis post "title"'),
        description: String(flags.detail ?? ""),
        priority: (flags.priority as never) ?? "medium",
      });
      return console.log(`${green("✓")} ${renderJob(j)}`);
    }
    case "note": {
      const ws = need();
      const { hub } = await asAgent(ws);
      await hub.note(pos.join(" "));
      return console.log(`${green("✓")} noted`);
    }
    case "open":
    case "dashboard": {
      const ws = need();
      const dash = String(
        flags.url ??
          process.env.AXIS_DASHBOARD ??
          (ws.config.hub.startsWith("http://127.0.0.1") ||
          ws.config.hub.startsWith("http://localhost")
            ? ws.config.hub
            : "https://axis-hackathon.vercel.app")
      );
      const url = `${dash}/#hub=${encodeURIComponent(ws.config.hub)}&token=${encodeURIComponent(ws.credential.memberToken)}`;
      console.log(url);
      if (!flags["no-open"]) openUrl(url);
      return;
    }

    case "hub": {
      const { SqliteStore } = await import("../hub/sqlite-store.ts");
      const { Hub } = await import("../hub/hub.ts");
      const { serveHub } = await import("../hub/server.ts");
      const { supabaseAuth } = await import("../hub/identity.ts");
      const db = String(flags.db ?? path.join(axisHome(), "hub.db"));
      const hub = new Hub(new SqliteStore(db), {
        leaseMs: flags.lease ? Number(flags.lease) * 1000 : undefined,
      });
      const { dashboardFromDir } = await import("../hub/server.ts");
      // The compiled binary carries the dashboard (scripts/build.ts); from source it is read from dashboard/dist.
      const embedded = (globalThis as { __AXIS_DASHBOARD__?: Map<string, string> })
        .__AXIS_DASHBOARD__;
      const dir = flags.dashboard ?? process.env.AXIS_DASHBOARD_DIR;
      const dashboard = dir
        ? dashboardFromDir(String(dir))
        : (embedded ?? dashboardFromDir(path.resolve(import.meta.dir, "../../dashboard/dist")));
      const server = serveHub({
        hub,
        port: Number(flags.port ?? process.env.PORT ?? 4455),
        hostname: String(flags.host ?? "127.0.0.1"),
        adminSecret: process.env.AXIS_HUB_SECRET,
        auth: supabaseAuth(
          process.env.AXIS_AUTH_URL,
          process.env.AXIS_AUTH_KEY,
          process.env.AXIS_AUTH_PROVIDER,
          process.env.AXIS_ALLOWED_EMAILS
        ),
        dashboard,
      });
      console.error(
        `${green("●")} axis hub on ${bold(`http://${server.hostname}:${server.port}`)} ${dim(`· db ${db}`)}`
      );
      const stop = () => {
        hub.close();
        server.stop(true);
        process.exit(0);
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      return;
    }

    case "daemon": {
      const { Daemon } = await import("../daemon/daemon.ts");
      const system = !!flags.system;
      if (system && process.getuid?.() !== 0)
        die("--system must run as root (use `axis enforcer install`).");
      const home = system ? "/var/lib/axis" : axisHome();
      const d = new Daemon({
        socket: system ? "/var/run/axis/axisd.sock" : userSocket(),
        stateFile: path.join(home, "daemon.json"),
        deviceId: system
          ? `d_${os
              .hostname()
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, "-")}-root`
          : deviceId(),
        prefer: flags.tier as never,
        version: VERSION,
      });
      await d.start();
      const stop = () => void d.stop().then(() => process.exit(0));
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      return;
    }
    case "stop": {
      const d = await DaemonClient.find();
      if (!d || d.socket !== userSocket())
        return console.log(
          d
            ? "The kernel enforcer is managed by the OS (axis enforcer uninstall)."
            : "daemon not running"
        );
      await fetch("http://axisd/shutdown", { method: "POST", unix: d.socket } as RequestInit);
      return console.log(`${green("✓")} daemon stopped; files unsealed`);
    }

    case "mcp": {
      const { runMcpServer } = await import("../mcp/server.ts");
      return runMcpServer();
    }
    case "hook": {
      if (pos[0] === "claude") {
        const { runClaudeHook } = await import("../hooks/claude.ts");
        await runClaudeHook();
      } else if (pos[0] === "codex" || pos[0] === "cursor" || pos[0] === "gemini") {
        const { runNativeHook } = await import("../hooks/native.ts");
        await runNativeHook(pos[0]);
      } else die("Usage: axis hook claude|codex|cursor|gemini");
      return process.exit(0);
    }
    case "enforcer": {
      const { installEnforcer, uninstallEnforcer } = await import("./enforcer.ts");
      if (pos[0] === "install") return installEnforcer();
      if (pos[0] === "uninstall") return uninstallEnforcer();
      const d = await DaemonClient.find();
      if (!d) return console.log("no daemon running");
      const st = await d.status();
      return console.log(
        `${tierLine(st.tier, st.mechanism)}${st.system ? dim(" · root daemon") : dim(" · user daemon")}`
      );
    }
    case "doctor": {
      const { runDoctor, runTeamDoctor } = await import("./doctor.ts");
      return flags.team ? runTeamDoctor() : runDoctor(VERSION);
    }
    case "stats": {
      const ws = need();
      const hours = Number(flags.hours ?? 24);
      return console.log(renderStats(await ws.hub.analytics(hours), hours));
    }
    case "sync": {
      // Run by the git hooks `axis init` installs, after checkout, merge and rebase.
      const ws = need();
      const d = await DaemonClient.find();
      if (d) await d.reconcile(ws.root, ws.credential.memberToken).catch(() => {});
      const [locks, st] = await Promise.all([
        ws.hub.locks().catch(() => []),
        d?.status().catch(() => null),
      ]);
      const mine = st?.workspaces.find((x) => x.root === realpathSync(ws.root));
      const here = locks.filter((l) => existsSync(path.join(ws.root, l.path)));
      if (mine?.orphaned.length)
        console.log(
          `${yellow("axis:")} locked but missing here, team told: ${mine.orphaned.join(", ")}`
        );
      if (here.length && !flags.quiet) {
        const files = [...new Set(here.map((l) => l.path))];
        console.log(
          `${yellow("axis:")} ${files.length} locked file${files.length === 1 ? "" : "s"} here stay as they were until released: ${files.slice(0, 5).join(", ")}${files.length > 5 ? ", ..." : ""} ${dim("(axis status)")}`
        );
      }
      return;
    }
  }
  die(`Unknown command '${cmd}'. Run \`axis help\`.`);
}

main().catch((e) => die((e as Error).message));
