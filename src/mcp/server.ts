import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { HubClient } from "../client/hub-client.ts";
import { detectVendor, vendorFromClient } from "../client/config.ts";
import { type AgentSession, dropSession, ensureSession, hostPid } from "../client/session.ts";
import { type Workspace, loadWorkspace } from "../client/workspace.ts";
import { DaemonClient } from "../daemon/client.ts";
import { Gateway, type WriteRequest, hashText } from "../enforce/gateway.ts";
import { noSealer } from "../enforce/seal.ts";
import {
  ago,
  took,
  renderAcquire,
  renderClaim,
  renderJob,
  renderLocks,
  renderTeam,
  renderWait,
  renderWrite,
} from "../protocol/render.ts";
import { encloses, formatTarget, parseTarget } from "../protocol/target.ts";
import type { AcquireResult, Lock, Priority, WriteResult } from "../protocol/types.ts";
import { TOP, parseSymbols } from "../symbols/parser.ts";

/**
 * The agent-facing surface. Ten tools, one-line descriptions, terse results.
 * Axis v1 shipped 28 tools with paragraph-long descriptions that cost every
 * agent thousands of tokens per session before it did anything; this surface
 * is roughly a tenth of that. The protocol is taught once, in `instructions`.
 */

const INSTRUCTIONS = `Axis coordinates you with other agents (other people, other machines, other vendors) on this repo.
Locked files are sealed by the OS: a plain write fails with EPERM. Edit through axis_edit / axis_write; they lock exactly the functions you touch, merge with teammates' edits to other functions, and tell you who is in your way.
Start with axis_status. Take work with axis_job. If DENIED, read the holder's reason and the advice, then either wait (axis_wait) or work elsewhere. Release with axis_unlock or axis_job done.`;

const S = (props: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties: props,
  required,
  additionalProperties: false,
});
const str = { type: "string" };
const strs = { type: "array", items: str };

const TOOLS = [
  {
    name: "axis_status",
    description: "Team, locks, jobs, recent activity, project soul. Call first.",
    inputSchema: S({}),
  },
  {
    name: "axis_edit",
    description:
      'Replace exact text in a file (locks the functions it touches). old="" creates a new file.',
    inputSchema: S(
      {
        path: str,
        old: str,
        new: str,
        all: { type: "boolean" },
        why: str,
        more: {
          type: "array",
          description: "More {path, old, new} edits, applied with this one: all or none.",
          items: S({ path: str, old: str, new: str, all: { type: "boolean" } }, [
            "path",
            "old",
            "new",
          ]),
        },
      },
      ["path", "old", "new"]
    ),
  },
  {
    name: "axis_write",
    description:
      'Write a whole file, or one symbol\'s full source when `symbol` is set (e.g. "Auth.login"; new names are appended).',
    inputSchema: S({ path: str, content: str, symbol: str, why: str }, ["path", "content"]),
  },
  {
    name: "axis_lock",
    description:
      'Lock files or symbols ("src/a.ts", "src/a.ts#Auth.login") before a multi-step change.',
    inputSchema: S({ targets: strs, why: str }, ["targets", "why"]),
  },
  {
    name: "axis_unlock",
    description:
      "Release your locks (omit targets for all). force+reason breaks another agent's stale lock.",
    inputSchema: S({ targets: strs, force: { type: "boolean" }, reason: str }),
  },
  {
    name: "axis_wait",
    description:
      "Block until targets free up, then take them (FIFO). defer:true queues and returns now; you're told when they're yours.",
    inputSchema: S(
      { targets: strs, why: str, seconds: { type: "number" }, defer: { type: "boolean" } },
      ["targets", "why"]
    ),
  },
  {
    name: "axis_symbols",
    description:
      "List a file's lockable units (functions, doc sections, config keys) and who holds each.",
    inputSchema: S({ path: str }, ["path"]),
  },
  {
    name: "axis_job",
    description: "Job board. do: list | post | claim (next, or id) | done | release | cancel.",
    inputSchema: S(
      {
        do: { type: "string", enum: ["list", "post", "claim", "done", "release", "cancel"] },
        id: str,
        title: str,
        detail: str,
        priority: { type: "string", enum: ["low", "medium", "high", "critical"] },
        after: strs,
        outcome: str,
      },
      ["do"]
    ),
  },
  {
    name: "axis_note",
    description: "Post a note to the team feed, or read recent notes (no text).",
    inputSchema: S({ text: str }),
  },
  {
    name: "axis_soul",
    description: "Read, or update, the project's shared context and conventions.",
    inputSchema: S({ context: str, conventions: str }),
  },
];

class AxisAgent {
  private ws?: Workspace;
  private session?: AgentSession;
  private me?: HubClient;
  private daemon?: DaemonClient | null;
  private localGateway?: Gateway;
  private tierLabel = "unknown";
  private lastSeq = 0;
  private jobId?: string;
  private ready?: Promise<string | null>;

  /** Set from the MCP handshake before the eager init runs. */
  clientName?: string;

  constructor(private hostPid: number) {}

  /** Lazy, once: resolve workspace, start/adopt the agent session, make sure enforcement is running. */
  init(): Promise<string | null> {
    this.ready ??= (async () => {
      const found = loadWorkspace();
      if (!found.ok) return found.reason;
      this.ws = found.ws;
      const env = detectVendor();
      this.session = await ensureSession(found.ws.hub, found.ws.config.project, this.hostPid, {
        vendor: env === "agent" ? (vendorFromClient(this.clientName) ?? env) : env,
      });
      this.me = found.ws.hub.withToken(this.session.token);
      try {
        this.daemon = await DaemonClient.ensure();
        const reg = await this.daemon.register({
          root: found.ws.root,
          hub: found.ws.config.hub,
          project: found.ws.config.project,
          memberToken: found.ws.credential.memberToken,
        });
        this.tierLabel = `${reg.tier} (${reg.mechanism})`;
      } catch (e) {
        // No daemon: writes still take locks and merge through an in-process gateway, but it
        // must not seal. Nothing here would lift a seal again or converge on teammates' locks,
        // so a sealed file would stay frozen after this agent exits.
        this.daemon = null;
        this.localGateway = new Gateway(found.ws.root, noSealer(), () => {});
        this.tierLabel = `off (daemon unavailable: ${(e as Error).message}; locks are advisory until \`axis init\` starts it)`;
      }
      const last = await this.me.events(0, 1).catch(() => []);
      this.lastSeq = last.at(-1)?.seq ?? 0;
      return null;
    })();
    return this.ready;
  }

  async shutdown(): Promise<void> {
    if (!this.session || !this.me) return;
    await this.me.endAgent().catch(() => {});
    dropSession(this.session);
  }

  async call(name: string, a: Record<string, unknown>): Promise<string> {
    const problem = await this.init();
    if (problem) return `AXIS OFF: ${problem}`;
    const body = await this.dispatch(name, a);
    return body + (await this.trailer());
  }

  /** Appended to every result: locks the queue handed this agent, then what the team did meanwhile. */
  private async trailer(): Promise<string> {
    try {
      const { events, handoffs } = await this.me!.feed(this.lastSeq, 50);
      if (events.length) this.lastSeq = events.at(-1)!.seq;
      const yours = handoffs.flatMap((h) =>
        h.outcome.status === "granted" ? h.outcome.locks.map(formatTarget) : []
      );
      const freed = handoffs
        .filter((h) => h.outcome.status === "free")
        .flatMap((h) => h.targets.map(formatTarget));
      return (
        (yours.length ? `\nYOURS NOW (handed over by the queue): ${yours.join(", ")}` : "") +
        (freed.length ? `\nFREE NOW: ${freed.join(", ")}` : "") +
        renderTeam(events, this.session!.agent.id)
      );
    } catch {
      return "";
    }
  }

  private async dispatch(name: string, a: Record<string, unknown>): Promise<string> {
    const me = this.me!;
    switch (name) {
      case "axis_status":
        return this.status();

      case "axis_edit": {
        const edits = [a, ...(Array.isArray(a.more) ? (a.more as Record<string, unknown>[]) : [])];
        if (edits.length === 1)
          return this.write({
            op: "edit",
            path: s(a.path),
            oldString: s(a.old),
            newString: s(a.new),
            replaceAll: !!a.all,
            intent: opt(a.why),
            jobId: this.jobId,
          });
        return this.writeBatch(edits, opt(a.why));
      }

      case "axis_write":
        if (a.symbol)
          return this.write({
            op: "symbol",
            path: s(a.path),
            symbol: s(a.symbol),
            content: s(a.content),
            intent: opt(a.why),
            jobId: this.jobId,
          });
        return this.write({
          op: "write",
          path: s(a.path),
          content: s(a.content),
          intent: opt(a.why),
          jobId: this.jobId,
        });

      case "axis_lock": {
        const targets = this.normTargets(a.targets);
        const r = await me.acquire(targets, s(a.why), this.jobId);
        return renderAcquire(r, await this.freeFor(r));
      }

      case "axis_unlock": {
        if (a.force) {
          const targets = this.normTargets(a.targets);
          if (!targets.length || !a.reason)
            return "ERROR force needs targets and a reason (it is shown to the team).";
          const { broken } = await me.force(targets, s(a.reason));
          return broken.length
            ? `OK broke ${broken.map((l) => `${formatTarget(l)} (${l.agent.name})`).join(", ")}`
            : "Nothing matched; no lock broken.";
        }
        const targets =
          Array.isArray(a.targets) && a.targets.length ? this.normTargets(a.targets) : "all";
        const r = await me.release(targets);
        return r.released.length
          ? `OK released ${r.released.join(", ")}` +
              (r.notHeld.length ? ` · not yours: ${r.notHeld.join(", ")}` : "")
          : "Nothing to release.";
      }

      case "axis_wait": {
        if (a.defer) {
          const r = await me.defer(this.normTargets(a.targets), s(a.why), this.jobId);
          if (r.status !== "queued") return renderAcquire(r);
          return `QUEUED for ${r.targets.join(", ")}${r.ahead ? ` behind ${r.ahead}` : ""}. Keep working; the next Axis result after they free up says they're yours.\n${renderAcquire(r.denied).replace(/^DENIED /, "HELD ")}`;
        }
        const seconds = Math.min(Math.max(Number(a.seconds ?? 45), 1), 110);
        const r = await me.wait(this.normTargets(a.targets), {
          timeoutMs: seconds * 1000,
          acquire: true,
          intent: s(a.why),
          jobId: this.jobId,
        });
        const free =
          r.status === "timeout"
            ? await this.freeFor({
                status: "denied",
                conflicts: r.conflicts,
                holders: r.holders,
                advice: r.advice,
                openJobs: [],
              })
            : undefined;
        return renderWait(r, free);
      }

      case "axis_symbols":
        return this.symbols(s(a.path));

      case "axis_job":
        return this.job(a);

      case "axis_note": {
        if (a.text) {
          await me.note(s(a.text));
          return "OK noted.";
        }
        const notes = (await me.events(0, 300)).filter((e) => e.type === "note").slice(-15);
        const now = Date.now();
        return notes.length
          ? notes
              .map((n) => `${ago(now - n.ts)} ${n.agent?.name ?? n.data.by}: ${n.text}`)
              .join("\n")
          : "No notes yet.";
      }

      case "axis_soul": {
        if (a.context !== undefined || a.conventions !== undefined) {
          await me.setSoul({ context: opt(a.context), conventions: opt(a.conventions) });
          return "OK soul updated.";
        }
        const soul = await me.soul();
        if (!soul.context && !soul.conventions)
          return "Soul is empty. Fill it: axis_soul {context, conventions} with what a new teammate must know.";
        return `# Context\n${soul.context || "(empty)"}\n\n# Conventions\n${soul.conventions || "(empty)"}`;
      }
    }
    return `ERROR unknown tool ${name}`;
  }

  private async status(): Promise<string> {
    const snap = await this.me!.snapshot(40);
    const myId = this.session!.agent.id;
    const now = snap.serverTime;
    const lines = [
      `axis · ${snap.project.name} · you are ${this.session!.agent.name} · enforcement here: ${this.tierLabel}`,
    ];
    const others = snap.agents.filter((x) => x.id !== myId && x.status !== "offline");
    lines.push(
      others.length
        ? `team: ${others.map((x) => `${x.name}@${x.device} ${x.status}${x.task ? ` "${x.task}"` : ""}`).join("; ")}`
        : "team: nobody else online"
    );
    const devices = snap.devices.filter((d) => d.online);
    if (devices.length)
      lines.push(
        `devices: ${devices.map((d) => `${d.hostname} ${d.tier} (${d.sealed.length} sealed)`).join("; ")}`
      );
    lines.push(
      snap.locks.length ? `locks (* yours):\n${renderLocks(snap.locks, myId)}` : "locks: none"
    );
    const open = snap.jobs.filter((j) => j.status === "todo" || j.status === "in_progress");
    lines.push(
      open.length ? `jobs:\n${open.map((j) => "  " + renderJob(j)).join("\n")}` : "jobs: none open"
    );
    const soul = await this.me!.soul().catch(() => ({ context: "", conventions: "" }));
    const soulText = [soul.context, soul.conventions].filter(Boolean).join("\n").trim();
    lines.push(
      soulText
        ? `soul: ${soulText.slice(0, 500).replace(/\s+/g, " ")}${soulText.length > 500 ? " … (axis_soul for all)" : ""}`
        : "soul: empty (fill it with axis_soul)"
    );
    const stats = await this.me!.analytics(24).catch(() => null);
    if (stats?.hot.length)
      lines.push(
        `contention (24h): ${stats.hot
          .slice(0, 3)
          .map(
            (h) =>
              `${h.target} ${h.denials} denied${h.waits ? `, ${h.waits} waited ${took(h.waitedMs)}` : ""}`
          )
          .join("; ")}`
      );
    const recent = snap.events.filter((e) => e.type !== "device.report").slice(-5);
    if (recent.length)
      lines.push(`recent:\n${recent.map((e) => `  ${ago(now - e.ts)} ${e.text}`).join("\n")}`);
    this.lastSeq = snap.events.at(-1)?.seq ?? this.lastSeq;
    return lines.join("\n");
  }

  private async write(req: WriteRequest): Promise<string> {
    if (!req.path) return "ERROR path is required.";
    const rel = { ...req, path: this.rel(req.path) } as WriteRequest;
    let r: WriteResult;
    if (this.daemon) r = await this.daemon.write(this.session!.token, rel, this.ws!.root);
    else r = await this.localGateway!.apply(this.me!, rel);
    return renderWrite(r, r.status === "denied" ? await this.freeFor(r.acquire) : undefined);
  }

  /**
   * Edits across several files as one change. Edits to the same file are applied
   * in order to what is on disk now and sent as one write, so each file appears
   * once and the gateway can lock and write the whole batch atomically.
   */
  private async writeBatch(edits: Record<string, unknown>[], why?: string): Promise<string> {
    const byFile = new Map<string, { old: string; new: string; all: boolean }[]>();
    for (const e of edits) {
      const rel = this.rel(s(e.path));
      if (!rel) return "ERROR every edit needs a path.";
      byFile.set(rel, [...(byFile.get(rel) ?? []), { old: s(e.old), new: s(e.new), all: !!e.all }]);
    }
    const requests: WriteRequest[] = [];
    for (const [rel, list] of byFile) {
      if (list.length === 1) {
        const [e] = list as [{ old: string; new: string; all: boolean }];
        requests.push({
          op: "edit",
          path: rel,
          oldString: e.old,
          newString: e.new,
          replaceAll: e.all,
          intent: why,
          jobId: this.jobId,
        });
        continue;
      }
      const abs = path.join(this.ws!.root, rel);
      const base = existsSync(abs) ? readFileSync(abs, "utf8") : "";
      let next = base;
      for (const e of list) {
        const n = next.split(e.old).length - 1;
        if (e.old === "" || n === 0)
          return `ERROR an old string for ${rel} was not found. Nothing was written.`;
        if (n > 1 && !e.all)
          return `ERROR an old string matches ${n} places in ${rel}. Nothing was written.`;
        next = e.all ? next.split(e.old).join(e.new) : next.replace(e.old, () => e.new);
      }
      requests.push({
        op: "write",
        path: rel,
        content: next,
        baseHash: hashText(base),
        intent: why,
        jobId: this.jobId,
      });
    }
    const results = this.daemon
      ? await this.daemon.writeMany(this.session!.token, requests, this.ws!.root)
      : await this.localGateway!.applyMany(this.me!, requests);
    const denied = results.find((r) => r.status === "denied");
    if (denied)
      return (
        renderWrite(
          denied,
          denied.status === "denied" ? await this.freeFor(denied.acquire) : undefined
        ) + "\nNothing was written."
      );
    return results.map((r) => renderWrite(r)).join("\n");
  }

  private async symbols(p: string): Promise<string> {
    const rel = this.rel(p);
    const abs = path.join(this.ws!.root, rel);
    if (!existsSync(abs)) return `ERROR ${rel} does not exist.`;
    const parsed = await parseSymbols(rel, readFileSync(abs, "utf8"));
    const locks = (await this.me!.locks()).filter((l) => l.path === rel);
    const myId = this.session!.agent.id;
    const holder = (name: string) =>
      locks.find((l) => l.symbol === "" || l.symbol === name || encloses(l.symbol, name));
    const fileLock = locks.find((l) => l.symbol === "");
    if (!parsed.language)
      return `${rel}: no grammar, locks are whole-file.${fileLock ? ` Held by ${fileLock.agent.name}: "${fileLock.intent}"` : " Free."}`;
    const rows = parsed.symbols.map((sym) => {
      const h = holder(sym.name);
      const who = h ? (h.agent.id === myId ? " ← you" : ` ← ${h.agent.name}: "${h.intent}"`) : "";
      return `${"  ".repeat(sym.depth)}${sym.name} ${sym.kind} L${sym.start + 1}-${sym.end + 1}${who}`;
    });
    const top = locks.find((l) => l.symbol === TOP);
    if (top) rows.push(`(top) imports/glue ← ${top.agent.name}`);
    return `${rel} (${parsed.language}${parsed.hasErrors ? ", has syntax errors" : ""}):\n${rows.join("\n") || "(no symbols)"}`;
  }

  private async job(a: Record<string, unknown>): Promise<string> {
    const me = this.me!;
    const id = opt(a.id);
    switch (a.do) {
      case "list": {
        const jobs = await me.jobs(true);
        const open = jobs.filter((j) => j.status === "todo" || j.status === "in_progress");
        const done = jobs.filter((j) => j.status === "done").slice(-3);
        return [...open, ...done].map(renderJob).join("\n") || "No jobs. Post one with do=post.";
      }
      case "post": {
        if (!a.title) return "ERROR title is required.";
        const j = await me.postJob({
          title: s(a.title),
          description: opt(a.detail),
          priority: (opt(a.priority) as Priority) ?? "medium",
          dependencies: Array.isArray(a.after) ? (a.after as string[]) : [],
        });
        return `OK posted ${renderJob(j)}`;
      }
      case "claim": {
        const r = await me.claim(id);
        if (r.status === "claimed") {
          this.jobId = r.job.id;
          await me.heartbeat(`${r.job.id}: ${r.job.title}`).catch(() => {});
        }
        return renderClaim(r);
      }
      case "done": {
        const jobId = id ?? this.jobId;
        if (!jobId) return "ERROR which job? Pass id.";
        if (!a.outcome) return "ERROR outcome is required: one line on what you did.";
        const r = await me.complete(jobId, s(a.outcome));
        if (this.jobId === jobId) this.jobId = undefined;
        return `OK ${jobId} done${r.released.length ? `, released ${r.released.join(", ")}` : ""}.`;
      }
      case "release": {
        if (!id) return "ERROR id is required.";
        await me.releaseJob(id);
        if (this.jobId === id) this.jobId = undefined;
        return `OK ${id} is back on the board.`;
      }
      case "cancel": {
        if (!id) return "ERROR id is required.";
        await me.cancelJob(id, opt(a.outcome) ?? "cancelled");
        return `OK ${id} cancelled.`;
      }
    }
    return "ERROR do must be list, post, claim, done, release or cancel.";
  }

  /** For each denied file, which symbols are still free: the concrete "work elsewhere" option. */
  private async freeFor(r: AcquireResult): Promise<Record<string, string[]> | undefined> {
    if (r.status !== "denied") return undefined;
    const out: Record<string, string[]> = {};
    let locks: Lock[] | undefined;
    for (const file of new Set(r.conflicts.map((c) => c.lock.path))) {
      const abs = path.join(this.ws!.root, file);
      if (!existsSync(abs)) continue;
      const parsed = await parseSymbols(file, readFileSync(abs, "utf8")).catch(() => null);
      if (!parsed?.language) continue;
      locks ??= await this.me!.locks();
      const taken = locks.filter((l) => l.path === file);
      if (taken.some((l) => l.symbol === "")) continue;
      out[file] = parsed.symbols
        .filter(
          (sym) =>
            sym.kind !== "class" &&
            sym.kind !== "module" &&
            !taken.some(
              (l) =>
                l.symbol === sym.name ||
                encloses(l.symbol, sym.name) ||
                encloses(sym.name, l.symbol)
            )
        )
        .map((sym) => sym.name);
    }
    return out;
  }

  private rel(p: string): string {
    const abs = path.resolve(this.ws!.root, p);
    return path.relative(this.ws!.root, abs).split(path.sep).join("/");
  }

  private normTargets(raw: unknown): string[] {
    if (!Array.isArray(raw)) return [];
    return raw.map((t) => {
      const parsed = parseTarget(String(t));
      return formatTarget({ path: this.rel(parsed.path), symbol: parsed.symbol });
    });
  }
}

function s(v: unknown): string {
  return v === undefined || v === null ? "" : String(v);
}

function opt(v: unknown): string | undefined {
  return v === undefined || v === null || v === "" ? undefined : String(v);
}

export async function runMcpServer(): Promise<void> {
  const agent = new AxisAgent(hostPid());
  const server = new Server(
    { name: "axis", version: "2.0.0" },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      const text = await agent.call(
        req.params.name,
        (req.params.arguments ?? {}) as Record<string, unknown>
      );
      return { content: [{ type: "text", text }] };
    } catch (e) {
      return { content: [{ type: "text", text: `ERROR ${(e as Error).message}` }], isError: true };
    }
  });

  // Start the session eagerly so the team sees this agent (and its enforcement) right away,
  // once the handshake has told us which host we run under.
  server.oninitialized = () => {
    agent.clientName = server.getClientVersion()?.name;
    void agent.init().catch(() => {});
  };

  const transport = new StdioServerTransport();
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await agent.shutdown();
    process.exit(0);
  };
  transport.onclose = () => void close();
  process.stdin.on("end", () => void close());
  process.on("SIGTERM", () => void close());
  process.on("SIGINT", () => void close());
  await server.connect(transport);
}

export { TOOLS, INSTRUCTIONS };
