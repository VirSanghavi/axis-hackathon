import type { Relation, Target } from "./types.ts";

/** `src/a.ts#Foo.bar` -> { path: "src/a.ts", symbol: "Foo.bar" }. A bare path locks the whole file. */
export function parseTarget(raw: string): Target {
  const s = raw.trim();
  const hash = s.indexOf("#");
  if (hash === -1) return { path: stripSlashes(s), symbol: "" };
  return { path: stripSlashes(s.slice(0, hash)), symbol: s.slice(hash + 1).trim() };
}

export function formatTarget(t: Target): string {
  return t.symbol ? `${t.path}#${t.symbol}` : t.path;
}

function stripSlashes(p: string): string {
  return p.replace(/^\.\/+/, "").replace(/\/+$/, "");
}

/**
 * How lock `held` relates to requested target `want`, or null when they do not
 * overlap. Symbols nest by dotted path: `Auth` encloses `Auth.login`, and the
 * whole file (symbol "") encloses every symbol in it.
 */
export function relation(want: Target, held: Target): Relation | null {
  if (want.path !== held.path) return null;
  if (want.symbol === held.symbol) return "same";
  if (encloses(held.symbol, want.symbol)) return "encloses";
  if (encloses(want.symbol, held.symbol)) return "within";
  return null;
}

/** True when symbol `outer` strictly contains symbol `inner`. "" is the whole file. */
export function encloses(outer: string, inner: string): boolean {
  if (outer === inner) return false;
  if (outer === "") return true;
  return inner.startsWith(outer + ".");
}

/** A lock on `held` authorizes changes to `target` when it is the same or encloses it. */
export function covers(held: Target, target: Target): boolean {
  if (held.path !== target.path) return false;
  return held.symbol === target.symbol || encloses(held.symbol, target.symbol);
}
