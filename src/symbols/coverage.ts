import { diffIndices, diff3Merge } from "node-diff3";
import { covers } from "../protocol/target.ts";
import type { Target } from "../protocol/types.ts";
import { type CodeSymbol, TOP, parseSymbols } from "./parser.ts";

/**
 * Which lockable units does a change touch?
 *
 * We diff the version the agent started from (`base`) against what it wants
 * to write (`next`), line by line. A removed or rewritten line belongs to the
 * innermost symbol that contained it in `base`; an added line belongs to the
 * innermost symbol that contains it in `next` (a brand-new symbol counts as
 * itself). Non-blank lines outside every symbol (imports, glue) are the
 * pseudo-symbol `(top)`. Markdown, JSON, YAML and TOML split into sections
 * and keys the same way; any other file with no grammar is one unit: the file.
 *
 * The result is exactly the set of targets the writer must hold, which is what
 * makes function-level locking enforceable rather than a naming convention.
 */
export interface Touched {
  /** Targets the change requires, deduplicated and minimal. `""` means the whole file. */
  targets: Target[];
  /** Symbol names in `base` that the change renamed away (for lock bookkeeping). */
  removed: string[];
  /** Symbol names that appear only in `next`. */
  added: string[];
  language: string | null;
}

export function splitLines(text: string): string[] {
  // Keep line terminators attached so joins are lossless (CRLF files stay CRLF).
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

export async function touchedTargets(
  filePath: string,
  base: string,
  next: string
): Promise<Touched> {
  const [b, n] = await Promise.all([parseSymbols(filePath, base), parseSymbols(filePath, next)]);
  if (!b.language)
    return { targets: [{ path: filePath, symbol: "" }], removed: [], added: [], language: null };

  const baseLines = splitLines(base);
  const nextLines = splitLines(next);
  const hunks = diffIndices(baseLines, nextLines);
  const names = new Set<string>();
  const baseNames = new Set(b.symbols.map((s) => s.name));
  const nextNames = new Set(n.symbols.map((s) => s.name));

  for (const h of hunks) {
    const [bStart, bLen] = h.buffer1;
    const [nStart, nLen] = h.buffer2;
    // Lines removed or rewritten belong to whatever owned them in `base`.
    for (let line = bStart; line < bStart + bLen; line++) {
      const owners = attributable(innermost(b.symbols, line), baseLines[line]);
      if (owners.length) owners.forEach((o) => names.add(o.name));
      else if (!isBlank(baseLines[line])) names.add(TOP);
    }
    // Lines added belong to whatever owns them in `next`: an existing symbol they
    // were inserted into, a brand-new symbol, or top-level glue.
    for (let line = nStart; line < nStart + nLen; line++) {
      const owners = attributable(innermost(n.symbols, line), nextLines[line]);
      if (owners.length === 0) {
        if (!isBlank(nextLines[line])) names.add(TOP);
        continue;
      }
      for (const o of owners)
        names.add(baseNames.has(o.name) ? o.name : outermostNew(n.symbols, o, baseNames));
    }
  }

  const minimal = minimize([...names]);
  return {
    targets: minimal.map((symbol) => ({ path: filePath, symbol })),
    removed: [...baseNames].filter((x) => !nextNames.has(x) && names.has(x)),
    added: [...nextNames].filter((x) => !baseNames.has(x)),
    language: b.language,
  };
}

function innermost(symbols: CodeSymbol[], line: number): CodeSymbol[] {
  if (line < 0) return [];
  let depth = -1;
  let found: CodeSymbol[] = [];
  for (const s of symbols) {
    if (s.start <= line && line <= s.end) {
      if (s.depth > depth) {
        depth = s.depth;
        found = [s];
      } else if (s.depth === depth) {
        // Siblings sharing lines (`const a = 1, b = 2`) are all touched.
        found.push(s);
      }
    }
  }
  return found;
}

/** For a brand-new nested symbol inside a brand-new class, the class is the unit to hold. */
function outermostNew(symbols: CodeSymbol[], s: CodeSymbol, baseNames: Set<string>): string {
  let best = s;
  for (const o of symbols) {
    if (o.depth < best.depth && o.start <= s.start && o.end >= s.end && !baseNames.has(o.name))
      best = o;
  }
  return best.name;
}

/**
 * A blank line between two methods is spacing inside the class, not an edit of
 * the class. Blank lines count only inside leaf code symbols (function
 * bodies); in Markdown sections and data keys they are layout, never content.
 */
const SPACING_ONLY = new Set(["class", "module", "section", "key"]);

function attributable(owners: CodeSymbol[], text: string | undefined): CodeSymbol[] {
  if (!isBlank(text)) return owners;
  return owners.filter((o) => !SPACING_ONLY.has(o.kind));
}

function isBlank(line: string | undefined): boolean {
  return !line || line.trim() === "";
}

/** Drop names enclosed by another name in the set: holding `A` already covers `A.b`. */
function minimize(names: string[]): string[] {
  return names.filter(
    (n) => !names.some((o) => o !== n && o !== TOP && n !== TOP && n.startsWith(o + "."))
  );
}

/** Targets in `required` not covered by any of `held`. */
export function uncovered(required: Target[], held: Target[]): Target[] {
  return required.filter((r) => !held.some((h) => covers(h, r)));
}

export type MergeOutcome = { ok: true; text: string } | { ok: false; conflictLines: number[] };

/**
 * Three-way merge: `base` is what the writer read, `current` is what is on disk
 * now (a teammate changed another function meanwhile), `mine` is the writer's
 * version. Disjoint edits merge cleanly; overlapping ones are refused with the
 * lines that collided, never silently resolved.
 */
export function merge3(base: string, current: string, mine: string): MergeOutcome {
  if (current === base) return { ok: true, text: mine };
  if (mine === base) return { ok: true, text: current };
  const regions = diff3Merge(splitLines(current), splitLines(base), splitLines(mine), {
    excludeFalseConflicts: true,
  });
  const out: string[] = [];
  const conflictLines: number[] = [];
  for (const r of regions) {
    if (r.ok) out.push(...r.ok);
    else if (r.conflict) conflictLines.push(r.conflict.aIndex + 1);
  }
  if (conflictLines.length) return { ok: false, conflictLines };
  return { ok: true, text: out.join("") };
}
