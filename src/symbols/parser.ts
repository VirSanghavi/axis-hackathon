import path from "node:path";
import { Language, Parser, type Node } from "web-tree-sitter";
import { GRAMMAR_WASM, RUNTIME_WASM } from "./assets.ts";
import { recoverSymbols, structuredSymbols } from "./fallback.ts";

/**
 * Function-level symbol extraction. Turns a source file into a flat list of
 * lockable symbols (functions, methods, classes, types, top-level constants)
 * with exact line ranges, using tree-sitter grammars for 14 languages.
 *
 * Names are dotted and qualified by their container: `AuthService.login`,
 * `Server.handle` (Go method on *Server), `Repo.find` (Rust impl Repo). That
 * name is what agents lock, e.g. `src/auth.ts#AuthService.login`.
 *
 * Markdown, JSON, YAML and TOML have no grammar here but still split into
 * sections and keys (fallback.ts); anything else is one whole-file unit.
 */

export type SymbolKind =
  | "function"
  | "method"
  | "class"
  | "type"
  | "variable"
  | "module"
  /** Markdown heading, TOML table. */
  | "section"
  /** JSON or YAML key. */
  | "key";

export interface CodeSymbol {
  /** Qualified dotted name; duplicates get `@2`, `@3` in source order. */
  name: string;
  kind: SymbolKind;
  /** 0-based first line, including leading doc comments / decorators. */
  start: number;
  /** 0-based last line, inclusive. */
  end: number;
  depth: number;
}

/** Pseudo-symbol for top-level code that belongs to no symbol: imports, glue, side effects. */
export const TOP = "(top)";

interface DefSpec {
  kind: SymbolKind;
  /** Descend into this node's body for nested symbols (classes, namespaces, modules). */
  container?: boolean;
  /** A container that is not itself lockable (Rust `impl S`): children are qualified by its name only. */
  transparent?: boolean;
  /** Only a symbol when at the top level (e.g. a plain `const x = 1`). */
  topLevelOnly?: boolean;
}

interface LangSpec {
  grammar: keyof typeof GRAMMAR_WASM;
  defs: Record<string, DefSpec>;
  /** Wrapper nodes whose range belongs to the wrapped def: `export ...`, decorated Python defs. */
  wrappers?: string[];
  /** Sibling node types folded into the following symbol's range. */
  leading?: string[];
}

const COMMENTS = ["comment", "line_comment", "block_comment", "doc_comment"];

const TS_DEFS: Record<string, DefSpec> = {
  function_declaration: { kind: "function" },
  generator_function_declaration: { kind: "function" },
  class_declaration: { kind: "class", container: true },
  abstract_class_declaration: { kind: "class", container: true },
  method_definition: { kind: "method" },
  public_field_definition: { kind: "variable" },
  field_definition: { kind: "variable" },
  interface_declaration: { kind: "type" },
  type_alias_declaration: { kind: "type" },
  enum_declaration: { kind: "type" },
  internal_module: { kind: "module", container: true },
  module: { kind: "module", container: true },
  lexical_declaration: { kind: "variable", topLevelOnly: true },
  variable_declaration: { kind: "variable", topLevelOnly: true },
};

const LANGS: Record<string, LangSpec> = {
  typescript: {
    grammar: "typescript",
    defs: TS_DEFS,
    wrappers: ["export_statement"],
    leading: [...COMMENTS, "decorator"],
  },
  tsx: {
    grammar: "tsx",
    defs: TS_DEFS,
    wrappers: ["export_statement"],
    leading: [...COMMENTS, "decorator"],
  },
  javascript: {
    grammar: "javascript",
    defs: TS_DEFS,
    wrappers: ["export_statement"],
    leading: [...COMMENTS, "decorator"],
  },
  python: {
    grammar: "python",
    defs: {
      function_definition: { kind: "function" },
      class_definition: { kind: "class", container: true },
      expression_statement: { kind: "variable", topLevelOnly: true },
    },
    wrappers: ["decorated_definition"],
    leading: COMMENTS,
  },
  go: {
    grammar: "go",
    defs: {
      function_declaration: { kind: "function" },
      method_declaration: { kind: "method" },
      type_declaration: { kind: "type" },
      const_declaration: { kind: "variable", topLevelOnly: true },
      var_declaration: { kind: "variable", topLevelOnly: true },
    },
    leading: COMMENTS,
  },
  rust: {
    grammar: "rust",
    defs: {
      function_item: { kind: "function" },
      function_signature_item: { kind: "function" },
      struct_item: { kind: "type" },
      enum_item: { kind: "type" },
      union_item: { kind: "type" },
      type_item: { kind: "type" },
      trait_item: { kind: "type", container: true },
      impl_item: { kind: "class", container: true, transparent: true },
      mod_item: { kind: "module", container: true },
      const_item: { kind: "variable" },
      static_item: { kind: "variable" },
      macro_definition: { kind: "function" },
    },
    leading: [...COMMENTS, "attribute_item"],
  },
  java: {
    grammar: "java",
    defs: {
      class_declaration: { kind: "class", container: true },
      interface_declaration: { kind: "type", container: true },
      enum_declaration: { kind: "type", container: true },
      record_declaration: { kind: "class", container: true },
      method_declaration: { kind: "method" },
      constructor_declaration: { kind: "method" },
    },
    leading: COMMENTS,
  },
  kotlin: {
    grammar: "kotlin",
    defs: {
      class_declaration: { kind: "class", container: true },
      object_declaration: { kind: "class", container: true },
      function_declaration: { kind: "function" },
      property_declaration: { kind: "variable", topLevelOnly: true },
    },
    leading: COMMENTS,
  },
  csharp: {
    grammar: "csharp",
    defs: {
      namespace_declaration: { kind: "module", container: true, transparent: true },
      class_declaration: { kind: "class", container: true },
      struct_declaration: { kind: "class", container: true },
      interface_declaration: { kind: "type", container: true },
      record_declaration: { kind: "class", container: true },
      enum_declaration: { kind: "type" },
      method_declaration: { kind: "method" },
      constructor_declaration: { kind: "method" },
      property_declaration: { kind: "variable" },
    },
    leading: COMMENTS,
  },
  ruby: {
    grammar: "ruby",
    defs: {
      module: { kind: "module", container: true },
      class: { kind: "class", container: true },
      method: { kind: "method" },
      singleton_method: { kind: "method" },
    },
    leading: COMMENTS,
  },
  php: {
    grammar: "php",
    defs: {
      class_declaration: { kind: "class", container: true },
      interface_declaration: { kind: "type", container: true },
      trait_declaration: { kind: "type", container: true },
      method_declaration: { kind: "method" },
      function_definition: { kind: "function" },
    },
    leading: COMMENTS,
  },
  swift: {
    grammar: "swift",
    defs: {
      class_declaration: { kind: "class", container: true },
      protocol_declaration: { kind: "type", container: true },
      function_declaration: { kind: "function" },
    },
    leading: COMMENTS,
  },
  c: {
    grammar: "c",
    defs: {
      function_definition: { kind: "function" },
      struct_specifier: { kind: "type" },
      enum_specifier: { kind: "type" },
      type_definition: { kind: "type" },
    },
    leading: COMMENTS,
  },
  cpp: {
    grammar: "cpp",
    defs: {
      function_definition: { kind: "function" },
      class_specifier: { kind: "class", container: true },
      struct_specifier: { kind: "class", container: true },
      namespace_definition: { kind: "module", container: true, transparent: true },
      enum_specifier: { kind: "type" },
      template_declaration: { kind: "function" },
    },
    leading: COMMENTS,
  },
};

const EXTENSIONS: Record<string, string> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascript",
  ".py": "python",
  ".pyi": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".cs": "csharp",
  ".rb": "ruby",
  ".php": "php",
  ".swift": "swift",
  ".c": "c",
  ".h": "c",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".hh": "cpp",
};

export function languageFor(filePath: string): string | null {
  return EXTENSIONS[path.extname(filePath).toLowerCase()] ?? null;
}

let initPromise: Promise<void> | null = null;
const languages = new Map<string, Promise<Language>>();

async function parserFor(lang: string): Promise<Parser> {
  initPromise ??= Parser.init({ locateFile: () => RUNTIME_WASM });
  await initPromise;
  const spec = LANGS[lang]!;
  let l = languages.get(spec.grammar);
  if (!l) {
    l = Bun.file(GRAMMAR_WASM[spec.grammar]!)
      .bytes()
      .then((bytes) => Language.load(bytes));
    languages.set(spec.grammar, l);
  }
  const parser = new Parser();
  parser.setLanguage(await l);
  return parser;
}

export interface ParsedFile {
  language: string | null;
  symbols: CodeSymbol[];
  /** True when the grammar reported syntax errors. Symbols are still best-effort. */
  hasErrors: boolean;
}

/**
 * Extract symbols. Files with no grammar fall back to structural units
 * (Markdown sections, JSON/YAML keys, TOML tables); anything else returns
 * `language: null` and no symbols: the whole file is the unit.
 */
export async function parseSymbols(filePath: string, source: string): Promise<ParsedFile> {
  const language = languageFor(filePath);
  if (!language)
    return structuredSymbols(filePath, source) ?? { language: null, symbols: [], hasErrors: false };
  const parser = await parserFor(language);
  const tree = parser.parse(source);
  if (!tree)
    return { language, symbols: dedupe(recoverSymbols(language, source, [])), hasErrors: true };
  try {
    const spec = LANGS[language]!;
    const out: CodeSymbol[] = [];
    walk(tree.rootNode, spec, "", 0, true, out);
    // A broken parse can drop or swallow symbols; recover them so the file still has usable units.
    const hasErrors = tree.rootNode.hasError;
    const symbols = dedupe(hasErrors ? recoverSymbols(language, source, out) : out);
    return {
      language,
      symbols: symbols.sort((a, b) => a.start - b.start || a.depth - b.depth),
      hasErrors,
    };
  } finally {
    tree.delete();
    parser.delete();
  }
}

function walk(
  node: Node,
  spec: LangSpec,
  prefix: string,
  depth: number,
  topLevel: boolean,
  out: CodeSymbol[]
): void {
  for (const child of node.namedChildren) {
    if (!child) continue;
    let def: Node = child;
    let rangeNode: Node = child;
    if (spec.wrappers?.includes(child.type)) {
      const inner =
        child.childForFieldName("declaration") ??
        child.childForFieldName("definition") ??
        child.namedChildren.find((c) => c && spec.defs[c.type]);
      if (inner) def = inner;
      else if (child.type === "export_statement" && child.childForFieldName("value")) {
        // `export default function () {}` / `export default <expr>`
        emit(out, prefix + "default", "variable", child, spec, depth);
        continue;
      }
    }
    const d = spec.defs[def.type];
    if (!d || (d.topLevelOnly && !topLevel)) {
      // Not a symbol itself; look inside structural nodes (e.g. TS `namespace` sits in an expression_statement).
      if (!isBody(child))
        walk(child, spec, prefix, depth, topLevel && isTransparentStatement(child), out);
      continue;
    }

    const names = namesOf(def, spec);
    if (names.length === 0) {
      if (d.container) walk(bodyOf(def), spec, prefix, depth, false, out);
      continue;
    }
    if (d.transparent) {
      // Qualify children by this container's name but do not emit it as a lockable symbol.
      walk(bodyOf(def), spec, `${prefix}${names[0]}.`, depth, false, out);
      continue;
    }
    for (const name of names) {
      const qualified =
        def.type === "method_declaration" && spec.grammar === "go" ? name : prefix + name;
      emit(out, qualified, d.kind, rangeNode, spec, depth);
    }
    if (d.container && names.length === 1)
      walk(bodyOf(def), spec, `${prefix}${names[0]}.`, depth + 1, false, out);
  }
}

function emit(
  out: CodeSymbol[],
  name: string,
  kind: SymbolKind,
  node: Node,
  spec: LangSpec,
  depth: number
): void {
  let start = node.startPosition.row;
  // Fold contiguous doc comments / decorators / attributes above the symbol into it.
  let prev = node.previousNamedSibling;
  while (prev && spec.leading?.includes(prev.type) && lastRow(prev) >= start - 1) {
    start = prev.startPosition.row;
    prev = prev.previousNamedSibling;
  }
  out.push({ name: name.replace(/::/g, "."), kind, start, end: lastRow(node), depth });
}

function lastRow(n: Node): number {
  const end = n.endPosition;
  return end.column === 0 && end.row > n.startPosition.row ? end.row - 1 : end.row;
}

function bodyOf(n: Node): Node {
  return (
    n.childForFieldName("body") ??
    n.namedChildren.find((c) => c && /body|declaration_list|block/.test(c.type)) ??
    n
  );
}

function isBody(n: Node): boolean {
  return /^(statement_block|block|compound_statement|function_body|constructor_body)$/.test(n.type);
}

/** Top-level statements whose children are still top-level (TS namespace wrapper, Python if __name__ blocks are not). */
function isTransparentStatement(n: Node): boolean {
  return n.type === "expression_statement" || n.type === "ambient_declaration";
}

function namesOf(def: Node, spec: LangSpec): string[] {
  const t = def.type;
  // Declarations that can declare several names: `const a = 1, b = 2`, Go `var (...)`.
  if (t === "lexical_declaration" || t === "variable_declaration") {
    return def.namedChildren
      .filter((c) => c?.type === "variable_declarator")
      .map((c) => c!.childForFieldName("name")?.text ?? "")
      .filter(isIdent);
  }
  if (spec.grammar === "python" && t === "expression_statement") {
    const a = def.namedChildren[0];
    if (a?.type === "assignment") {
      const left = a.childForFieldName("left");
      return left?.type === "identifier" ? [left.text] : [];
    }
    return [];
  }
  if (t === "const_declaration" || t === "var_declaration") {
    const specs = def.descendantsOfType(t === "const_declaration" ? "const_spec" : "var_spec");
    return specs.flatMap((s) =>
      s ? s.namedChildren.filter((c) => c?.type === "identifier").map((c) => c!.text) : []
    );
  }
  if (t === "type_declaration") {
    return def.namedChildren
      .filter((c) => c && (c.type === "type_spec" || c.type === "type_alias"))
      .map((c) => c!.childForFieldName("name")?.text ?? "")
      .filter(Boolean);
  }
  if (t === "method_declaration" && spec.grammar === "go") {
    const recv = def.childForFieldName("receiver");
    const typeName = recv?.descendantsOfType("type_identifier")[0]?.text;
    const name = def.childForFieldName("name")?.text;
    return name ? [typeName ? `${typeName}.${name}` : name] : [];
  }
  if (t === "impl_item") {
    const ty = def.childForFieldName("type");
    const base = ty?.type === "generic_type" ? ty.childForFieldName("type") : ty;
    return base ? [base.text] : [];
  }
  if (t === "singleton_method") {
    const name = def.childForFieldName("name")?.text;
    return name ? [`self.${name}`] : [];
  }
  if (t === "template_declaration") {
    const inner = def.namedChildren.find(
      (c) => c && (c.type === "function_definition" || c.type === "class_specifier")
    );
    return inner ? namesOf(inner, spec) : [];
  }
  if (t === "type_definition") {
    const d = def.childForFieldName("declarator");
    return d ? [d.text] : [];
  }

  const named = def.childForFieldName("name");
  if (named) return [named.text];
  const declarator = def.childForFieldName("declarator");
  if (declarator) {
    const n = declaratorName(declarator);
    return n ? [n] : [];
  }
  // Grammars without field names (Kotlin): first identifier-like child.
  const id = def.namedChildren.find(
    (c) => c && /^(simple_identifier|type_identifier|identifier)$/.test(c.type)
  );
  return id ? [id.text] : [];
}

function declaratorName(n: Node): string | null {
  let cur: Node | null = n;
  for (let i = 0; cur && i < 8; i++) {
    if (
      /^(identifier|field_identifier|qualified_identifier|destructor_name|operator_name)$/.test(
        cur.type
      )
    )
      return cur.text;
    cur = cur.childForFieldName("declarator") ?? cur.namedChildren[0] ?? null;
  }
  return null;
}

function isIdent(s: string): boolean {
  return /^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(s);
}

function dedupe(out: CodeSymbol[]): CodeSymbol[] {
  const counts = new Map<string, number>();
  for (const s of out) {
    const n = (counts.get(s.name) ?? 0) + 1;
    counts.set(s.name, n);
    if (n > 1) s.name = `${s.name}@${n}`;
  }
  return out;
}

/** Innermost symbol containing 0-based `line`, or null for top-level code. */
export function innermostAt(symbols: CodeSymbol[], line: number): CodeSymbol | null {
  let best: CodeSymbol | null = null;
  for (const s of symbols) {
    if (
      s.start <= line &&
      line <= s.end &&
      (!best || s.depth > best.depth || (s.depth === best.depth && s.start >= best.start))
    )
      best = s;
  }
  return best;
}

export function findSymbol(symbols: CodeSymbol[], name: string): CodeSymbol | null {
  return symbols.find((s) => s.name === name) ?? null;
}
