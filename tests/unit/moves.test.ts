import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { findMove, similarity } from "../../src/daemon/moves.ts";
import { scratchDir } from "../helpers/fs.ts";

let repo: ReturnType<typeof scratchDir>;
const git = (...a: string[]) =>
  Bun.spawnSync(["git", "-C", repo.dir, ...a], { stdout: "ignore", stderr: "ignore" });
const put = (rel: string, text: string) => {
  mkdirSync(path.dirname(path.join(repo.dir, rel)), { recursive: true });
  writeFileSync(path.join(repo.dir, rel), text);
};
const A =
  "export function login(u) {\n  return u.trim();\n}\n\nexport function other() {\n  return 1;\n}\n";
const B =
  "export function logout() {\n  return true;\n}\n\nexport function other() {\n  return 1;\n}\n";

beforeEach(() => {
  repo = scratchDir("axis-moves-");
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  put("src/a.ts", A);
  put("src/b.ts", B);
  git("add", "-A");
  git("commit", "-qm", "init");
});
afterEach(() => repo.dispose());

test("a rename git recorded wins, whatever the content", () => {
  mkdirSync(path.join(repo.dir, "lib"));
  git("mv", "src/a.ts", "lib/a.ts");
  expect(findMove(repo.dir, "src/a.ts", "unrelated", ["login"])).toBe("lib/a.ts");
});

test("an untracked file with the same content, or a lightly edited copy defining the locked units", () => {
  rmSync(path.join(repo.dir, "src/a.ts"));
  put("src/auth.ts", A);
  expect(findMove(repo.dir, "src/a.ts", A, ["login"])).toBe("src/auth.ts");
  rmSync(path.join(repo.dir, "src/auth.ts"));
  put("src/auth.ts", A.replace("return 1;", "return 2;"));
  expect(findMove(repo.dir, "src/a.ts", A, ["login"])).toBe("src/auth.ts");
});

test("shared boilerplate is not a match: the candidate must define the locked units", () => {
  rmSync(path.join(repo.dir, "src/a.ts"));
  put("src/z.ts", B.replace("return true;", "return false;"));
  expect(findMove(repo.dir, "src/a.ts", A, ["login"])).toBeNull();
});

test("a recorded rename's destination is never another file's candidate", () => {
  git("mv", "src/b.ts", "src/c.ts");
  rmSync(path.join(repo.dir, "src/a.ts"));
  expect(findMove(repo.dir, "src/a.ts", A, [])).toBeNull();
});

test("tracked files are never candidates, so a teammate's older layout cannot pull locks back", () => {
  put("src/a.ts", A);
  expect(findMove(repo.dir, "src/b.ts", A, [])).toBeNull();
});

test("two equally good candidates is no answer, and outside git there is none", () => {
  rmSync(path.join(repo.dir, "src/a.ts"));
  put("x/one.ts", A);
  put("x/two.ts", A);
  expect(findMove(repo.dir, "src/a.ts", A, ["login"])).toBeNull();
  const bare = scratchDir("axis-nogit-");
  expect(findMove(bare.dir, "a.ts", A)).toBeNull();
  bare.dispose();
});

test("similarity counts shared non-blank lines over the larger file", () => {
  expect(similarity("a\nb\n\nc", "a\nb\nc")).toBe(1);
  expect(similarity("a\nb", "a\nc")).toBe(0.5);
  expect(similarity("", "a")).toBe(0);
});
