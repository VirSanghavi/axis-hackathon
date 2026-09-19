import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { saveCredential, writeProjectConfig } from "../../src/client/config.ts";
import { rogueWrite, scratchDir, stopDaemon } from "../helpers/fs.ts";
import { liveHub } from "../helpers/server.ts";

/**
 * The Claude Code hook, driven with the exact JSON Claude Code sends. Claude's
 * native Edit/Write cannot touch a sealed file, so the hook performs the edit
 * through the gateway and answers "deny" with an APPLIED message.
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

let h: Awaited<ReturnType<typeof liveHub>>;
let repo: ReturnType<typeof scratchDir>;
let home: string;
let socket: string;

async function hook(
  input: Record<string, unknown>
): Promise<{ decision?: string; reason?: string; raw: string }> {
  const p = Bun.spawn([process.execPath, path.join(ROOT, "src/cli/main.ts"), "hook", "claude"], {
    stdin: new Blob([JSON.stringify({ cwd: repo.dir, ...input })]),
    stdout: "pipe",
    stderr: "pipe",
    cwd: repo.dir,
    env: {
      ...process.env,
      AXIS_HOME: home,
      AXIS_SOCKET: socket,
      AXIS_SYSTEM_SOCKET: path.join(home, "none.sock"),
      AXIS_MEMBER: "cc",
    },
  });
  const raw = await new Response(p.stdout).text();
  await p.exited;
  if (!raw) return { raw };
  const out = JSON.parse(raw).hookSpecificOutput;
  return { decision: out.permissionDecision, reason: out.permissionDecisionReason, raw };
}

const authFile = () => path.join(repo.dir, "src/auth.ts");

beforeAll(async () => {
  h = await liveHub();
  repo = scratchDir("axis-hook-");
  home = mkdtempSync("/tmp/axk-");
  socket = path.join(home, "d.sock");
  mkdirSync(path.join(repo.dir, "src"));
  mkdirSync(path.join(repo.dir, ".git"));
  writeFileSync(authFile(), AUTH);
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

describe("claude code hook", () => {
  test("Edit is applied through the gateway and reported as applied", async () => {
    const r = await hook({
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: {
        file_path: authFile(),
        old_string: "return u;",
        new_string: "return u.trim();",
      },
    });
    expect(r.decision).toBe("deny");
    expect(r.reason).toMatch(
      /^AXIS APPLIED THIS EDIT FOR YOU\. OK wrote src\/auth.ts \[Auth.login\] · auto-locked Auth.login/
    );
    expect(readFileSync(authFile(), "utf8")).toContain("return u.trim();");
    expect(rogueWrite(authFile(), "x")).toMatch(/^(EPERM|EACCES)$/);
  });

  test("an Edit into another agent's function is refused with their reason", async () => {
    const other = await h.agent(h.ben, "ben", "desktop");
    await other.acquire(["src/auth.ts#Auth.logout"], "renaming logout to signOut");
    const r = await hook({
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: {
        file_path: authFile(),
        old_string: "return true;",
        new_string: "return false;",
      },
    });
    expect(r.decision).toBe("deny");
    expect(r.reason).toMatch(/^AXIS: DENIED src\/auth.ts#Auth.logout/);
    expect(r.reason).toContain('"renaming logout to signOut"');
    expect(readFileSync(authFile(), "utf8")).toContain("return true;");
    await other.endAgent();
  });

  test("Read then a whole-file Write from that version merges with a newer teammate edit", async () => {
    const seen = readFileSync(authFile(), "utf8");
    await hook({
      hook_event_name: "PostToolUse",
      tool_name: "Read",
      tool_input: { file_path: authFile() },
      tool_response: {},
    });
    // A teammate changes logout after Claude read the file.
    const mate = await h.agent(h.ben, "ben", "desktop");
    const { DaemonClient } = await import("../../src/daemon/client.ts");
    const d = new DaemonClient(socket);
    expect(
      (
        await d.write(
          mate.sessionToken,
          {
            op: "edit",
            path: "src/auth.ts",
            oldString: "logout() {",
            newString: "logout(): boolean {",
          },
          repo.dir
        )
      ).status
    ).toBe("applied");
    await mate.endAgent();
    // Claude writes the whole file from what it read, changing only login.
    const r = await hook({
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: {
        file_path: authFile(),
        content: seen.replace("return u.trim();", "return u.trim().toLowerCase();"),
      },
    });
    expect(r.reason).toMatch(/merged with a teammate's concurrent edit/);
    const now = readFileSync(authFile(), "utf8");
    expect(now).toContain("return u.trim().toLowerCase();");
    expect(now).toContain("logout(): boolean {");
  });

  test("MultiEdit applies every edit in one gateway write", async () => {
    const r = await hook({
      hook_event_name: "PreToolUse",
      tool_name: "MultiEdit",
      tool_input: {
        file_path: authFile(),
        edits: [
          { old_string: "login(u: string)", new_string: "login(user: string)" },
          {
            old_string: "return u.trim().toLowerCase();",
            new_string: "return user.trim().toLowerCase();",
          },
        ],
      },
    });
    expect(r.reason).toMatch(/^AXIS APPLIED/);
    expect(readFileSync(authFile(), "utf8")).toContain("login(user: string)");
  });

  test("files outside Axis repos and non-edit tools are left alone", async () => {
    expect(
      (
        await hook({
          hook_event_name: "PreToolUse",
          tool_name: "Edit",
          tool_input: { file_path: "/tmp/not-a-repo/x.ts", old_string: "a", new_string: "b" },
          cwd: "/tmp",
        })
      ).raw
    ).toBe("");
    expect(
      (
        await hook({
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: "ls" },
        })
      ).raw
    ).toBe("");
  });
});
