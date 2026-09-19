import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  chownSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { HubClient } from "../client/hub-client.ts";
import { HubError } from "../client/hub-client.ts";
import { formatTarget } from "../protocol/target.ts";
import type { Lock, Target, WriteResult } from "../protocol/types.ts";
import { merge3, splitLines, touchedTargets, uncovered } from "../symbols/coverage.ts";
import { structuredFormat } from "../symbols/fallback.ts";
import { TOP, findSymbol, parseSymbols } from "../symbols/parser.ts";
import type { Sealer } from "./seal.ts";

export type WriteRequest =
  | {
      op: "edit";
      path: string;
      oldString: string;
      newString: string;
      replaceAll?: boolean;
      intent?: string;
      jobId?: string;
    }
  | {
      op: "write";
      path: string;
      content: string;
      baseHash?: string;
      intent?: string;
      jobId?: string;
    }
  | {
      op: "symbol";
      path: string;
      symbol: string;
      content: string;
      intent?: string;
      jobId?: string;
    };

export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** Recently seen file versions by hash, so a full-file write can be 3-way merged against what the writer read. */
export class ContentCache {
  private map = new Map<string, string>();
  private bytes = 0;
  constructor(private maxBytes = 64 * 1024 * 1024) {}
  put(text: string): string {
    const h = hashText(text);
    if (this.map.has(h)) {
      const v = this.map.get(h)!;
      this.map.delete(h);
      this.map.set(h, v);
      return h;
    }
    this.map.set(h, text);
    this.bytes += text.length;
    while (this.bytes > this.maxBytes && this.map.size > 1) {
      const [k, v] = this.map.entries().next().value as [string, string];
      this.map.delete(k);
      this.bytes -= v.length;
    }
    return h;
  }
  get(h: string): string | undefined {
    return this.map.get(h);
  }
}

/**
 * The enforcement gateway: the only way to change a sealed file.
 *
 * For every write it (1) computes exactly which symbols the change touches,
 * (2) makes sure the writer holds locks covering them, taking any free ones
 * automatically so agents never need a separate "lock" call, (3) 3-way merges
 * against teammates' concurrent edits to other functions, and (4) swaps the
 * new content in atomically, re-sealed, so there is no window in which a
 * non-Axis process could slip a write in.
 */
export class Gateway {
  readonly cache = new ContentCache();
  private chains = new Map<string, Promise<unknown>>();
  private readonly realRoot: string;

  constructor(
    readonly root: string,
    private sealer: Sealer,
    private onSealed: (abs: string) => void,
    /** When running as root, files are written back with the workspace owner's uid/gid. */
    private owner?: { uid: number; gid: number }
  ) {
    this.realRoot = realpathSync(root);
  }

  /** Resolve a caller-supplied path to [repo-relative, absolute], refusing anything outside the workspace. */
  resolve(p: string): { rel: string; abs: string } {
    const abs = path.resolve(
      this.realRoot,
      p.startsWith(this.root) ? path.relative(this.root, p) : p
    );
    const dir = path.dirname(abs);
    const realDir = existsSync(dir) ? realpathSync(dir) : dir;
    const real = path.join(realDir, path.basename(abs));
    if (real !== this.realRoot && !real.startsWith(this.realRoot + path.sep))
      throw new GatewayError("io", `${p} is outside the workspace.`);
    if (existsSync(real) && lstatSync(real).isSymbolicLink())
      throw new GatewayError("io", `${p} is a symlink; write its target instead.`);
    return { rel: path.relative(this.realRoot, real).split(path.sep).join("/"), abs: real };
  }

  read(p: string): { rel: string; content: string; hash: string; exists: boolean } {
    const { rel, abs } = this.resolve(p);
    const exists = existsSync(abs);
    const content = exists ? readFileSync(abs, "utf8") : "";
    return { rel, content, hash: this.cache.put(content), exists };
  }

  async apply(agent: HubClient, req: WriteRequest): Promise<WriteResult> {
    return (await this.applyMany(agent, [req]))[0]!;
  }

  /**
   * Several files as one change: every touched unit in every file is locked in a
   * single all-or-nothing acquire, every merge is checked, and only then is any
   * file written. Either the whole batch lands or none of it does.
   */
  async applyMany(agent: HubClient, reqs: WriteRequest[]): Promise<WriteResult[]> {
    const fail = (e: unknown, rel: (r: WriteRequest) => string) =>
      reqs.map((r): WriteResult => {
        const code = e instanceof GatewayError ? e.code : "io";
        return { status: "error", path: rel(r), code, message: (e as Error).message };
      });
    let items: { req: WriteRequest; rel: string; abs: string }[];
    try {
      items = reqs.map((req) => ({ req, ...this.resolve(req.path) }));
      if (new Set(items.map((i) => i.abs)).size !== items.length)
        throw new GatewayError(
          "ambiguous",
          "Each file may appear once in a batch; combine its edits."
        );
    } catch (e) {
      return fail(e, (r) => r.path);
    }
    const keys = [...new Set(items.map((i) => i.abs))].sort();
    try {
      return await this.serializeAll(keys, () => this.applyPlanned(agent, items));
    } catch (e) {
      return fail(e, (r) => items.find((i) => i.req === r)?.rel ?? r.path);
    }
  }

  /** Steps 1 to 4 below, across every file of the batch. */
  private async applyPlanned(
    agent: HubClient,
    items: { req: WriteRequest; rel: string; abs: string }[]
  ): Promise<WriteResult[]> {
    // 1. What each writer started from, and what it wants.
    const plans = [];
    for (const { req, rel, abs } of items) {
      const exists = existsSync(abs);
      if (exists && !statSync(abs).isFile())
        throw new GatewayError("io", `${rel} is not a regular file.`);
      const current = exists ? readFileSync(abs, "utf8") : "";
      this.cache.put(current);
      let base = current;
      let next: string;
      if (req.op === "edit") {
        if (!exists && req.oldString !== "")
          throw new GatewayError("not_found", `${rel} does not exist. Use write to create it.`);
        next = replaceExact(current, req.oldString, req.newString, !!req.replaceAll, rel);
      } else if (req.op === "symbol") {
        next = await spliceSymbol(rel, current, req.symbol, req.content);
      } else {
        if (req.baseHash && req.baseHash !== hashText(current)) {
          const cached = this.cache.get(req.baseHash);
          if (cached !== undefined) base = cached;
        }
        next = req.content;
      }
      const touched = next === current ? null : await touchedTargets(rel, base, next);
      plans.push({ req, rel, abs, current, base, next, touched });
    }

    // 2. Which units do the changes touch, and does the writer hold them? One acquire for all.
    let mine = await agent.myLocks();
    const need = plans.flatMap((p) =>
      p.touched
        ? uncovered(p.touched.targets, mine.filter((l) => l.path === p.rel).map(asTarget))
        : []
    );
    const autoLocked: string[] = [];
    if (need.length) {
      const names = need.map(formatTarget);
      const intent =
        [...new Set(plans.map((p) => p.req.intent?.trim()).filter(Boolean))].join("; ") ||
        `editing ${names.map((n) => n.split("#")[1] || n).join(", ")}`;
      const res = await agent.acquire(names, intent, plans[0]!.req.jobId);
      if (res.status === "denied") {
        for (const p of plans)
          if (res.conflicts.some((c) => c.target.split("#")[0] === p.rel))
            void agent
              .reportWrite(
                "blocked",
                p.rel,
                `needs ${res.conflicts.map((c) => c.target).join(", ")}`
              )
              .catch(() => {});
        return plans.map((p) => ({ status: "denied", path: p.rel, acquire: res }));
      }
      if (res.status === "invalid")
        throw new GatewayError("no_symbol", res.errors.map((e) => e.message).join(" "));
      autoLocked.push(
        ...res.locks.filter((l) => !res.renewed.includes(formatTarget(l))).map(formatTarget)
      );
      mine = await agent.myLocks();
    }

    // 3. Merge each with anything teammates changed since its base. Any overlap stops the batch.
    const finals: { text: string; merged: boolean }[] = [];
    for (const p of plans) {
      if (p.base === p.current) {
        finals.push({ text: p.next, merged: false });
        continue;
      }
      const m = merge3(p.base, p.current, p.next);
      if (!m.ok) {
        const conflict: WriteResult = {
          status: "conflict",
          path: p.rel,
          lines: m.conflictLines,
          currentHash: this.cache.put(p.current),
          message: `Your change overlaps a newer edit at line${m.conflictLines.length > 1 ? "s" : ""} ${m.conflictLines.join(", ")}. Re-read ${p.rel} and reapply.`,
        };
        return plans.map((o) =>
          o === p
            ? conflict
            : {
                status: "error",
                path: o.rel,
                code: "io",
                message: `Not written: the batch stopped because ${p.rel} conflicted.`,
              }
        );
      }
      finals.push({ text: m.text, merged: true });
    }

    // 4. Swap every file in, sealed.
    const out: WriteResult[] = [];
    for (const [i, p] of plans.entries()) {
      if (!p.touched) {
        out.push({
          status: "applied",
          path: p.rel,
          hash: hashText(p.current),
          autoLocked: [],
          merged: false,
          touched: [],
        });
        continue;
      }
      const held = mine.filter((l) => l.path === p.rel);
      this.writeSealed(p.abs, finals[i]!.text, held.length > 0);
      const hash = this.cache.put(finals[i]!.text);
      await this.followRenames(agent, p.rel, held, p.touched.removed, p.touched.added);
      const required = p.touched.targets;
      void agent
        .reportWrite("applied", p.rel, required.map((t) => t.symbol || "file").join(", "))
        .catch(() => {});
      out.push({
        status: "applied",
        path: p.rel,
        hash,
        autoLocked: autoLocked.filter((t) => t.split("#")[0] === p.rel),
        merged: finals[i]!.merged,
        touched: required.map((t) => t.symbol || "(file)"),
      });
    }
    // Imports and glue are locked like any unit, but only for the write itself when the
    // writer did not ask for them: every agent in the file edits them, so holding them for a
    // whole lease would serialize the file.
    const tops = autoLocked.filter((t) => t.endsWith(`#${TOP}`));
    if (tops.length) await agent.release(tops).catch(() => {});
    return out;
  }

  /** Put a file back to `text` (or remove it, for null), unsealed; the daemon reseals as the locks say. */
  restore(abs: string, text: string | null): void {
    if (text === null) {
      this.sealerSync("unseal", abs);
      rmSync(abs, { force: true });
    } else this.writeSealed(abs, text, false);
  }

  /**
   * Keep an agent's full attempt when part of it had to be put back, so no work
   * is lost: `.axis/rejected/<time>-<file>`, ignored by git, owned by the workspace owner.
   */
  saveAside(rel: string, text: string): string {
    const axisDir = path.join(this.realRoot, ".axis");
    const dir = path.join(axisDir, "rejected");
    for (const d of [axisDir, dir]) {
      if (!existsSync(d)) mkdirSync(d);
      // The root daemon writes here: never through a symlink planted to point outside the workspace.
      if (lstatSync(d).isSymbolicLink() || realpathSync(d) !== d)
        throw new GatewayError(
          "io",
          `${path.relative(this.realRoot, d)} is not a plain directory.`
        );
      if (this.owner) chownSync(d, this.owner.uid, this.owner.gid);
    }
    const ignore = path.join(axisDir, ".gitignore");
    if (!existsSync(ignore)) writeFileSync(ignore, "rejected/\n", { flag: "wx" });
    const name = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}-${rel.replace(/[\\/]/g, "__")}`;
    const file = path.join(dir, name);
    writeFileSync(file, text, { mode: 0o644, flag: "wx" });
    if (this.owner) chownSync(file, this.owner.uid, this.owner.gid);
    return path.relative(this.realRoot, file).split(path.sep).join("/");
  }

  /**
   * Locks on symbols this write renamed follow the new name; locks on symbols it
   * deleted are released, since they no longer protect anything. A rename is a
   * removed name and an added name under the same parent, one to one.
   */
  private async followRenames(
    agent: HubClient,
    rel: string,
    held: Lock[],
    removed: string[],
    added: string[]
  ): Promise<void> {
    const parent = (n: string) => n.slice(0, Math.max(0, n.lastIndexOf(".")));
    const gone: string[] = [];
    for (const from of removed) {
      if (!held.some((l) => l.symbol === from)) continue;
      const peers = removed.filter((r) => parent(r) === parent(from));
      const fresh = added.filter((a) => parent(a) === parent(from));
      const to = peers.length === 1 && fresh.length === 1 ? fresh[0] : undefined;
      if (to) await agent.renameLock(rel, from, to).catch(() => {});
      else gone.push(`${rel}#${from}`);
    }
    if (gone.length) await agent.release(gone).catch(() => {});
  }

  /**
   * Replace the file's content without ever leaving it writable to anyone else:
   * the new content is staged beside it, the old seal is lifted, the stage is
   * renamed over the target in one syscall, and the result is sealed again.
   */
  private writeSealed(abs: string, text: string, seal: boolean): void {
    const dir = path.dirname(abs);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const prior = existsSync(abs) ? statSync(abs) : null;
    const tmp = path.join(dir, `.axis-${randomBytes(6).toString("hex")}.tmp`);
    writeFileSync(tmp, text, { mode: prior ? prior.mode & 0o777 : 0o644 });
    try {
      const own = prior ? { uid: prior.uid, gid: prior.gid } : this.owner;
      if (own && this.owner) chownSync(tmp, own.uid, own.gid);
      if (prior) {
        this.sealerSync("unseal", abs);
        // Unsealing can restore write bits (the chmod tier); the replacement keeps the unsealed mode.
        chmodSync(tmp, statSync(abs).mode & 0o7777);
      }
      renameSync(tmp, abs);
    } catch (e) {
      rmSync(tmp, { force: true });
      if (prior) this.sealerSync("seal", abs);
      throw e;
    }
    if (seal) {
      this.sealerSync("seal", abs);
      this.onSealed(abs);
    }
  }

  private sealerSync(action: "seal" | "unseal", abs: string): void {
    this.sealer[action]([abs]);
  }

  /** Hold every key's chain (in sorted order, so two batches can never deadlock). */
  private serializeAll<T>(keys: string[], fn: () => Promise<T>): Promise<T> {
    return keys.reduceRight<() => Promise<T>>(
      (inner, key) => () => this.serialize(key, inner),
      fn
    )();
  }

  private serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    this.chains.set(
      key,
      run.catch(() => {})
    );
    return run;
  }
}

export class GatewayError extends Error {
  constructor(
    public code: "not_found" | "no_match" | "ambiguous" | "parse" | "io" | "no_symbol",
    message: string
  ) {
    super(message);
  }
}

function asTarget(l: Lock): Target {
  return { path: l.path, symbol: l.symbol };
}

function replaceExact(
  text: string,
  oldStr: string,
  newStr: string,
  all: boolean,
  rel: string
): string {
  if (oldStr === "") {
    if (text.length > 0)
      throw new GatewayError(
        "ambiguous",
        `old_string is empty but ${rel} is not; use write to replace the whole file.`
      );
    return newStr;
  }
  const count = text.split(oldStr).length - 1;
  if (count === 0)
    throw new GatewayError(
      "no_match",
      `old_string was not found in ${rel}. Re-read the file; it may have changed.`
    );
  if (count > 1 && !all)
    throw new GatewayError(
      "ambiguous",
      `old_string matches ${count} places in ${rel}. Add surrounding lines to make it unique, or set replaceAll.`
    );
  return all ? text.split(oldStr).join(newStr) : text.replace(oldStr, () => newStr);
}

/**
 * Replace one symbol's full text (or append it, if it does not exist yet).
 * Markdown sections, YAML keys and TOML tables append as blocks; a new JSON
 * key needs a comma on its neighbor, so it is refused in favor of edit.
 */
export async function spliceSymbol(
  rel: string,
  current: string,
  symbol: string,
  content: string
): Promise<string> {
  const parsed = await parseSymbols(rel, current);
  if (!parsed.language)
    throw new GatewayError("parse", `${rel} has no supported grammar; edit it with edit or write.`);
  const format = parsed.language;
  const body = content.endsWith("\n") ? content : content + "\n";
  const lines = splitLines(current);
  const hit = findSymbol(parsed.symbols, symbol);
  if (hit) {
    const out = [...lines.slice(0, hit.start), body, ...lines.slice(hit.end + 1)].join("");
    if (format === "json" && isJson(current) && !isJson(out))
      throw new GatewayError(
        "parse",
        `That content for ${symbol} makes ${rel} invalid JSON (check its trailing comma); nothing was written.`
      );
    return out;
  }
  if (format === "json")
    throw new GatewayError(
      "no_symbol",
      `No ${symbol} in ${rel}. A new JSON key needs a comma after the one before it; add it with edit.`
    );
  // New symbol: inside its container if it has one (Class.method), else at end of file.
  // TOML tables are dotted paths that may live anywhere, so they always go at the end.
  const dot = symbol.lastIndexOf(".");
  let out: string;
  if (dot > 0 && format !== "toml") {
    if (format === "yaml")
      throw new GatewayError(
        "no_symbol",
        `${rel} locks top-level YAML keys only; edit ${symbol} inside ${symbol.slice(0, dot)} with edit.`
      );
    const container = findSymbol(parsed.symbols, symbol.slice(0, dot));
    if (!container)
      throw new GatewayError(
        "no_symbol",
        `No ${symbol.slice(0, dot)} in ${rel} to add ${symbol} to.`
      );
    out =
      format === "markdown"
        ? insertBlock(lines, container.end, body)
        : [...lines.slice(0, container.end), "\n", body, ...lines.slice(container.end)].join("");
  } else {
    const sep =
      current.length === 0
        ? ""
        : current.endsWith("\n\n")
          ? ""
          : current.endsWith("\n")
            ? "\n"
            : "\n\n";
    out = current + sep + body;
  }
  if (structuredFormat(format)) {
    // Text is only a section or key by its heading or key line; make sure the content has one.
    const after = await parseSymbols(rel, out);
    if (!findSymbol(after.symbols, symbol)) {
      const known = new Set(parsed.symbols.map((s) => s.name));
      const got = after.symbols.find((s) => !known.has(s.name))?.name;
      throw new GatewayError(
        "no_symbol",
        `That content would not create ${symbol} in ${rel}${got ? ` (it reads as ${got})` : ""}. Start it with the heading or key for ${symbol}.`
      );
    }
  }
  return out;
}

/** Insert a block after 0-based line `after`, keeping one blank line on each side. */
function insertBlock(lines: string[], after: number, body: string): string {
  let head = lines.slice(0, after + 1).join("");
  const tail = lines.slice(after + 1).join("");
  if (!head.endsWith("\n")) head += "\n";
  const gap = tail && !/^\r?\n/.test(tail) ? "\n" : "";
  return head + "\n" + body + gap + tail;
}

function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}
