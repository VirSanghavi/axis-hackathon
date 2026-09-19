import { formatTarget } from "./target.ts";
import type { Contention } from "../hub/hub.ts";
import type {
  AcquireResult,
  AxisEvent,
  ClaimResult,
  HolderFacts,
  Job,
  Lock,
  WaitResult,
  WriteResult,
} from "./types.ts";

/**
 * Agent-facing text. Every tool result is rendered here, and every byte costs
 * context in every agent on the team, so the rules are strict:
 *   - lead with a status word an agent can branch on (OK, DENIED, WAITED, ...)
 *   - one line per fact, no JSON, no restating the request
 *   - give the next move, not a lecture
 */

export function ago(ms: number): string {
  if (ms < 1_000) return "now";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 3_600_000)}h`;
}

function holderLine(h: HolderFacts, intent: string, target: string, relation: string): string {
  const job = h.job ? ` · ${h.job.id}` : "";
  const rel =
    relation === "same"
      ? ""
      : relation === "within"
        ? ` (holds ${target} inside it)`
        : ` (holds ${target}, which contains it)`;
  const q = h.queue ? ` · ${h.queue} queued` : "";
  return `  ${h.agent.name}@${h.agent.device}${rel}: "${intent}"${job} · active ${ago(h.idleMs)} ago · held ${ago(h.heldMs)} · lease ${ago(h.expiresInMs)}${q}`;
}

export function renderDenied(
  d: Extract<AcquireResult, { status: "denied" }>,
  free: Record<string, string[]> = {}
): string {
  const out = [`DENIED ${[...new Set(d.conflicts.map((c) => c.target))].join(", ")}`];
  const seen = new Set<string>();
  for (const c of d.conflicts) {
    if (seen.has(c.lock.id)) continue;
    seen.add(c.lock.id);
    const h = d.holders.find((x) => x.agent.id === c.lock.agent.id);
    if (h) out.push(holderLine(h, c.lock.intent, formatTarget(c.lock), c.relation));
  }
  for (const [file, names] of Object.entries(free))
    if (names.length)
      out.push(
        `  free in ${file}: ${names.slice(0, 12).join(", ")}${names.length > 12 ? ", …" : ""}`
      );
  out.push(`→ ${d.advice.action}: ${d.advice.why}`);
  return out.join("\n");
}

export function renderAcquire(r: AcquireResult, free?: Record<string, string[]>): string {
  if (r.status === "granted") {
    const fresh = r.locks.filter((l) => !r.renewed.includes(formatTarget(l)));
    const parts = [];
    if (fresh.length) parts.push(`locked ${fresh.map(formatTarget).join(", ")}`);
    if (r.renewed.length) parts.push(`renewed ${r.renewed.join(", ")}`);
    const exp = r.locks[0]
      ? ` (lease ${ago(r.locks[0].expiresAt - Date.now())}, renews on activity)`
      : "";
    return `OK ${parts.join("; ")}${exp}`;
  }
  if (r.status === "invalid") return `INVALID ${r.errors.map((e) => e.message).join(" ")}`;
  return renderDenied(r, free);
}

/** A duration the agent spent, never "now": 0.4s, 12s, 3m. */
export function took(ms: number): string {
  return ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : ago(ms);
}

export function renderWait(r: WaitResult, free?: Record<string, string[]>): string {
  if (r.status === "granted")
    return `OK locked ${r.locks.map(formatTarget).join(", ")} (waited ${took(r.waitedMs)})`;
  if (r.status === "free") return `FREE (waited ${took(r.waitedMs)})`;
  const d = renderDenied(
    {
      status: "denied",
      conflicts: r.conflicts,
      holders: r.holders,
      advice: r.advice,
      openJobs: [],
    },
    free
  );
  return `STILL ${d.replace(/^DENIED /, "HELD ")}\n  (waited ${took(r.waitedMs)}; wait again, queue without blocking with defer:true, or move on)`;
}

export function renderWrite(r: WriteResult, free?: Record<string, string[]>): string {
  switch (r.status) {
    case "applied": {
      const extra = [
        r.autoLocked.length
          ? `auto-locked ${r.autoLocked.map((t) => t.split("#")[1] || t).join(", ")}`
          : "",
        r.merged ? "merged with a teammate's concurrent edit" : "",
      ]
        .filter(Boolean)
        .join("; ");
      return `OK wrote ${r.path}${r.touched.length ? ` [${r.touched.join(", ")}]` : ""}${extra ? ` · ${extra}` : ""} · hash ${r.hash}`;
    }
    case "denied":
      return `${renderDenied(r.acquire, free)}\n  Nothing was written.`;
    case "conflict":
      return `CONFLICT ${r.path}: ${r.message}`;
    case "error":
      return `ERROR ${r.path}: ${r.message}`;
  }
}

export function renderLocks(locks: Lock[], me?: string): string {
  if (!locks.length) return "No locks held.";
  const now = Date.now();
  return locks
    .map(
      (l) =>
        `${l.agent.id === me ? "*" : " "} ${formatTarget(l)}  ${l.agent.name}@${l.agent.device}: "${l.intent}"${l.jobId ? ` · ${l.jobId}` : ""} · ${ago(now - l.acquiredAt)}`
    )
    .join("\n");
}

export function renderJob(j: Job): string {
  const who = j.assignee ? ` → ${j.assignee.name}` : "";
  const deps = j.dependencies.length ? ` after ${j.dependencies.join(",")}` : "";
  return `${j.id} [${j.status}${j.status === "todo" ? `/${j.priority}` : ""}] ${j.title}${who}${deps}`;
}

export function renderClaim(r: ClaimResult): string {
  if (r.status === "claimed")
    return `CLAIMED ${r.job.id}: ${r.job.title}${r.job.description ? `\n${r.job.description}` : ""}\nEdits you make now are tagged to ${r.job.id}; finishing it releases their locks.`;
  if (r.status === "none") {
    if (!r.blocked.length) return "NO_JOBS open. Post one, or ask the user what's next.";
    return `NO_JOBS claimable. Blocked: ${r.blocked.map((b) => `${b.id} (waits on ${b.waitingOn.join(",")})`).join("; ")}`;
  }
  return `UNAVAILABLE ${r.job.id} is ${r.reason}${r.job.assignee ? ` (${r.job.assignee.name})` : ""}.`;
}

/** Events agents never need in their context: device heartbeats, and write outcomes that a lock event already told them. */
const QUIET = new Set<AxisEvent["type"]>(["device.report", "write.applied", "write.blocked"]);

/** The ambient "meanwhile, on your team" trailer, at most `max` lines. */
export function renderTeam(events: AxisEvent[], myId: string | undefined, max = 4): string {
  const now = Date.now();
  const theirs = events.filter((e) => e.agent?.id !== myId && !QUIET.has(e.type));
  if (!theirs.length) return "";
  const shown = theirs.slice(-max);
  const more = theirs.length - shown.length;
  return `\nteam${more ? ` (+${more} earlier)` : ""}:\n${shown.map((e) => `  ${ago(now - e.ts)} ${e.text}`).join("\n")}`;
}

/** `axis stats`: contention over a window, for people, not agents. */
export function renderStats(c: Contention, hours: number): string {
  const t = c.totals;
  const lines = [
    `last ${hours}h: ${t.denials} denied, ${t.waits} waited (${took(t.waitedMs)} total), ${t.handoffs} deferred hand-off${t.handoffs === 1 ? "" : "s"}, ${t.early} lapsed early, ${t.forced} forced`,
    `locks held: ${c.holds.count}, median ${took(c.holds.medianMs)}, p90 ${took(c.holds.p90Ms)}`,
  ];
  if (c.hot.length) {
    lines.push("hot spots:");
    for (const h of c.hot)
      lines.push(
        `  ${h.target}  ${h.denials} denied${h.waits ? `, ${h.waits} waited (max ${took(h.maxWaitMs)})` : ""}${h.early ? `, ${h.early} lapsed early` : ""}  held by ${h.holders.join(", ") || "?"}`
      );
  } else lines.push("hot spots: none, nobody got in anybody's way");
  if (c.pairs.length) {
    lines.push("who blocks whom:");
    for (const p of c.pairs) lines.push(`  ${p.blocker} blocked ${p.blocked} ${p.count}x`);
  }
  return lines.join("\n");
}
