/**
 * Real agents, real tools. Runs three headless Claude Code sessions against a
 * repo wired by `axis init`:
 *
 *   A and B, concurrently: each edits a different method of the same file with
 *     Claude's ordinary Edit tool. Axis's hook routes both edits through the
 *     gateway, locks exactly the method each one touched, and both land.
 *   C, with Axis switched off entirely (no MCP server, no hooks): told to edit a
 *     method a teammate holds. The OS refuses the write; the file is unchanged.
 *
 *   bun tests/agents/run.ts            (uses the `claude` CLI and your Claude login; a few cents of Haiku)
 *
 * Needs a built binary for this machine: `bun scripts/build.ts --host`.
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { readCredentials } from "../../src/client/config.ts";
import { HubClient } from "../../src/client/hub-client.ts";

const ROOT = path.resolve(import.meta.dir, "../..");
const BIN = path.join(ROOT, `dist/bin/axis-${process.platform}-${process.arch}`);
const MODEL = process.env.AXIS_AGENT_MODEL ?? "haiku";

const AUTH = `export class Auth {
  login(user: string) {
    return user;
  }

  logout() {
    return true;
  }

  refresh(token: string) {
    return token;
  }
}
`;

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
}

const work = realpathSync(mkdtempSync(path.join(os.tmpdir(), "axis-agents-")));
const repo = path.join(work, "repo");
const home = path.join(work, "home");
const bin = path.join(work, "bin");
mkdirSync(path.join(repo, "src"), { recursive: true });
mkdirSync(home);
mkdirSync(bin);
symlinkSync(BIN, path.join(bin, "axis"));
writeFileSync(path.join(repo, "src/auth.ts"), AUTH);

const port = 4700 + Math.floor(Math.random() * 200);
const env = {
  ...process.env,
  PATH: `${bin}:${process.env.PATH}`,
  AXIS_HOME: home,
  AXIS_SYSTEM_SOCKET: path.join(home, "none.sock"),
} as Record<string, string>;
const run = (cmd: string[], extra: Record<string, string> = {}) => {
  const p = Bun.spawnSync(cmd, {
    cwd: repo,
    env: { ...env, ...extra },
    stdout: "pipe",
    stderr: "pipe",
  });
  return (p.stdout.toString() + p.stderr.toString()).trim();
};

const hub = Bun.spawn([BIN, "hub", "--port", String(port), "--db", path.join(work, "hub.db")], {
  env,
  stdout: "ignore",
  stderr: "ignore",
});
try {
  await Bun.sleep(800);
  run(["git", "init", "-q"]);
  const init = run(["axis", "init", "--hub", `http://127.0.0.1:${port}`, "--no-open"], {
    AXIS_MEMBER: "vir",
  });
  check(
    "axis init wires Claude Code (MCP server + edit hooks)",
    /claude-code\s+\.mcp\.json/.test(init) && /claude-code hooks/.test(init)
  );

  // A and B are two Claude Code sessions using only the tools they already know.
  const claude = (prompt: string, member: string, withAxis: boolean) => {
    const args = [
      "claude",
      "-p",
      prompt,
      "--model",
      MODEL,
      "--permission-mode",
      "bypassPermissions",
      "--max-turns",
      "8",
      "--output-format",
      "text",
    ];
    // With Axis: the project's own wiring. Without: no MCP servers and no project hooks at all.
    if (withAxis)
      args.push(
        "--mcp-config",
        path.join(repo, ".mcp.json"),
        "--settings",
        path.join(repo, ".claude/settings.json")
      );
    else args.push("--strict-mcp-config", "--setting-sources", "user");
    return Bun.spawn(args, {
      cwd: repo,
      env: { ...env, AXIS_MEMBER: member },
      stdout: "pipe",
      stderr: "pipe",
    });
  };
  const edit = (fn: string, change: string) =>
    `Edit src/auth.ts: in the Auth class, ${change} Change only the ${fn} method, using your Edit tool once. Do not touch any other method. Reply with one short sentence when done.`;

  const a = claude(edit("login", "make login return user.trim() instead of user."), "ana", true);
  const b = claude(edit("logout", "make logout return false instead of true."), "ben", true);
  const [outA, outB] = await Promise.all([
    new Response(a.stdout).text(),
    new Response(b.stdout).text(),
  ]);
  await Promise.all([a.exited, b.exited]);
  const after = readFileSync(path.join(repo, "src/auth.ts"), "utf8");
  check(
    "agent A's login change landed",
    after.includes("return user.trim();"),
    outA.trim().split("\n").at(-1)
  );
  check(
    "agent B's logout change landed in the same file",
    after.includes("return false;"),
    outB.trim().split("\n").at(-1)
  );
  check("refresh, which nobody touched, is intact", after.includes("return token;"));

  process.env.AXIS_HOME = home;
  const [cred] = readCredentials();
  const events = await new HubClient(`http://127.0.0.1:${port}`, cred!.memberToken).events(0, 200);
  const granted = events.filter((e) => e.type === "lock.granted").map((e) => e.text);
  check(
    "Axis locked Auth.login for one agent",
    granted.some((t) => t.includes("src/auth.ts#Auth.login")),
    granted.find((t) => t.includes("Auth.login"))
  );
  check(
    "Axis locked Auth.logout for the other",
    granted.some((t) => t.includes("src/auth.ts#Auth.logout")),
    granted.find((t) => t.includes("Auth.logout"))
  );
  check(
    "neither agent ever locked the whole file",
    !granted.some((t) => / locked src\/auth\.ts(:| after)/.test(t))
  );

  // A teammate holds refresh; C has never heard of Axis and is told to change it anyway.
  const hold = run(["axis", "lock", "src/auth.ts#Auth.refresh", "-m", "rotating refresh tokens"], {
    AXIS_MEMBER: "dana",
  });
  check(
    "a teammate holds Auth.refresh (file sealed by the OS)",
    /locked src\/auth.ts#Auth.refresh/.test(hold),
    hold.split("\n")[0]
  );
  await Bun.sleep(500);
  const before = readFileSync(path.join(repo, "src/auth.ts"), "utf8");
  const c = claude(
    edit("refresh", "make refresh return token.trim() instead of token."),
    "cy",
    false
  );
  const outC = (await new Response(c.stdout).text()).trim();
  await c.exited;
  const final = readFileSync(path.join(repo, "src/auth.ts"), "utf8");
  check(
    "the non-Axis agent could not modify the locked file",
    final === before,
    outC.split("\n").at(-1)?.slice(0, 160)
  );
} finally {
  run(["axis", "stop"]);
  hub.kill();
  if (process.platform === "darwin") Bun.spawnSync(["chflags", "-R", "nouchg", work]);
  rmSync(work, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} check(s) failed.` : "\nAll agent checks passed.");
process.exit(failures ? 1 : 0);
