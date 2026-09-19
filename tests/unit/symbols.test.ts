import { describe, expect, test } from "bun:test";
import { spliceSymbol } from "../../src/enforce/gateway.ts";
import { merge3, touchedTargets, uncovered } from "../../src/symbols/coverage.ts";
import { languageFor, parseSymbols } from "../../src/symbols/parser.ts";

const TS = `import { x } from "y";

export class Auth {
  login(u: string) {
    return u;
  }

  logout() {
    return true;
  }
}

export function helper() {
  return 1;
}
`;

const names = async (file: string, src: string) =>
  (await parseSymbols(file, src)).symbols.map((s) => s.name);
const touched = async (base: string, next: string, file = "a.ts") =>
  (await touchedTargets(file, base, next)).targets.map((t) => t.symbol);

describe("parser", () => {
  test("typescript: classes, methods, functions, nesting", async () => {
    expect(await names("a.ts", TS)).toEqual(["Auth", "Auth.login", "Auth.logout", "helper"]);
  });

  test("python: methods, decorators, duplicate names get @n", async () => {
    const py =
      "import os\n\nclass Svc:\n    def run(self):\n        return 1\n\n    @staticmethod\n    def stop():\n        pass\n\ndef main():\n    pass\n\ndef main():\n    pass\n";
    expect(await names("a.py", py)).toEqual(["Svc", "Svc.run", "Svc.stop", "main", "main@2"]);
  });

  test("go receivers and rust impls attach methods to their type", async () => {
    expect(
      await names(
        "a.go",
        "package m\n\ntype S struct{}\n\nfunc (s *S) Run() int { return 1 }\n\nfunc main() {}\n"
      )
    ).toEqual(["S", "S.Run", "main"]);
    expect(
      await names("a.rs", "struct V;\nimpl V {\n    fn push(&self) {}\n}\nfn main() {}\n")
    ).toEqual(["V", "V.push", "main"]);
  });

  test("every advertised language parses", async () => {
    const samples: Record<string, string> = {
      "a.js": "function f() {}\n",
      "a.tsx": "export function C() { return <div/>; }\n",
      "a.java": "class A { void m() {} }\n",
      "a.rb": "class A\n  def m\n  end\nend\n",
      "a.c": "int f(void) { return 0; }\n",
      "a.cpp": "int f() { return 0; }\n",
      "a.cs": "class A { void M() {} }\n",
      "a.php": "<?php\nfunction f() {}\n",
      "a.kt": "fun f() {}\n",
      "a.swift": "func f() {}\n",
    };
    for (const [file, src] of Object.entries(samples)) {
      const p = await parseSymbols(file, src);
      expect(p.language).not.toBeNull();
      expect(p.symbols.length).toBeGreaterThan(0);
    }
  });

  test("unknown extensions have no grammar", () => {
    expect(languageFor("README.md")).toBeNull();
  });
});

describe("coverage: which units does a change touch", () => {
  test("editing inside a method touches only that method", async () => {
    expect(await touched(TS, TS.replace("return u;", "return u.trim();"))).toEqual(["Auth.login"]);
  });

  test("editing two functions touches both", async () => {
    expect(
      (
        await touched(TS, TS.replace("return u;", "return u!;").replace("return 1;", "return 2;"))
      ).sort()
    ).toEqual(["Auth.login", "helper"]);
  });

  test("imports and glue are (top)", async () => {
    expect(
      await touched(TS, TS.replace('import { x } from "y";', 'import { x, z } from "y";'))
    ).toEqual(["(top)"]);
  });

  test("adding a method touches only the new method", async () => {
    expect(
      await touched(
        TS,
        TS.replace("  logout() {", "  refresh() {\n    return 2;\n  }\n\n  logout() {")
      )
    ).toEqual(["Auth.refresh"]);
  });

  test("a brand-new class is one unit, not each of its methods", async () => {
    expect(await touched(TS, TS + "\nexport class New {\n  m() {}\n}\n")).toEqual(["New"]);
  });

  test("deleting a function touches it", async () => {
    const next = TS.replace("\nexport function helper() {\n  return 1;\n}\n", "");
    const t = await touchedTargets("a.ts", TS, next);
    expect(t.targets.map((x) => x.symbol)).toEqual(["helper"]);
    expect(t.removed).toEqual(["helper"]);
  });

  test("renaming a method touches the old name", async () => {
    expect(await touched(TS, TS.replace("logout()", "signOut()"))).toContain("Auth.logout");
  });

  test("files without a grammar are one unit", async () => {
    expect(await touched("a", "b", "notes.md")).toEqual([""]);
  });

  test("uncovered: a class lock covers its methods; a method lock does not cover the class", () => {
    const t = (symbol: string) => ({ path: "a.ts", symbol });
    expect(uncovered([t("Auth.login")], [t("Auth")])).toEqual([]);
    expect(uncovered([t("Auth")], [t("Auth.login")])).toEqual([t("Auth")]);
    expect(uncovered([t("helper")], [t("")])).toEqual([]);
  });
});

describe("merge3", () => {
  const base = "a\nb\nc\nd\ne\n";
  test("disjoint edits merge", () => {
    const r = merge3(base, base.replace("a", "A"), base.replace("e", "E"));
    expect(r).toEqual({ ok: true, text: "A\nb\nc\nd\nE\n" });
  });
  test("overlapping edits are refused with the colliding line", () => {
    const r = merge3(base, base.replace("c", "C1"), base.replace("c", "C2"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.conflictLines).toEqual([3]);
  });
  test("identical edits are not a conflict", () => {
    expect(merge3(base, base.replace("c", "X"), base.replace("c", "X"))).toEqual({
      ok: true,
      text: base.replace("c", "X"),
    });
  });
  test("CRLF survives", () => {
    const b = "a\r\nb\r\nc\r\n";
    const r = merge3(b, b.replace("a", "A"), b.replace("c", "C"));
    expect(r).toEqual({ ok: true, text: "A\r\nb\r\nC\r\n" });
  });
});

describe("spliceSymbol", () => {
  test("replaces exactly one method", async () => {
    const out = await spliceSymbol(
      "a.ts",
      TS,
      "Auth.login",
      "  login(u: string) {\n    return u.toLowerCase();\n  }"
    );
    expect(out).toBe(TS.replace("return u;", "return u.toLowerCase();"));
  });
  test("appends a new method inside its class", async () => {
    const out = await spliceSymbol("a.ts", TS, "Auth.refresh", "  refresh() {}");
    expect(await names("a.ts", out)).toEqual([
      "Auth",
      "Auth.login",
      "Auth.logout",
      "Auth.refresh",
      "helper",
    ]);
  });
  test("appends a new top-level function at the end", async () => {
    const out = await spliceSymbol("a.ts", TS, "extra", "export function extra() {}");
    expect(out.endsWith("}\n\nexport function extra() {}\n")).toBe(true);
  });
  test("refuses a method on a missing class, and files with no grammar", async () => {
    await expect(spliceSymbol("a.ts", TS, "Nope.m", "m() {}")).rejects.toThrow(/No Nope/);
    await expect(spliceSymbol("a.md", "x", "s", "y")).rejects.toThrow(/no supported grammar/);
  });
});
