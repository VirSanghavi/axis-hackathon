import { readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Where did a locked file go? Asked when a locked path vanishes from disk.
 *
 * Only paths git reports as new in this checkout are candidates: a rename git
 * already recorded (`git mv`, a staged rename), or an untracked or added file
 * whose content matches the vanished one (an editor or agent rename). Files git
 * already knew are never candidates, so a teammate whose checkout still has the
 * old layout can never "move" the locks back.
 */
export function findMove(
  root: string,
  rel: string,
  lastContent?: string,
  symbols: string[] = []
): string | null {
  const r = Bun.spawnSync(
    ["git", "-C", root, "status", "--porcelain=v1", "-z", "--untracked-files=all", "-M"],
    { stdout: "pipe", stderr: "ignore" }
  );
  if (r.exitCode !== 0) return null;
  const fields = r.stdout.toString().split("\0");
  const fresh: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i]!;
    if (f.length < 4) continue;
    const xy = f.slice(0, 2);
    const file = f.slice(3);
    if (xy[0] === "R" || xy[0] === "C") {
      // A rename git recorded is already explained by its own source; never a candidate for another.
      const from = fields[++i];
      if (xy[0] === "R" && from === rel) return file;
    } else if (xy === "??" || xy[0] === "A") fresh.push(file);
  }
  if (lastContent === undefined) return null;
  // No rename on record: the new file most like the old one, if it is clearly the same file.
  // It must still define every locked unit, so shared boilerplate alone never matches.
  const names = symbols.filter((s) => s && !s.startsWith("(")).map((s) => s.split(".").pop()!);
  let best: { file: string; score: number } | null = null;
  let tie = false;
  for (const file of fresh.slice(0, 5000)) {
    const abs = path.join(root, file);
    let text: string;
    try {
      if (statSync(abs).size > 2 * 1024 * 1024) continue;
      text = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    if (text !== lastContent && names.some((n) => !text.includes(n))) continue;
    const score = text === lastContent ? 1 : similarity(lastContent, text);
    if (!best || score > best.score) {
      tie = false;
      best = { file, score };
    } else if (score === best.score) tie = true;
  }
  // git's own rename threshold is 50%; ask for more, since a wrong guess moves a teammate's lock.
  return best && best.score >= 0.6 && !tie ? best.file : null;
}

/** Share of non-blank lines the two texts have in common (as multisets), over the larger count. */
export function similarity(a: string, b: string): number {
  const lines = (t: string) => t.split(/\r?\n/).filter((l) => l.trim() !== "");
  const la = lines(a);
  const lb = lines(b);
  if (!la.length || !lb.length) return 0;
  const counts = new Map<string, number>();
  for (const l of la) counts.set(l, (counts.get(l) ?? 0) + 1);
  let common = 0;
  for (const l of lb) {
    const c = counts.get(l) ?? 0;
    if (c > 0) {
      common++;
      counts.set(l, c - 1);
    }
  }
  return common / Math.max(la.length, lb.length);
}
