import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { axisHome } from "../client/config.ts";
import path from "node:path";
import { ancestors, ensureSession, findSession, hostPid } from "../client/session.ts";
import { loadWorkspace } from "../client/workspace.ts";
import { DaemonClient } from "../daemon/client.ts";
import type { WriteRequest } from "../enforce/gateway.ts";
import { renderWrite } from "../protocol/render.ts";

/**
 * Claude Code hook: `axis hook claude` (PreToolUse on Edit|MultiEdit|Write,
 * PostToolUse on Read).
 *
 * Claude's own Edit/Write tools cannot touch a sealed file, so instead of
 * letting them fail we perform the edit through the Axis gateway (which locks
 * exactly the functions it touches and merges with teammates) and tell Claude
 * the outcome. The model keeps using the tools it knows; Axis does the rest.
 */

interface HookInput {
  hook_event_name: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  cwd?: string;
}

function decide(decision: "allow" | "deny", reason: string): void {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: decision,
        permissionDecisionReason: reason,
      },
    })
  );
}

export async function runClaudeHook(): Promise<void> {
  let input: HookInput;
  try {
    input = JSON.parse(await Bun.stdin.text());
  } catch {
    return; // not a hook invocation we understand: stay out of the way
  }
  const file =
    typeof input.tool_input?.file_path === "string" ? (input.tool_input.file_path as string) : "";
  if (!file) return;
  const found = loadWorkspace(input.cwd ? path.dirname(path.resolve(input.cwd, file)) : undefined);
  if (!found.ok) return; // not an Axis repo
  const { ws } = found;
  const abs = path.resolve(input.cwd ?? ws.root, file);
  if (!abs.startsWith(ws.root + path.sep)) return;
  const rel = path.relative(ws.root, abs).split(path.sep).join("/");

  let daemon: DaemonClient;
  try {
    daemon = await DaemonClient.ensure();
    await daemon.register({
      root: ws.root,
      hub: ws.config.hub,
      project: ws.config.project,
      memberToken: ws.credential.memberToken,
    });
  } catch {
    return; // enforcement unavailable: let the native tool run (a sealed file would still refuse it)
  }

  // PostToolUse(Read): remember the version Claude saw, so a later full-file Write merges instead of clobbering.
  if (input.hook_event_name === "PostToolUse") {
    if (input.tool_name === "Read" && existsSync(abs)) {
      const r = await daemon
        .seen(abs, readFileSync(abs, "utf8"), ws.root, ws.credential.memberToken)
        .catch(() => null);
      if (r?.hash) rememberSeen(hostPid(), abs, r.hash);
    }
    return;
  }
  if (input.hook_event_name !== "PreToolUse") return;

  const session =
    findSession(ws.config.project, ancestors()) ??
    (await ensureSession(ws.hub, ws.config.project, hostPid(), { vendor: "claude-code" }));
  const t = input.tool_input;
  let request: WriteRequest;
  if (input.tool_name === "Edit") {
    request = {
      op: "edit",
      path: rel,
      oldString: String(t.old_string ?? ""),
      newString: String(t.new_string ?? ""),
      replaceAll: !!t.replace_all,
    };
  } else if (input.tool_name === "Write") {
    const base = seenHashes(hostPid())[abs];
    request = { op: "write", path: rel, content: String(t.content ?? ""), baseHash: base };
  } else if (input.tool_name === "MultiEdit") {
    // Apply the edits locally in order, then submit one write against the current version.
    const current = existsSync(abs) ? readFileSync(abs, "utf8") : "";
    let next = current;
    for (const e of (t.edits as {
      old_string: string;
      new_string: string;
      replace_all?: boolean;
    }[]) ?? []) {
      if (e.old_string === "" && next === "") next = e.new_string;
      else if (!next.includes(e.old_string))
        return decide(
          "deny",
          `AXIS: an old_string in this MultiEdit was not found in ${rel}. Re-read the file.`
        );
      else
        next = e.replace_all
          ? next.split(e.old_string).join(e.new_string)
          : next.replace(e.old_string, () => e.new_string);
    }
    request = { op: "write", path: rel, content: next, baseHash: undefined };
  } else {
    return;
  }

  const res = await daemon.write(session.token, request, ws.root).catch((e: Error) => ({
    status: "error" as const,
    path: rel,
    code: "io" as const,
    message: e.message,
  }));
  if (res.status === "applied") {
    return decide(
      "deny",
      `AXIS APPLIED THIS EDIT FOR YOU. ${renderWrite(res)}\nThe file on disk is updated; do not retry. (Axis seals locked files, so edits go through it.)`
    );
  }
  decide("deny", `AXIS: ${renderWrite(res)}`);
}

/** Per host session: path -> hash of the version Claude last Read. The daemon holds the content itself. */
function seenFile(pid: number): string {
  return path.join(axisHome(), "sessions", `seen-${pid}.json`);
}

function seenHashes(pid: number): Record<string, string> {
  try {
    return JSON.parse(readFileSync(seenFile(pid), "utf8"));
  } catch {
    return {};
  }
}

function rememberSeen(pid: number, abs: string, hash: string): void {
  const all = seenHashes(pid);
  all[abs] = hash;
  mkdirSync(path.dirname(seenFile(pid)), { recursive: true, mode: 0o700 });
  writeFileSync(seenFile(pid), JSON.stringify(all), { mode: 0o600 });
}
