import { describe, expect, test } from "bun:test";
import { spliceSymbol } from "../../src/enforce/gateway.ts";
import { validateTargets } from "../../src/hub/hub.ts";
import { merge3, touchedTargets } from "../../src/symbols/coverage.ts";
import { unitName } from "../../src/symbols/fallback.ts";
import { languageFor, parseSymbols } from "../../src/symbols/parser.ts";

/**
 * Files with no tree-sitter grammar still split into lockable units, and code
 * that fails to parse still has usable ones. Everything goes through the real
 * lock path: parseSymbols -> touchedTargets -> merge3 / spliceSymbol.
 */

const units = async (file: string, src: string) =>
  (await parseSymbols(file, src)).symbols.map((s) => `${s.name} ${s.start}-${s.end}`);
const names = async (file: string, src: string) =>
  (await parseSymbols(file, src)).symbols.map((s) => s.name);
const touched = async (file: string, base: string, next: string) =>
  (await touchedTargets(file, base, next)).targets.map((t) => t.symbol).sort();

const README = `# Axis

Locks for agents.

## Install

Run the script.

### Linux

apt install axis

### macOS

brew install axis

## Usage

\`\`\`sh
# not a heading
axis init
\`\`\`

## FAQ

### Why?

Because.
`;

describe("markdown", () => {
  test("headings nest by level; a leading # is the title and owns only the intro", async () => {
    expect(await units("README.md", README)).toEqual([
      "Axis 0-2",
      "Install 4-14",
      "Install.Linux 8-10",
      "Install.macOS 12-14",
      "Usage 16-21",
      "FAQ 23-27",
      "FAQ.Why 25-27",
    ]);
    const p = await parseSymbols("README.md", README);
    expect(p.language).toBe("markdown");
    expect(new Set(p.symbols.map((s) => s.kind))).toEqual(new Set(["section"]));
  });

  test("without a title, sections nest under earlier #s and text before them is (top)", async () => {
    const md = "intro\n\n# A\n\n## B\n\nb\n\n# C\n";
    expect(await units("doc.md", "## Z\n" + md)).toEqual(["Z 0-1", "A 3-7", "A.B 5-7", "C 9-9"]);
    expect(await touched("doc.md", "text\n\n## A\n\na\n", "TEXT\n\n## A\n\na\n")).toEqual([
      "(top)",
    ]);
  });

  test("names map onto the hub's symbol alphabet", async () => {
    expect(unitName("Getting started")).toBe("Getting_started");
    expect(unitName("v1.2 @ scale")).toBe("v1_2_scale");
    expect(unitName("🚀 Quick start!")).toBe("Quick_start");
    expect(unitName("(top)")).toBe("top");
    expect(unitName("???")).toBe("_");
    const md =
      "## [Docs](https://x.y) and `code`\n## **Bold** _it_\n## C# notes ##\n## Café <br> déjà\n## Map<K, V>\n##\n";
    const got = await names("a.md", md);
    expect(got).toEqual(["Docs_and_code", "Bold_it", "C_notes", "Café_déjà", "Map<K_V>", "_"]);
    const { errors } = validateTargets(got.map((n) => `a.md#${n}`));
    expect(errors).toEqual([]);
  });

  test("duplicates get @n, and children nest under the deduplicated parent", async () => {
    const md = "## Setup\n### Linux\n## Setup\n### Linux\n## Linux\n";
    expect(await names("a.md", md)).toEqual([
      "Setup",
      "Setup.Linux",
      "Setup@2",
      "Setup@2.Linux",
      "Linux",
    ]);
  });

  test("# inside fences, HTML comments and front matter is not a heading; setext is", async () => {
    const md = [
      "---",
      "title: x",
      "# not: a heading",
      "---",
      "~~~~",
      "# fenced",
      "```",
      "# still fenced",
      "~~~~",
      "<!--",
      "# commented",
      "-->",
      "Real",
      "title",
      "====",
      "",
      "Sub",
      "---",
      "- list item",
      "---",
      "    # indented code",
      "#hashtag",
    ].join("\n");
    // "Real title" is the first heading and an h1, so it is the title: its intro only.
    expect(await units("a.md", md)).toEqual(["Real_title 12-14", "Sub 16-21"]);
  });

  test("a file with no headings stays one unit", async () => {
    expect((await parseSymbols("notes.md", "just text\n")).language).toBeNull();
    expect(await touched("notes.md", "a\n", "b\n")).toEqual([""]);
    expect(languageFor("README.md")).toBeNull();
  });

  test("editing inside one section touches only that section", async () => {
    expect(await touched("README.md", README, README.replace("brew", "port"))).toEqual([
      "Install.macOS",
    ]);
    expect(await touched("README.md", README, README.replace("Run the", "Run this"))).toEqual([
      "Install",
    ]);
    expect(await touched("README.md", README, README.replace("Locks for", "Locking for"))).toEqual([
      "Axis",
    ]);
    // A code fence's `#` line is content of its section.
    expect(await touched("README.md", README, README.replace("# not a", "# still not a"))).toEqual([
      "Usage",
    ]);
  });

  test("adding a section touches only the new one; blank lines touch nothing", async () => {
    const added = README.replace("## Usage", "### Windows\n\nwinget install axis\n\n## Usage");
    expect(await touched("README.md", README, added)).toEqual(["Install.Windows"]);
    expect(await touched("README.md", README, README.replace("Because.", "\n\nBecause."))).toEqual(
      []
    );
  });

  test("two agents' edits to different sections merge", async () => {
    const ana = README.replace("apt install axis", "apt-get install axis");
    const ben = README.replace("Because.", "Because it works.");
    expect(await touched("README.md", README, ana)).toEqual(["Install.Linux"]);
    expect(await touched("README.md", README, ben)).toEqual(["FAQ.Why"]);
    const m = merge3(README, ana, ben);
    expect(m.ok).toBe(true);
    if (m.ok) {
      expect(m.text).toContain("apt-get install axis");
      expect(m.text).toContain("Because it works.");
    }
  });

  test("spliceSymbol replaces a section, appends into a parent or at the end, and refuses headless content", async () => {
    const replaced = await spliceSymbol("README.md", README, "Usage", "## Usage\n\naxis up");
    expect(replaced).toContain("## Usage\n\naxis up\n\n## FAQ");
    expect(await names("README.md", replaced)).toContain("Usage");

    const nested = await spliceSymbol(
      "README.md",
      README,
      "Install.Windows",
      "### Windows\n\nwinget"
    );
    expect(nested).toContain("brew install axis\n\n### Windows\n\nwinget\n\n## Usage");
    expect(await names("README.md", nested)).toContain("Install.Windows");

    const top = await spliceSymbol("README.md", README, "License", "## License\n\nMIT");
    expect(top.endsWith("Because.\n\n## License\n\nMIT\n")).toBe(true);

    await expect(spliceSymbol("README.md", README, "License", "MIT")).rejects.toThrow(
      /would not create License/
    );
    await expect(
      spliceSymbol("README.md", README, "Install.Windows", "## Windows")
    ).rejects.toThrow(/reads as Windows/);
    await expect(spliceSymbol("README.md", README, "Nope.X", "### X")).rejects.toThrow(/No Nope/);
  });
});

const PKG = `{
  "name": "axis",
  "description": "braces } { and \\"quotes\\" in strings",
  "bin": { "axis": "src/cli/main.ts" },
  "scripts": {
    "test": "bun test",
    "lint": "prettier --check",
    "build:edge": "bun scripts/build-edge.ts"
  },
  "dependencies": {
    "@types/bun": "latest",
    "node-diff3": "^3.1.2"
  },
  "files": [
    "src"
  ]
}
`;

describe("json", () => {
  test("top-level keys, one level into multi-line objects, strings with braces and escapes", async () => {
    expect(await units("package.json", PKG)).toEqual([
      "name 1-1",
      "description 2-2",
      "bin 3-3",
      "scripts 4-8",
      "scripts.test 5-5",
      "scripts.lint 6-6",
      "scripts.build:edge 7-7",
      "dependencies 9-12",
      "dependencies.types_bun 10-10",
      "dependencies.node-diff3 11-11",
      "files 13-15",
    ]);
    const p = await parseSymbols("package.json", PKG);
    expect(p.hasErrors).toBe(false);
    expect(validateTargets(p.symbols.map((s) => `package.json#${s.name}`)).errors).toEqual([]);
  });

  test("CRLF, comments, trailing commas and duplicate keys", async () => {
    const jsonc =
      '{\r\n  // why\r\n  "a": 1, /* x\r\n  y */\r\n  "a": {\r\n    "b": [1,\r\n 2],\r\n  },\r\n}\r\n';
    expect(await units("tsconfig.json", jsonc)).toEqual(["a 2-2", "a@2 4-7", "a@2.b 5-6"]);
  });

  test("a non-object root or an empty object is one unit; a broken tail keeps earlier keys", async () => {
    expect((await parseSymbols("a.json", "[1, 2]\n")).language).toBeNull();
    expect((await parseSymbols("a.json", "{}\n")).language).toBeNull();
    const broken = await parseSymbols("a.json", '{\n  "a": 1,\n  "b": {\n    "c": tru\n');
    expect(broken.language).toBe("json");
    expect(broken.hasErrors).toBe(true);
    expect(broken.symbols.map((s) => s.name)).toContain("a");
  });

  test("editing one script touches only that script; appending a key touches its neighbor too", async () => {
    expect(
      await touched("package.json", PKG, PKG.replace('"bun test"', '"bun test --bail"'))
    ).toEqual(["scripts.test"]);
    expect(
      await touched(
        "package.json",
        PKG,
        PKG.replace('"node-diff3": "^3.1.2"', '"node-diff3": "^3.1.2",\n    "zod": "^4"')
      )
    ).toEqual(["dependencies.node-diff3", "dependencies.zod"]);
  });

  test("two agents' edits to different scripts merge into valid JSON", async () => {
    const ana = PKG.replace('"bun test"', '"bun test --bail"');
    const ben = PKG.replace('"bun scripts/build-edge.ts"', '"bun scripts/edge.ts"');
    const m = merge3(PKG, ana, ben);
    expect(m.ok).toBe(true);
    if (m.ok)
      expect(JSON.parse(m.text).scripts).toMatchObject({
        test: "bun test --bail",
        "build:edge": "bun scripts/edge.ts",
      });
    // Stale whole-file writes to directly adjacent lines are refused like any diff3 merge;
    // edit ops apply to the current text and do not hit this (see tests/integration/fallback).
    const lint = PKG.replace('"prettier --check"', '"prettier --check ."');
    expect(merge3(PKG, ana, lint).ok).toBe(false);
  });

  test("spliceSymbol replaces a key, refuses invalid JSON and refuses new keys", async () => {
    const out = await spliceSymbol("package.json", PKG, "scripts.lint", '    "lint": "eslint",');
    expect(JSON.parse(out).scripts.lint).toBe("eslint");
    await expect(
      spliceSymbol("package.json", PKG, "scripts.lint", '    "lint": "eslint"')
    ).rejects.toThrow(/invalid JSON/);
    await expect(spliceSymbol("package.json", PKG, "scripts.dev", '"dev": "x",')).rejects.toThrow(
      /add it with edit/
    );
  });
});

const YAML = `# CI config
%YAML 1.2
---
name: ci
on:
  push:
    branches: [main]

# the jobs
jobs:
  test:
    steps:
      - run: |
          echo hi

"quoted key": 1
'it''s': 2
list:
- a
- b
---
name: second
`;

describe("yaml", () => {
  test("top-level keys; comment blocks lead into the next key; document markers are (top)", async () => {
    expect(await units("ci.yml", YAML)).toEqual([
      "name 3-3",
      "on 4-6",
      "jobs 8-13",
      "quoted_key 15-15",
      "it_s 16-16",
      "list 17-19",
      "name@2 21-21",
    ]);
  });

  test("editing inside one key touches only it; two agents merge", async () => {
    const ana = YAML.replace("echo hi", "echo hello");
    const ben = YAML.replace("[main]", "[main, dev]");
    expect(await touched("ci.yml", YAML, ana)).toEqual(["jobs"]);
    expect(await touched("ci.yml", YAML, ben)).toEqual(["on"]);
    expect(await touched("ci.yml", YAML, YAML.replace("%YAML 1.2", "%YAML 1.1"))).toEqual([
      "(top)",
    ]);
    expect(merge3(YAML, ana, ben).ok).toBe(true);
  });

  test("spliceSymbol appends a new top-level key and refuses nested ones", async () => {
    const out = await spliceSymbol("ci.yml", YAML, "env", "env:\n  CI: 1");
    expect((await names("ci.yml", out)).at(-1)).toBe("env");
    await expect(spliceSymbol("ci.yml", YAML, "jobs.lint", "lint: {}")).rejects.toThrow(
      /top-level YAML keys only/
    );
  });

  test("a root sequence is one unit", async () => {
    expect((await parseSymbols("a.yaml", "- a\n- b\n")).language).toBeNull();
  });
});

const TOML = `# top
title = "x"
matrix = [
  [1, 2],
  "[not.a.table]",
]
doc = """
[not.a.table.either]
"""

[tool.poetry]
name = "a"

# pinned
[tool.poetry.dependencies]
python = "3"

[[bin]]
name = "a"
[bin.meta]
[[bin]]
name = "b"
[bin.meta]
["quoted.key".x]
`;

describe("toml", () => {
  test("tables and array tables by dotted path; brackets in values are not headers", async () => {
    expect(await units("pyproject.toml", TOML)).toEqual([
      "tool.poetry 10-11",
      "tool.poetry.dependencies 13-15",
      "bin 17-18",
      "bin.meta 19-19",
      "bin@2 20-21",
      "bin@2.meta 22-22",
      "quoted_key.x 23-23",
    ]);
  });

  test("keys before the first table are (top); a table lock covers its subtables", async () => {
    expect(await touched("pyproject.toml", TOML, TOML.replace('"x"', '"y"'))).toEqual(["(top)"]);
    expect(await touched("pyproject.toml", TOML, TOML.replace('"3"', '"3.12"'))).toEqual([
      "tool.poetry.dependencies",
    ]);
    expect(
      await touched("pyproject.toml", TOML, TOML.replace('"3"', '"3.12"').replace('"a"\n', '"b"\n'))
    ).toEqual(["tool.poetry"]);
  });

  test("spliceSymbol appends a new table at the end, even a dotted one", async () => {
    const out = await spliceSymbol("pyproject.toml", TOML, "tool.ruff", "[tool.ruff]\nline = 100");
    expect(out.endsWith("[tool.ruff]\nline = 100\n")).toBe(true);
    expect(await names("pyproject.toml", out)).toContain("tool.ruff");
  });
});

describe("code that does not parse cleanly", () => {
  const BROKEN = `import x from "y";

export function a() {
  return 1;

export function b() {
  return 2;
}

// doc for c
export function c() {
  return 3;
}
`;

  test("column-0 definitions become units when the grammar loses them", async () => {
    const p = await parseSymbols("a.ts", BROKEN);
    expect(p.hasErrors).toBe(true);
    expect(p.symbols.map((s) => `${s.name} ${s.kind} ${s.start}-${s.end}`)).toEqual([
      "a function 2-3",
      "b function 5-7",
      "c function 9-12",
    ]);
  });

  test("a symbol that swallows the rest of the file is cut at the next definition", async () => {
    const src =
      "function a() {\n  if (x {\n    return 2;\n}\n\nfunction b() {\n  return 3;\n}\n\nclass K {\n  m() {}\n}\n";
    expect(await units("a.ts", src)).toEqual(["a 0-3", "b 5-7", "K 9-11"]);
    expect(
      await names("a.go", "package m\n\nfunc a() {\n\nfunc (s *S) Run() {\n}\n\nfunc c() {}\n")
    ).toEqual(["a", "S.Run", "c"]);
    expect(await names("a.py", "def a(:\n    pass\n\nclass B:\n    pass\n\nx = 1\n")).toEqual(
      expect.arrayContaining(["a", "B", "x"])
    );
  });

  test("editing one function of a broken file touches only that function", async () => {
    expect(await touched("a.ts", BROKEN, BROKEN.replace("return 3;", "return 4;"))).toEqual(["c"]);
    // Breaking a clean file mid-edit keeps the same names.
    const clean = BROKEN.replace("return 1;\n", "return 1;\n}\n");
    expect(await names("a.ts", clean)).toEqual(["a", "b", "c"]);
    expect(await touched("a.ts", clean, BROKEN.replace("return 3;", "return 4;"))).toEqual([
      "a",
      "c",
    ]);
  });
});

describe("unsupported files stay whole", () => {
  test("no grammar and no structure: one unit, and spliceSymbol refuses", async () => {
    for (const f of ["notes.txt", ".env", "Makefile", "a.ini"]) {
      const p = await parseSymbols(f, "# Heading\nKEY=1\n[section]\n");
      expect(p.language).toBeNull();
      expect(p.symbols).toEqual([]);
      expect(await touched(f, "a\n", "b\n")).toEqual([""]);
    }
    await expect(spliceSymbol("notes.txt", "# x\n", "x", "y")).rejects.toThrow(
      /no supported grammar/
    );
  });
});
