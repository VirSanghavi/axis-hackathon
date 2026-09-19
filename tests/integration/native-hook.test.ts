import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { saveCredential, writeProjectConfig } from "../../src/client/config.ts";
import { editedPaths } from "../../src/hooks/native.ts";
import { formatTarget } from "../../src/protocol/target.ts";
import { rogueWrite, scratchDir, stopDaemon, until } from "../helpers/fs.ts";
import { liveHub } from "../helpers/server.ts";

/**
 * Codex, Cursor and Gemini edit with their own tools. Their hooks, driven with
 * each vendor's JSON, open an edit window before the tool runs and settle it
 * after: the agent's native write lands, gets locked and merged like any Axis
 * write, and anything a teammate holds is put back with the attempt saved.
 */

const ROOT = path.resolve(import.meta.dir, "../..");
const AUTH = `export class Auth {
  login(u: string) {
    return u;
  }

  logout() {
    return true;
  }
}
`;
const USERS = "export function find(id: string) {\n  return id;\n}\n";

let h: Awaited<ReturnType<typeof liveHub>>;
let repo: ReturnType<typeof scratchDir>;
let home: string;
let socket: string;
const f = (rel: string) => path.join(repo.dir, rel);
const read = (rel: string) => readFileSync(f(rel), "utf8");
const unseal = (abs: string) =>
  Bun.spawnSync(process.platform === "darwin" ? ["chflags", "nouchg", abs] : ["chmod", "u+w", abs]);

async function hook(
  vendor: string,
  input: Record<string, unknown>
): Promise<Record<string, any> | null> {
  const p = Bun.spawn([process.execPath, path.join(ROOT, "src/cli/main.ts"), "hook", vendor], {
    stdin: new Blob([JSON.stringify({ cwd: repo.dir, ...input })]),
    stdout: "pipe",
    stderr: "pipe",
    cwd: repo.dir,
    env: {
      ...process.env,
      AXIS_HOME: home,
      AXIS_SOCKET: socket,
      AXIS_SYSTEM_SOCKET: path.join(home, "none.sock"),
      AXIS_MEMBER: "cx",
    },
  });
  const raw = await new Response(p.stdout).text();
  await p.exited;
  return raw ? JSON.parse(raw) : null;
}

const patch = (...files: string[]) =>
  `*** Begin Patch\n${files.map((x) => `*** Update File: ${x}\n@@\n-a\n+b\n`).join("")}*** End Patch\n`;
const codex = (event: "PreToolUse" | "PostToolUse", ...files: string[]) =>
  hook("codex", {
    hook_event_name: event,
    tool_name: "apply_patch",
    tool_input: { command: patch(...files) },
  });

function reset() {
  for (const rel of ["src/auth.ts", "src/users.ts"]) if (existsSync(f(rel))) unseal(f(rel));
  writeFileSync(f("src/auth.ts"), AUTH);
  writeFileSync(f("src/users.ts"), USERS);
}

beforeAll(async () => {
  h = await liveHub();
  repo = scratchDir("axis-native-");
  home = mkdtempSync("/tmp/axn-");
  socket = path.join(home, "d.sock");
  Bun.spawnSync(["git", "init", "-q", repo.dir]);
  mkdirSync(f("src"));
  reset();
  writeProjectConfig(repo.dir, { hub: h.url, project: h.project, name: "acme" });
  const prev = process.env.AXIS_HOME;
  process.env.AXIS_HOME = home;
  saveCredential({
    hub: h.url,
    project: h.project,
    projectName: "acme",
    member: "dana",
    memberToken: h.danaToken,
  });
  process.env.AXIS_HOME = prev;
});

afterAll(async () => {
  await stopDaemon(socket);
  repo.dispose();
  rmSync(home, { recursive: true, force: true });
  h.close();
});

const locks = async () =>
  (await h.dana.locks()).map((l) => `${l.agent.vendor}:${formatTarget(l)}`).sort();
const releaseAll = async () => {
  for (const l of await h.dana.locks())
    await h.dana.force([formatTarget(l)], "test reset").catch(() => {});
};

describe("codex apply_patch", () => {
  test("a native edit lands, is locked to exactly what changed, and the file is sealed after", async () => {
    reset();
    expect(await codex("PreToolUse", "src/auth.ts")).toBeNull();
    writeFileSync(f("src/auth.ts"), AUTH.replace("return u;", "return u.trim();"));
    expect(await codex("PostToolUse", "src/auth.ts")).toBeNull();
    expect(read("src/auth.ts")).toContain("return u.trim();");
    expect(await locks()).toEqual(["codex:src/auth.ts#Auth.login"]);
    expect(await until(() => rogueWrite(f("src/auth.ts"), "x") !== "written", 3000)).toBe(true);
    await releaseAll();
  });

  test("a teammate's function is put back, the rest kept, the attempt saved, and codex is told", async () => {
    reset();
    const ben = await h.agent(h.ben, "ben", "desktop");
    await ben.acquire(["src/auth.ts#Auth.logout"], "renaming logout");
    expect(await codex("PreToolUse", "src/auth.ts")).toBeNull();
    // The window lifted the seal for the tool: write both functions, as apply_patch would.
    const attempt = AUTH.replace("return u;", "return u.trim();").replace(
      "return true;",
      "return false;"
    );
    writeFileSync(f("src/auth.ts"), attempt);
    const out = await codex("PostToolUse", "src/auth.ts");
    expect(out?.decision).toBe("block");
    expect(out?.reason).toMatch(
      /kept your change to src\/auth.ts except the parts a teammate holds/
    );
    expect(out?.reason).toMatch(/ben.*renaming logout/s);
    expect(read("src/auth.ts")).toContain("return u.trim();");
    expect(read("src/auth.ts")).toContain("return true;");
    const saved = out!.reason.match(/saved at (\S+);/)![1];
    expect(readFileSync(f(saved), "utf8")).toBe(attempt);
    expect(readdirSync(f(".axis/rejected")).length).toBeGreaterThan(0);
    expect(readFileSync(f(".axis/.gitignore"), "utf8")).toContain("rejected/");
    await ben.endAgent();
    await releaseAll();
  });

  test("a file a teammate holds whole is refused before the tool runs, and stays sealed", async () => {
    reset();
    const ben = await h.agent(h.ben, "ben", "desktop");
    await ben.acquire(["src/auth.ts"], "rewriting auth");
    await until(() => rogueWrite(f("src/auth.ts"), "x") !== "written", 3000);
    const out = await codex("PreToolUse", "src/auth.ts");
    expect(out?.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(out?.hookSpecificOutput?.permissionDecisionReason).toMatch(
      /locked whole by ben.*rewriting auth/
    );
    expect(rogueWrite(f("src/auth.ts"), "x")).not.toBe("written");
    await ben.endAgent();
    await releaseAll();
  });

  test("a patch across two files is all or nothing: one held function means neither file changes", async () => {
    reset();
    const ben = await h.agent(h.ben, "ben", "desktop");
    await ben.acquire(["src/users.ts#find"], "changing find");
    expect(await codex("PreToolUse", "src/auth.ts", "src/users.ts")).toBeNull();
    writeFileSync(f("src/auth.ts"), AUTH.replace("return u;", "return find(u);"));
    unseal(f("src/users.ts"));
    writeFileSync(f("src/users.ts"), USERS.replace("return id;", "return id.trim();"));
    const out = await codex("PostToolUse", "src/auth.ts", "src/users.ts");
    expect(out?.decision).toBe("block");
    // users.ts had nothing but ben's function in the change: it goes back entirely. auth.ts has
    // no teammate in it and keeps its change, landing as one batch with what was kept.
    expect(read("src/users.ts")).toBe(USERS);
    expect(read("src/auth.ts")).toContain("return find(u);");
    expect(out?.reason).toMatch(/put src\/users.ts back as it was/);
    await ben.endAgent();
    await releaseAll();
  });

  test("patch parsing finds updates, adds, deletes and moves", () => {
    expect(
      editedPaths({
        tool_input: {
          command:
            "*** Begin Patch\n*** Update File: a.ts\n*** Move to: b.ts\n@@\n*** Add File: c.ts\n+x\n*** Delete File: d.ts\n*** End Patch",
        },
      })
    ).toEqual(["a.ts", "b.ts", "c.ts", "d.ts"]);
  });
});

describe("cursor and gemini", () => {
  test("cursor: allow before, quiet after a clean edit, deny with the reason when held whole", async () => {
    reset();
    const pre = await hook("cursor", {
      hook_event_name: "preToolUse",
      tool_name: "Write",
      tool_input: { file_path: f("src/users.ts") },
    });
    expect(pre).toEqual({ permission: "allow" });
    writeFileSync(f("src/users.ts"), USERS.replace("return id;", "return id.trim();"));
    expect(
      await hook("cursor", {
        hook_event_name: "postToolUse",
        tool_name: "Write",
        tool_input: { file_path: f("src/users.ts") },
      })
    ).toBeNull();
    // One host process drives every hook here, so they share one session (its first vendor).
    expect((await locks()).map((l) => l.split(":")[1])).toEqual(["src/users.ts#find"]);
    await releaseAll();
    const ben = await h.agent(h.ben, "ben", "desktop");
    await ben.acquire(["src/users.ts"], "owning users");
    const denied = await hook("cursor", {
      hook_event_name: "preToolUse",
      tool_name: "Write",
      tool_input: { file_path: f("src/users.ts") },
    });
    expect(denied?.permission).toBe("deny");
    expect(denied?.agent_message).toMatch(/locked whole by ben/);
    await ben.endAgent();
    await releaseAll();
  });

  test("gemini: deny before when held whole, extra context after when something was put back", async () => {
    reset();
    const ben = await h.agent(h.ben, "ben", "desktop");
    await ben.acquire(["src/auth.ts#Auth.logout"], "logout work");
    expect(
      await hook("gemini", {
        hook_event_name: "BeforeTool",
        tool_name: "replace",
        tool_input: { file_path: f("src/auth.ts") },
      })
    ).toBeNull();
    writeFileSync(f("src/auth.ts"), AUTH.replace("return true;", "return 0;"));
    const after = await hook("gemini", {
      hook_event_name: "AfterTool",
      tool_name: "replace",
      tool_input: { file_path: f("src/auth.ts") },
    });
    expect(after?.hookSpecificOutput?.additionalContext).toMatch(/put src\/auth.ts back as it was/);
    expect(read("src/auth.ts")).toBe(AUTH);
    await ben.acquire(["src/users.ts"], "owning users");
    const denied = await hook("gemini", {
      hook_event_name: "BeforeTool",
      tool_name: "write_file",
      tool_input: { file_path: f("src/users.ts") },
    });
    expect(denied, JSON.stringify(denied)).not.toBeNull();
    expect(denied?.decision).toBe("deny");
    await ben.endAgent();
    await releaseAll();
  });
});
