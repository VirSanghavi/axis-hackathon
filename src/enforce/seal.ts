import { chmodSync, lstatSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { EnforcementTier } from "../protocol/types.ts";

/**
 * OS-level sealing of locked files.
 *
 * A sealed file cannot be written, truncated, renamed, replaced, or deleted by
 * any process that is not Axis. That includes agents that have never heard of
 * Axis: they get EPERM from the kernel, not a polite message.
 *
 *   kernel  macOS `chflags schg`, Linux `chattr +i`, set by the root daemon.
 *           Only root can clear these flags, so no agent can undo them.
 *   guard   macOS `chflags uchg`, Linux read-only mode (chmod a-w).
 *           Blocks every normal write path, including write-temp-then-rename
 *           editors on macOS. The file owner could clear it deliberately.
 *   off     nothing (unsupported platform or filesystem).
 */
export interface Sealer {
  readonly tier: EnforcementTier;
  readonly mechanism: string;
  /** Synchronous on purpose: callers rely on seal/unseal/rename happening back to back. */
  seal(paths: string[]): string[];
  unseal(paths: string[]): string[];
}

function run(cmd: string[]): { ok: boolean; stderr: string } {
  const p = Bun.spawnSync(cmd, { stdout: "ignore", stderr: "pipe" });
  return { ok: p.exitCode === 0, stderr: p.stderr.toString() };
}

/** Only regular files are ever sealed; a symlink swapped in at the last moment is refused. */
function regularFiles(paths: string[]): string[] {
  return paths.filter((p) => {
    try {
      return lstatSync(p).isFile();
    } catch {
      return false;
    }
  });
}

/** Run a flag command in batches (argv limits) and report which paths succeeded. */
function batch(base: string[], paths: string[]): string[] {
  const done: string[] = [];
  for (let i = 0; i < paths.length; i += 200) {
    const chunk = paths.slice(i, i + 200);
    if (run([...base, ...chunk]).ok) done.push(...chunk);
    else for (const p of chunk) if (run([...base, p]).ok) done.push(p);
  }
  return done;
}

class ChflagsSealer implements Sealer {
  readonly tier: EnforcementTier;
  readonly mechanism: string;
  constructor(private flag: "schg" | "uchg") {
    this.tier = flag === "schg" ? "kernel" : "guard";
    this.mechanism = `chflags ${flag}`;
  }
  seal(paths: string[]): string[] {
    // -h: act on the link itself, never follow a symlink out of the workspace.
    return batch(["chflags", "-h", this.flag], regularFiles(paths));
  }
  unseal(paths: string[]): string[] {
    return batch(["chflags", "-h", `no${this.flag}`], regularFiles(paths));
  }
}

class ChattrSealer implements Sealer {
  readonly tier: EnforcementTier = "kernel";
  readonly mechanism = "chattr +i";
  seal(paths: string[]): string[] {
    return batch(["chattr", "+i"], regularFiles(paths));
  }
  unseal(paths: string[]): string[] {
    return batch(["chattr", "-i"], regularFiles(paths));
  }
}

/** Linux without privilege: strip write bits, remembering each file's mode to restore it. */
class ModeSealer implements Sealer {
  readonly tier: EnforcementTier = "guard";
  readonly mechanism = "chmod a-w";
  private modes = new Map<string, number>();
  seal(paths: string[]): string[] {
    const done: string[] = [];
    for (const p of regularFiles(paths)) {
      try {
        const mode = lstatSync(p).mode & 0o7777;
        if (!this.modes.has(p)) this.modes.set(p, mode);
        chmodSync(p, mode & ~0o222);
        done.push(p);
      } catch {
        /* vanished between list and seal */
      }
    }
    return done;
  }
  unseal(paths: string[]): string[] {
    const done: string[] = [];
    for (const p of regularFiles(paths)) {
      try {
        const mode = this.modes.get(p) ?? (lstatSync(p).mode & 0o7777) | 0o200;
        chmodSync(p, mode);
        this.modes.delete(p);
        done.push(p);
      } catch {
        /* ignore */
      }
    }
    return done;
  }
}

class NullSealer implements Sealer {
  readonly tier: EnforcementTier = "off";
  readonly mechanism = "none";
  seal(): string[] {
    return [];
  }
  unseal(): string[] {
    return [];
  }
}

/** No sealing at all: for a gateway with no daemon to ever lift a seal again. */
export function noSealer(): Sealer {
  return new NullSealer();
}

export function isRoot(): boolean {
  return typeof process.getuid === "function" && process.getuid() === 0;
}

/**
 * Pick the strongest sealer this process can actually apply, proven by sealing
 * and unsealing a probe file rather than assumed from the platform name.
 */
export async function detectSealer(
  opts: { prefer?: EnforcementTier; probeDir?: string } = {}
): Promise<Sealer> {
  if (opts.prefer === "off") return new NullSealer();
  const candidates: Sealer[] = [];
  if (process.platform === "darwin") {
    if (isRoot() && opts.prefer !== "guard") candidates.push(new ChflagsSealer("schg"));
    candidates.push(new ChflagsSealer("uchg"));
  } else if (process.platform === "linux") {
    if (opts.prefer !== "guard") candidates.push(new ChattrSealer());
    candidates.push(new ModeSealer());
  }
  for (const s of candidates) if (await probe(s, opts.probeDir)) return s;
  return new NullSealer();
}

async function probe(s: Sealer, dir?: string): Promise<boolean> {
  let tmp: string | undefined;
  try {
    tmp = mkdtempSync(path.join(dir ?? os.tmpdir(), ".axis-probe-"));
    const f = path.join(tmp, "probe");
    writeFileSync(f, "probe");
    const sealed = s.seal([f]);
    if (sealed.length !== 1) return false;
    let blocked = false;
    try {
      writeFileSync(f, "clobber");
    } catch {
      blocked = true;
    }
    // Only a seal that actually stopped this process counts (root sails through plain mode bits).
    s.unseal([f]);
    return blocked;
  } catch {
    return false;
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
}
