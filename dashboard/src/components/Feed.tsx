import { useMemo, useState, type ReactNode } from "react";
import type { AxisEvent, EventType } from "../../../src/protocol/types.ts";
import { ago, fullTime, useNow } from "../lib/time.ts";
import * as I from "./icons.tsx";
import { Empty, Panel, Skeleton } from "./ui.tsx";

type Kind = "danger" | "warn" | "ok" | "accent" | "muted";

const LOOK: Record<EventType, { icon: (p: { size?: number }) => ReactNode; kind: Kind; label: string }> = {
  "lock.denied": { icon: I.Ban, kind: "danger", label: "Denied" },
  "write.blocked": { icon: I.Shield, kind: "danger", label: "Write blocked" },
  "lock.forced": { icon: I.Bolt, kind: "warn", label: "Lock broken" },
  "lock.expired": { icon: I.Hourglass, kind: "warn", label: "Lease lapsed" },
  "lock.granted": { icon: I.Lock, kind: "accent", label: "Locked" },
  "lock.released": { icon: I.Unlock, kind: "muted", label: "Released" },
  "lock.queued": { icon: I.Hourglass, kind: "muted", label: "Queued" },
  "lock.renamed": { icon: I.Braces, kind: "muted", label: "Lock renamed" },
  "lock.moved": { icon: I.File, kind: "muted", label: "Lock moved" },
  "lock.orphaned": { icon: I.ShieldOff, kind: "danger", label: "File missing" },
  "job.posted": { icon: I.Plus, kind: "muted", label: "Job posted" },
  "job.claimed": { icon: I.HalfCircle, kind: "accent", label: "Job claimed" },
  "job.done": { icon: I.CheckCircle, kind: "ok", label: "Job done" },
  "job.released": { icon: I.Undo, kind: "muted", label: "Job released" },
  "job.cancelled": { icon: I.X, kind: "muted", label: "Job cancelled" },
  "agent.joined": { icon: I.Join, kind: "muted", label: "Joined" },
  "agent.left": { icon: I.Leave, kind: "muted", label: "Left" },
  note: { icon: I.Note, kind: "muted", label: "Note" },
  "soul.updated": { icon: I.Note, kind: "muted", label: "Project soul" },
  "write.applied": { icon: I.Pen, kind: "muted", label: "Write" },
  "device.report": { icon: I.Laptop, kind: "muted", label: "Device" },
};

const FALLBACK = { icon: I.Pulse, kind: "muted" as Kind, label: "Event" };

type Filter = "all" | "enforcement" | "locks" | "jobs";
const FILTERS: { key: Filter; label: string; test: (t: string) => boolean }[] = [
  { key: "all", label: "All", test: () => true },
  { key: "enforcement", label: "Enforcement", test: (t) => t === "lock.denied" || t === "write.blocked" || t === "lock.forced" || t === "lock.expired" || t === "lock.orphaned" },
  { key: "locks", label: "Locks", test: (t) => t.startsWith("lock.") },
  { key: "jobs", label: "Jobs", test: (t) => t.startsWith("job.") },
];

const PAGE = 60;

/** Render lock targets and file paths inside event text in mono so they scan. */
const TARGET = /((?:[\w@.-]+\/)*[\w@-]+\.[a-z][a-z0-9]{0,5}(?:#[^\s,;:)]+)?|\bJ\d+\b)/gi;
/** Allow line breaks after path separators instead of mid-word. */
function breakable(t: string) {
  return t.split(/(?<=[/#.])/).map((part, i) => (
    <span key={i}>
      {i > 0 && <wbr />}
      {part}
    </span>
  ));
}

function Rich({ text }: { text: string }) {
  const parts = text.split(TARGET);
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <code key={i} className="ev-target">
            {breakable(p)}
          </code>
        ) : (
          <span key={i}>{p}</span>
        )
      )}
    </>
  );
}

export function FeedPanel({ events, loading }: { events: AxisEvent[]; loading: boolean }) {
  const now = useNow();
  const [filter, setFilter] = useState<Filter>("all");
  const [limit, setLimit] = useState(PAGE);
  const test = FILTERS.find((f) => f.key === filter)!.test;
  const list = useMemo(() => events.filter((e) => test(e.type)).reverse(), [events, test]);
  const enforcement = useMemo(() => events.filter((e) => e.type === "lock.denied" || e.type === "write.blocked").length, [events]);

  return (
    <Panel id="feed" title="Live feed" count={loading ? undefined : enforcement ? `${enforcement} blocked` : undefined} className="panel-feed">
      <div className="seg" role="group" aria-label="Filter events">
        {FILTERS.map((f) => (
          <button key={f.key} type="button" className="seg-btn" aria-pressed={filter === f.key} onClick={() => (setFilter(f.key), setLimit(PAGE))}>
            {f.label}
          </button>
        ))}
      </div>
      <div className="feed-scroll">
        {loading ? (
          <Skeleton rows={6} lines={1} />
        ) : list.length === 0 ? (
          <Empty icon={<I.Pulse size={18} />} title={filter === "all" ? "Nothing has happened yet" : "No matching events"}>
            {filter === "enforcement"
              ? "Denied locks and writes stopped by a seal show up here. That is Axis doing its job."
              : "Locks, jobs, notes and enforcement events stream in here as agents work."}
          </Empty>
        ) : (
          <ol className="events" aria-live="off">
            {list.slice(0, limit).map((e) => {
              const look = LOOK[e.type] ?? FALLBACK;
              const Icon = look.icon;
              const loud = look.kind === "danger";
              return (
                <li key={e.seq} className={`ev ev-${look.kind} ${loud ? "ev-loud" : ""}`}>
                  <span className="ev-icon">
                    <Icon size={14} />
                  </span>
                  <div className="ev-body">
                    <p className="ev-text">
                      {loud && <span className="ev-label">{look.label}</span>}
                      <Rich text={e.text} />
                    </p>
                    <p className="ev-meta">
                      {!loud && <span>{look.label}</span>}
                      {!loud && <span className="sep" aria-hidden="true" />}
                      <time className="num" dateTime={new Date(e.ts).toISOString()} title={fullTime(e.ts)}>
                        {ago(now - e.ts)}
                      </time>
                    </p>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
        {list.length > limit && (
          <button type="button" className="btn btn-quiet btn-sm feed-more" onClick={() => setLimit((l) => l + PAGE)}>
            Show older events
          </button>
        )}
      </div>
    </Panel>
  );
}
