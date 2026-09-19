import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { wiredHosts } from "./agents.ts";
import type { Device } from "../protocol/types.ts";
import { ensureSession, hostPid } from "../client/session.ts";
import { loadWorkspace } from "../client/workspace.ts";
import { DaemonClient } from "../daemon/client.ts";

/**
 * `axis doctor`: prove the whole chain on this machine, end to end, with a real
 * file. Not "is the config present" but "does a locked file actually refuse a
 * raw write, and does the gateway still write it".
 */
export async function runDoctor(version: string): Promise<void> {
  let failed = 0;
  const checks: { name: string; ok: boolean; detail: string }[] = [];
  const check = async (name: string, fn: () => Promise<string>) => {
    try {
      const detail = await fn();
      checks.push({ name, ok: true, detail });
      console.log(`✓ ${name.padEnd(28)} ${detail}`);
    } catch (e) {
      failed++;
      checks.push({ name, ok: false, detail: (e as Error).message });
      console.log(`✗ ${name.padEnd(28)} ${(e as Error).message}`);
    }
  };

  const w = loadWorkspace();
  if (!w.ok) {
    console.log(`✗ workspace                    ${w.reason}`);
    process.exit(1);
  }
  const ws = w.ws;
  await check("workspace", async () => `${ws.root} → ${ws.config.name}`);
  await check("hub reachable", async () => {
    const t0 = performance.now();
    const me = await ws.hub.me();
    return `${ws.config.hub} as ${me.principal.memberName} (${Math.round(performance.now() - t0)}ms)`;
  });
  let daemon: DaemonClient | null = null;
  await check("enforcement daemon", async () => {
    daemon = await DaemonClient.ensure();
    const r = await daemon.register({
      root: ws.root,
      hub: ws.config.hub,
      project: ws.config.project,
      memberToken: ws.credential.memberToken,
    });
    return `${r.tier} (${r.mechanism})`;
  });
  if (!daemon) process.exit(1);
  const d = daemon as DaemonClient;
  const hosts = wiredHosts(ws.root);
  await check("agents wired", async () => {
    if (!hosts.length) throw new Error("no agent host has the axis MCP server; run `axis init`");
    return hosts.join(", ");
  });

  const rel = ".axis/doctor-probe.txt";
  const abs = path.join(ws.root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, "before\n");
  const session = await ensureSession(ws.hub, ws.config.project, hostPid(), {
    vendor: "cli",
    name: `${ws.credential.member}/doctor`,
  });
  const agent = ws.hub.withToken(session.token);
  try {
    await check("lock", async () => {
      const r = await agent.acquire([rel], "axis doctor self-test");
      if (r.status !== "granted") throw new Error(`expected granted, got ${r.status}`);
      await d.reconcile(ws.root, ws.credential.memberToken);
      return `locked ${rel}`;
    });
    await check("raw write is refused", async () => {
      const tier = (await d.status()).tier;
      if (tier === "off") return "skipped: enforcement is off on this platform";
      try {
        writeFileSync(abs, "clobbered\n");
      } catch (e) {
        return `kernel said ${(e as NodeJS.ErrnoException).code}`;
      }
      throw new Error("a raw write went through a locked file");
    });
    await check("gateway write works", async () => {
      const r = await d.write(
        session.token,
        { op: "edit", path: rel, oldString: "before", newString: "after" },
        ws.root
      );
      if (r.status !== "applied") throw new Error(`gateway returned ${r.status}`);
      return "applied through axisd";
    });
    await check("unlock restores writes", async () => {
      await agent.release([rel]);
      await d.reconcile(ws.root, ws.credential.memberToken);
      writeFileSync(abs, "free again\n");
      return "file writable after release";
    });
  } finally {
    await agent.release("all").catch(() => {});
    await d.reconcile(ws.root, ws.credential.memberToken).catch(() => {});
    await agent.endAgent().catch(() => {});
    rmSync(abs, { force: true });
  }
  // Tell the team: `axis doctor --team` reads every device's last result from the hub.
  const st = await d.status().catch(() => null);
  if (st)
    await ws.hub
      .reportDevice({
        deviceId: st.deviceId,
        hostname: os.hostname(),
        platform: `${process.platform}-${process.arch}`,
        tier: st.tier,
        sealed: st.workspaces.find((x) => x.root === realpathSync(ws.root))?.sealed ?? [],
        health: { version, hosts, checks, checkedAt: Date.now() },
      })
      .catch(() => {});
  console.log(
    failed
      ? `\n${failed} check(s) failed.`
      : "\nAll good. Locked files on this machine are enforced."
  );
  process.exit(failed ? 1 : 0);
}

const HOUR = 3600_000;

/** What needs someone's attention on a device, in plain words; empty when it is fine. */
export function deviceProblems(d: Device, latest: string | undefined, now: number): string[] {
  const out: string[] = [];
  const h = d.health ?? {};
  if (d.tier === "off") out.push("no enforcement: locks are advisory here");
  else if (d.tier === "guard")
    out.push("guard tier: run `axis enforcer install` for the kernel tier");
  if (h.orphaned?.length)
    out.push(
      `${h.orphaned.length} locked file${h.orphaned.length === 1 ? "" : "s"} missing: ${h.orphaned.slice(0, 3).join(", ")}`
    );
  const bad = h.checks?.filter((c) => !c.ok) ?? [];
  if (bad.length)
    out.push(`doctor failed: ${bad.map((c) => `${c.name} (${c.detail})`).join("; ")}`);
  if (!h.checkedAt) out.push("never ran `axis doctor`");
  else if (now - h.checkedAt > 7 * 24 * HOUR) out.push("last `axis doctor` over a week ago");
  if (h.hosts && !h.hosts.length) out.push("no agent host wired");
  if (latest && h.version && h.version !== latest) out.push(`on ${h.version}, team has ${latest}`);
  return out;
}

/** `axis doctor --team`: every device on the team, and what needs fixing where. */
export async function runTeamDoctor(): Promise<void> {
  const w = loadWorkspace();
  if (!w.ok) {
    console.log(`✗ ${w.reason}`);
    process.exit(1);
  }
  const snap = await w.ws.hub.snapshot(0);
  const now = snap.serverTime;
  const versions = snap.devices.map((d) => d.health?.version).filter((v): v is string => !!v);
  const latest = versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
  const rows = snap.devices.map((d) => ({ d, problems: deviceProblems(d, latest, now) }));
  const attention = rows.filter((r) => r.problems.length).length;
  console.log(
    `${snap.project.name}: ${rows.length} device${rows.length === 1 ? "" : "s"}, ${attention ? `${attention} need${attention === 1 ? "s" : ""} attention` : "all healthy"}\n`
  );
  for (const { d, problems } of rows) {
    const h = d.health ?? {};
    const seen = d.online ? "online" : `seen ${Math.round((now - d.lastSeenAt) / 60_000)}m ago`;
    console.log(
      `${problems.length ? "✗" : "✓"} ${d.member.padEnd(12)} ${d.hostname.padEnd(22)} ${d.tier.padEnd(6)} ${seen.padEnd(14)} ${(h.version ?? "?").padEnd(8)} ${(h.hosts ?? []).join(", ") || "-"}`
    );
    for (const p of problems) console.log(`    ${p}`);
  }
  process.exit(attention ? 1 : 0);
}
