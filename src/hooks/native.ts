import path from "node:path";
import { ensureSession, hostPid } from "../client/session.ts";
import { loadWorkspace } from "../client/workspace.ts";
import type { Settled } from "../daemon/daemon.ts";
import { DaemonClient } from "../daemon/client.ts";
import { renderAcquire, renderWrite } from "../protocol/render.ts";

/**
 * `axis hook codex|cursor|gemini`: native edit tools, merged like Claude's.
 *
 * These agents edit with their own tools (Codex `apply_patch`, Cursor `Write`,
 * Gemini `write_file`/`replace`) whose inputs we cannot always replay. So the
 * tool is allowed to run: the pre-tool hook opens an edit window (the daemon
 * snapshots each file and lifts its seal, or refuses if a teammate holds the
 * file whole), and the post-tool hook settles it (the daemon commits the result
 * through the gateway, locking exactly what changed and putting back anything a
 * teammate holds). The agent hears only when something was refused or put back.
 */

export type Vendor = "codex" | "cursor" | "gemini";

interface HookInput {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  cwd?: string;
  workspace_roots?: string[];
}

type Phase = "pre" | "post";

const PHASES: Record<Vendor, Record<string, Phase>> = {
  codex: { PreToolUse: "pre", PostToolUse: "post" },
  cursor: { preToolUse: "pre", postToolUse: "post", postToolUseFailure: "post" },
  gemini: { BeforeTool: "pre", AfterTool: "post" },
};

/** Files an edit tool call is about to change, relative to `cwd` or absolute. */
export function editedPaths(input: HookInput): string[] {
  const t = input.tool_input ?? {};
  const patch = [t.command, t.patch, t.input].find((v) => typeof v === "string") as
    string | undefined;
  if (patch?.includes("*** Begin Patch")) {
    const out: string[] = [];
    for (const m of patch.matchAll(
      /^\*\*\* (?:Update|Add|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm
    ))
      out.push((m[1] ?? m[2]!).trim());
    return [...new Set(out)];
  }
  const one = [t.file_path, t.path, t.absolute_path, t.target_file, t.filePath].find(
    (v) => typeof v === "string" && v
  ) as string | undefined;
  return one ? [one] : [];
}

function output(vendor: Vendor, phase: Phase, message: string | null): string {
  if (!message) return vendor === "cursor" && phase === "pre" ? '{"permission":"allow"}' : "";
  if (vendor === "cursor")
    return JSON.stringify(
      phase === "pre"
        ? { permission: "deny", agent_message: message, user_message: firstLine(message) }
        : { additional_context: message }
    );
  if (vendor === "gemini")
    return JSON.stringify(
      phase === "pre"
        ? { decision: "deny", reason: message }
        : { hookSpecificOutput: { additionalContext: message } }
    );
  return JSON.stringify(
    phase === "pre"
      ? {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: message,
          },
        }
      : { decision: "block", reason: message }
  );
}

function firstLine(s: string): string {
  return s.split("\n")[0]!.slice(0, 200);
}

/** What the agent needs to hear after its edit settled; null when everything simply landed. */
export function describe(results: Settled[]): string | null {
  const lines: string[] = [];
  for (const r of results) {
    if (r.status === "partial" && r.denied?.status === "denied")
      lines.push(
        `AXIS kept your change to ${r.path} except the parts a teammate holds, which were put back:\n${renderAcquire(r.denied.acquire)}\nYour full version is saved at ${r.saved}; re-apply the rest after axis_wait.`
      );
    else if (r.status === "reverted")
      lines.push(
        `AXIS put ${r.path} back as it was${r.saved ? ` (your version is saved at ${r.saved})` : ""}: ${r.result ? renderWrite(r.result) : "a teammate holds it"}`
      );
    else if (r.status === "moved")
      lines.push(`AXIS: ${r.path} moved to ${r.to}; its locks followed.`);
  }
  return lines.length ? lines.join("\n") : null;
}

export async function runNativeHook(vendor: Vendor): Promise<void> {
  let input: HookInput;
  try {
    input = JSON.parse(await Bun.stdin.text());
  } catch {
    return;
  }
  const phase = PHASES[vendor][input.hook_event_name ?? ""];
  const files = editedPaths(input);
  if (!phase || !files.length) return void process.stdout.write(output(vendor, "post", null));
  const cwd = input.cwd ?? input.workspace_roots?.[0] ?? process.cwd();
  const abs = files.map((f) => path.resolve(cwd, f));
  const found = loadWorkspace(path.dirname(abs[0]!));
  if (!found.ok) return void process.stdout.write(output(vendor, phase, null));
  const { ws } = found;
  const mine = abs.filter((f) => f.startsWith(ws.root + path.sep));
  if (!mine.length) return void process.stdout.write(output(vendor, phase, null));

  let message: string | null = null;
  try {
    const daemon = await DaemonClient.ensure();
    await daemon.register({
      root: ws.root,
      hub: ws.config.hub,
      project: ws.config.project,
      memberToken: ws.credential.memberToken,
    });
    const session = await ensureSession(ws.hub, ws.config.project, hostPid(), { vendor });
    if (phase === "pre") {
      const r = await daemon.openWindow(session.token, mine, ws.root);
      if (r.status === "denied") message = `AXIS: ${r.message}`;
    } else {
      const r = await daemon.closeWindow(session.token, mine, ws.root);
      message = describe(r.results);
    }
  } catch {
    // Enforcement unavailable: the native tool runs as usual, and a sealed file still refuses it.
  }
  process.stdout.write(output(vendor, phase, message));
}
