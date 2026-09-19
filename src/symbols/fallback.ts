import path from "node:path";
import type { CodeSymbol, SymbolKind } from "./parser.ts";

/**
 * Lockable units where tree-sitter cannot give them: structured text formats
 * with no grammar (Markdown, JSON, YAML, TOML), and code whose parse is broken.
 *
 * Units follow the same contract as grammar symbols: 0-based inclusive line
 * ranges, nested units inside their parent's range, trailing blank lines left
 * out (so the gap between two units is nobody's), `@n` for duplicates in
 * source order, and dotted names only where there is real nesting. Everything
 * outside every unit is `(top)`.
 */

const FORMATS: Record<string, string> = {
  ".md": "markdown",
  ".mdx": "markdown",
  ".markdown": "markdown",
  ".json": "json",
  ".jsonc": "json",
  ".yml": "yaml",
  ".yaml": "yaml",
  ".toml": "toml",
};

export function structuredFormat(language: string | null): boolean {
  return !!language && Object.values(FORMATS).includes(language);
}

/** Units for a structured text file, or null when the format is unknown or has none (whole-file). */
export function structuredSymbols(
  filePath: string,
  source: string
): { language: string; symbols: CodeSymbol[]; hasErrors: boolean } | null {
  const language = FORMATS[path.extname(filePath).toLowerCase()];
  if (!language) return null;
  const lines = textLines(source);
  const { symbols, hasErrors } =
    language === "markdown"
      ? { symbols: markdownUnits(lines), hasErrors: false }
      : language === "json"
        ? jsonUnits(source)
        : language === "yaml"
          ? { symbols: yamlUnits(lines), hasErrors: false }
          : { symbols: tomlUnits(lines), hasErrors: false };
  if (symbols.length === 0) return null;
  for (const s of symbols) s.end = trimEnd(lines, s.start, s.end);
  return { language, symbols, hasErrors };
}

/**
 * Map free text (a heading, a key) onto the hub's symbol alphabet. `.` means
 * nesting and `@` means duplicate, so both are reserved and become `_` along
 * with spaces and other punctuation: "Getting started" -> "Getting_started".
 */
export function unitName(text: string): string {
  const n = text
    .normalize("NFC")
    .replace(/[^\p{L}\p{N}_$<>:()\-[\]]+/gu, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
  // "(top)" is the pseudo-symbol for unowned lines (TOP in parser.ts); a heading may not claim it.
  return n === "" ? "_" : n === "(top)" ? "top" : n;
}

/** Source lines without terminators, counted exactly like `splitLines` in coverage.ts. */
function textLines(source: string): string[] {
  const lines = source.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function isBlank(line: string | undefined): boolean {
  return !line || line.trim() === "";
}

function trimEnd(lines: string[], start: number, end: number): number {
  while (end > start && isBlank(lines[end])) end--;
  return end;
}

/** In-order `@n` suffixes, applied as units are found so children nest under the deduplicated parent. */
function uniqueNames(): (name: string) => string {
  const counts = new Map<string, number>();
  return (name) => {
    const n = (counts.get(name) ?? 0) + 1;
    counts.set(name, n);
    return n > 1 ? `${name}@${n}` : name;
  };
}

function unit(name: string, kind: SymbolKind, start: number, end: number, depth = 0): CodeSymbol {
  return { name, kind, start, end, depth };
}

// ---------------------------------------------------------------- Markdown

/** Headings (ATX and setext) outside code fences, HTML comments and front matter; nested by level. */
function markdownUnits(lines: string[]): CodeSymbol[] {
  const heads: { line: number; level: number; text: string }[] = [];
  let i = 0;
  const front = /^(---|\+\+\+)\s*$/.exec(lines[0] ?? "");
  if (front) {
    const close = front[1] === "+++" ? /^\+\+\+\s*$/ : /^(---|\.\.\.)\s*$/;
    const end = lines.findIndex((l, j) => j > 0 && close.test(l));
    if (end > 0) i = end + 1;
  }
  let fence: { ch: string; len: number } | null = null;
  let comment = false;
  let para = -1; // first line of the paragraph a setext underline would turn into a heading
  for (; i < lines.length; i++) {
    const l = lines[i]!;
    if (fence) {
      const c = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(l);
      if (c && c[1]![0] === fence.ch && c[1]!.length >= fence.len) fence = null;
      continue;
    }
    if (comment) {
      if (l.includes("-->")) comment = false;
      continue;
    }
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(l);
    if (f) {
      fence = { ch: f[1]![0]!, len: f[1]!.length };
      para = -1;
      continue;
    }
    if (/^ {0,3}<!--/.test(l) && !l.includes("-->")) {
      comment = true;
      para = -1;
      continue;
    }
    const atx = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/.exec(l);
    if (atx) {
      heads.push({ line: i, level: atx[1]!.length, text: atx[2] ?? "" });
      para = -1;
      continue;
    }
    const setext = /^ {0,3}(=+|-+)[ \t]*$/.exec(l);
    if (setext && para >= 0) {
      const text = lines
        .slice(para, i)
        .map((s) => s.trim())
        .join(" ");
      heads.push({ line: para, level: setext[1]![0] === "=" ? 1 : 2, text });
      para = -1;
      continue;
    }
    // Only plain paragraph text can sit above a setext underline; lists, quotes, tables and code cannot.
    const plain = !isBlank(l) && !/^( {4}|\t| {0,3}([-*+][ \t]|\d+[.)][ \t]|[>|<]))/.test(l);
    para = plain ? (para >= 0 ? para : i) : -1;
  }

  // A leading `#` is the document's title, not a parent: it owns only the
  // intro, so its sections stay top-level, keep their names when the title
  // changes, and editing the intro does not lock the whole file. Decided by
  // the first heading alone, so adding a heading later never renames the rest.
  const title = heads[0]?.level === 1;
  const out: CodeSymbol[] = [];
  const unique = uniqueNames();
  const stack: { level: number; name: string }[] = [];
  heads.forEach((h, k) => {
    while (stack.length && stack.at(-1)!.level >= h.level) stack.pop();
    const parent = stack.at(-1);
    const name = unique((parent ? parent.name + "." : "") + unitName(headingText(h.text)));
    const isTitle = title && k === 0;
    const next = heads.slice(k + 1).find((o) => isTitle || o.level <= h.level);
    out.push(unit(name, "section", h.line, next ? next.line - 1 : lines.length - 1, stack.length));
    if (!isTitle) stack.push({ level: h.level, name });
  });
  return out;
}

/** The visible text of a heading: link and image text kept, markup dropped. */
function headingText(raw: string): string {
  return raw
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/!?\[([^\]]*)\]\[[^\]]*\]/g, "$1")
    .replace(/<\/?[A-Za-z][\w-]*(\s[^<>]*)?\/?>/g, "") // real tags only: `Map<K, V>` stays
    .replace(/[`*~]/g, "");
}

// ---------------------------------------------------------------- JSON

/**
 * Top-level keys, plus one level inside multi-line object values
 * (`scripts.test`), which is where parallel edits to package.json and
 * friends actually land. Tolerates comments, trailing commas and a truncated
 * tail: units found before a syntax error are kept.
 */
function jsonUnits(src: string): { symbols: CodeSymbol[]; hasErrors: boolean } {
  const out: CodeSymbol[] = [];
  const unique = uniqueNames();
  let i = 0;
  let line = 0;
  const stop = new Error("json");
  const fail = (): never => {
    throw stop;
  };

  const ws = () => {
    for (;;) {
      const c = src[i];
      if (c === "\n") {
        line++;
        i++;
      } else if (c === " " || c === "\t" || c === "\r" || c === "\uFEFF") i++;
      else if (c === "/" && src[i + 1] === "/") {
        while (i < src.length && src[i] !== "\n") i++;
      } else if (c === "/" && src[i + 1] === "*") {
        const e = src.indexOf("*/", i + 2);
        const to = e < 0 ? src.length : e + 2;
        for (; i < to; i++) if (src[i] === "\n") line++;
      } else return;
    }
  };
  const str = (): string => {
    const s = i++;
    while (i < src.length && src[i] !== '"') {
      if (src[i] === "\\") i++;
      if (src[i] === "\n") line++;
      i++;
    }
    if (i >= src.length) fail();
    const raw = src.slice(s, ++i);
    try {
      return JSON.parse(raw) as string;
    } catch {
      return raw.slice(1, -1);
    }
  };
  const colon = () => {
    ws();
    if (src[i++] !== ":") fail();
    ws();
  };
  const value = (): void => {
    const c = src[i];
    if (c === '"') return void str();
    if (c === "{" || c === "[") {
      const close = c === "{" ? "}" : "]";
      i++;
      ws();
      while (src[i] !== close) {
        if (i >= src.length) fail();
        if (c === "{") {
          if (src[i] !== '"') fail();
          str();
          colon();
        }
        value();
        ws();
        if (src[i] === ",") {
          i++;
          ws();
        } else if (src[i] !== close) fail();
      }
      i++;
      return;
    }
    const s = i;
    while (i < src.length && !/[\s,\]}/]/.test(src[i]!)) i++;
    if (i === s) fail();
  };
  const members = (prefix: string, depth: number): void => {
    i++; // past "{"
    ws();
    while (src[i] !== "}") {
      if (src[i] !== '"') fail();
      const start = line;
      const name = unique(prefix + unitName(str()));
      colon();
      const sym = unit(name, "key", start, start, depth);
      const at = out.push(sym);
      if (depth === 0 && src[i] === "{") {
        members(name + ".", 1);
        // A one-line object is one unit: its members share the line anyway.
        if (line === start) out.length = at;
      } else value();
      sym.end = line;
      ws();
      if (src[i] === ",") {
        i++;
        ws();
      } else if (src[i] !== "}") fail();
    }
    i++;
  };

  try {
    ws();
    if (src[i] === "{") members("", 0);
    return { symbols: out, hasErrors: false };
  } catch (e) {
    if (e !== stop) throw e;
    return { symbols: out, hasErrors: true };
  }
}

// ---------------------------------------------------------------- YAML

/**
 * Top-level mapping keys (column 0). A comment block directly above a key
 * belongs to it, like a doc comment; `---` / `...` document markers and
 * `%` directives end the unit before them and belong to `(top)`.
 */
function yamlUnits(lines: string[]): CodeSymbol[] {
  const out: CodeSymbol[] = [];
  const unique = uniqueNames();
  const key =
    /^(?:"((?:[^"\\]|\\.)*)"|'((?:[^']|'')*)'|((?:[^\s\-?:,[\]{}#&*!|>'"%@`]|[-?:]\S)[^#]*?))[ \t]*:(?:[ \t]|$)/;
  let open: CodeSymbol | null = null;
  const close = (before: number) => {
    if (open) open.end = Math.max(open.start, before - 1);
    open = null;
  };
  lines.forEach((l, i) => {
    if (/^(---|\.\.\.)(\s|$)|^%/.test(l)) return close(i);
    const m = key.exec(l);
    if (!m) return;
    let start = i;
    while (start > 0 && /^#/.test(lines[start - 1]!)) start--;
    close(start);
    const text = m[1] ?? m[2]?.replace(/''/g, "'") ?? m[3]!;
    open = unit(unique(unitName(text)), "key", start, lines.length - 1);
    out.push(open);
  });
  return out;
}

// ---------------------------------------------------------------- TOML

/**
 * `[table]` and `[[array]]` headers, named by their dotted path so a lock on
 * `tool.poetry` covers `[tool.poetry.dependencies]` the way TOML nests them.
 * Brackets inside multi-line arrays and strings are not headers.
 */
function tomlUnits(lines: string[]): CodeSymbol[] {
  const out: CodeSymbol[] = [];
  const unique = uniqueNames();
  const latest = new Map<string, { name: string; depth: number }>(); // raw path -> latest table
  let depth = 0; // open value brackets
  let multi: string | null = null; // open """ or ''' string
  let prev: CodeSymbol | null = null;
  lines.forEach((l, i) => {
    if (depth === 0 && multi === null) {
      const h =
        /^\s*\[\[\s*(.+?)\s*\]\]\s*(#.*)?$/.exec(l) ?? /^\s*\[\s*(.+?)\s*\]\s*(#.*)?$/.exec(l);
      if (h) {
        const parts = tomlPath(h[1]!);
        const raw = parts.join(".");
        // `[fruit.variety]` after the second `[[fruit]]` belongs to `fruit@2`.
        let qualified = raw;
        let depth = 0;
        for (let k = parts.length - 1; k > 0; k--) {
          const parent = latest.get(parts.slice(0, k).join("."));
          if (parent === undefined) continue;
          qualified = [parent.name, ...parts.slice(k)].join(".");
          depth = parent.depth + 1;
          break;
        }
        const name = unique(qualified);
        latest.set(raw, { name, depth });
        let start = i;
        while (start > 0 && /^\s*#/.test(lines[start - 1]!)) start--;
        if (prev) prev.end = Math.max(prev.start, start - 1);
        prev = unit(name, "section", start, lines.length - 1, depth);
        out.push(prev);
        return;
      }
    }
    ({ depth, multi } = tomlScan(l, depth, multi));
  });
  return out;
}

/** Split `a."b.c".d` on the dots outside quotes, each part normalized. */
function tomlPath(header: string): string[] {
  const parts: string[] = [];
  let cur = "";
  let q: string | null = null;
  for (const c of header) {
    if (q) {
      if (c === q) q = null;
      else cur += c;
    } else if (c === '"' || c === "'") q = c;
    else if (c === ".") {
      parts.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  parts.push(cur.trim());
  return parts.map(unitName);
}

/** Carry bracket depth and open multi-line strings across one line of TOML values. */
function tomlScan(
  l: string,
  depth: number,
  multi: string | null
): { depth: number; multi: string | null } {
  for (let k = 0; k < l.length; k++) {
    if (multi) {
      if (multi === '"""' && l[k] === "\\") k++;
      else if (l.startsWith(multi, k)) {
        k += 2;
        multi = null;
      }
      continue;
    }
    const c = l[k]!;
    if (c === "#") break;
    if (l.startsWith('"""', k) || l.startsWith("'''", k)) {
      multi = l.slice(k, k + 3);
      k += 2;
    } else if (c === '"' || c === "'") {
      for (k++; k < l.length && l[k] !== c; k++) if (c === '"' && l[k] === "\\") k++;
    } else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") depth = Math.max(0, depth - 1);
  }
  return { depth, multi };
}

// ---------------------------------------------------------------- Broken code

const MODIFIERS =
  /^(?:(?:export|default|declare|pub(?:\([^)]*\))?|public|private|protected|internal|static|async|abstract|final|open|override|inline|extern|unsafe|sealed|data|virtual|partial|const(?=\s+fn\b))\s+)*/;
const DEF =
  /^(function\*?|def|fn|func|fun|class|struct|enum|interface|type|trait|mod|module|namespace|object|protocol|record|union|const|let|var|val|static)\s+(?:\(\s*[\p{L}_][\p{L}\p{N}_]*\s+\*?([\p{L}_][\p{L}\p{N}_]*)[^)]*\)\s*)?([\p{L}_$][\p{L}\p{N}_$]*)/u;
const KINDS: Record<string, SymbolKind> = {
  class: "class",
  struct: "class",
  object: "class",
  record: "class",
  enum: "type",
  interface: "type",
  type: "type",
  trait: "type",
  protocol: "type",
  union: "type",
  mod: "module",
  module: "module",
  namespace: "module",
  const: "variable",
  let: "variable",
  var: "variable",
  val: "variable",
  static: "variable",
};

interface Anchor {
  /** The definition line itself. */
  line: number;
  /** First line of its contiguous leading comments / decorators / attributes. */
  start: number;
  name?: string;
  kind?: SymbolKind;
}

/** A top-level definition read off one column-0 line, named the way the grammar would name it. */
function definitionAt(language: string, l: string): { name: string; kind: SymbolKind } | null {
  const bare = l.replace(MODIFIERS, "");
  const d = DEF.exec(bare);
  if (d) {
    if (d[2]) return { name: `${d[2]}.${d[3]}`, kind: "method" }; // Go receiver
    return { name: d[3]!, kind: KINDS[d[1]!] ?? "function" };
  }
  if (/^export\s+default\b/.test(l)) return { name: "default", kind: "variable" };
  if (language === "python") {
    const a = /^([\p{L}_][\p{L}\p{N}_]*)\s*(?::[^=]*)?=(?!=)/u.exec(l);
    if (a) return { name: a[1]!, kind: "variable" };
  }
  if (language === "c" || language === "cpp") {
    const f = /^[\p{L}_][\w<>,:]*[\s*&]+(?:[\w<>,:]+[\s*&]+)*([\p{L}_][\w:~]*)\s*\(/u.exec(l);
    if (f) return { name: f[1]!.replace(/::/g, "."), kind: "function" };
  }
  return null;
}

/**
 * Column-0 lines that start something new. In every supported language a
 * top-level definition starts in column 0, so these survive a broken parse:
 * closing brackets and `end` continue what came before, comments and
 * decorators lead into what comes after.
 */
function codeAnchors(language: string, lines: string[]): Anchor[] {
  const out: Anchor[] = [];
  const leading = (l: string) => /^(\/\/|\/\*|\*|@|#[\s[!]|#$|--)/.test(l);
  lines.forEach((l, i) => {
    if (isBlank(l) || /^\s/.test(l) || /^[}\])]|^end\b/.test(l) || leading(l)) return;
    let start = i;
    while (start > 0 && leading(lines[start - 1]!)) start--;
    out.push({ line: i, start, ...(definitionAt(language, l) ?? {}) });
  });
  return out;
}

/**
 * Best-effort units for code the grammar could not parse cleanly. Tree-sitter
 * symbols are kept, but a top-level one that runs over the next column-0
 * definition (an unclosed brace swallowing the rest of the file) is cut short
 * there, and definitions no symbol covers become units of their own. Names
 * match what a clean parse gives, so locks keep meaning the same thing while
 * the file is mid-edit.
 */
export function recoverSymbols(
  language: string,
  source: string,
  symbols: CodeSymbol[]
): CodeSymbol[] {
  const lines = textLines(source);
  const anchors = codeAnchors(language, lines);
  let kept = symbols;
  for (const s of symbols.filter((x) => x.depth === 0)) {
    const inside = anchors.filter((a) => a.line >= s.start && a.line <= s.end);
    const foreign = inside.slice(1).find((a) => a.name);
    if (!foreign) continue;
    const end = trimEnd(lines, s.start, foreign.start - 1);
    const from = s.start;
    const to = s.end;
    kept = kept
      .filter((x) => !(x.start > end && x.start <= to && x.start >= from))
      .map((x) => (x.start >= from && x.start <= end ? { ...x, end: Math.min(x.end, end) } : x));
  }
  const covered = (line: number) => kept.some((s) => s.start <= line && line <= s.end);
  const stops = [...anchors.map((a) => a.start), ...kept.map((s) => s.start)];
  const added: CodeSymbol[] = [];
  for (const a of anchors) {
    if (!a.name || covered(a.line)) continue;
    let start = a.start;
    while (start < a.line && covered(start)) start++;
    const next = Math.min(...stops.filter((x) => x > a.line), lines.length);
    added.push(unit(a.name, a.kind!, start, trimEnd(lines, a.line, next - 1)));
  }
  return [...kept, ...added].sort((x, y) => x.start - y.start || x.depth - y.depth);
}
