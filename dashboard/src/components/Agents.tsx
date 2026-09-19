import type { Agent, Lock } from "../../../src/protocol/types.ts";
import { ago, fullTime, useNow } from "../lib/time.ts";
import { Bot } from "./icons.tsx";
import { Dot, Empty, Panel, Skeleton, plural, type Tone } from "./ui.tsx";

const STATUS: Record<Agent["status"], { label: string; tone: Tone; rank: number }> = {
  active: { label: "Active", tone: "ok", rank: 0 },
  idle: { label: "Idle", tone: "warn", rank: 1 },
  offline: { label: "Offline", tone: "muted", rank: 2 },
};

export function AgentsPanel({ agents, locks, loading }: { agents: Agent[]; locks: Lock[]; loading: boolean }) {
  const now = useNow();
  const sorted = [...agents].sort((a, b) => STATUS[a.status].rank - STATUS[b.status].rank || b.lastSeenAt - a.lastSeenAt);
  const active = agents.filter((a) => a.status === "active").length;
  const held = new Map<string, number>();
  for (const l of locks) held.set(l.agent.id, (held.get(l.agent.id) ?? 0) + 1);

  return (
    <Panel id="agents" title="Agents" count={loading ? undefined : `${active}/${agents.length} active`}>
      {loading ? (
        <Skeleton rows={3} />
      ) : sorted.length === 0 ? (
        <Empty icon={<Bot size={18} />} title="No agent sessions yet" cmd="axis init">
          Every Claude Code, Codex or Cursor session wired to Axis shows up here. Wire the agents in this repo with:
        </Empty>
      ) : (
        <ul className="agents" role="list">
          {sorted.map((a) => {
            const s = STATUS[a.status] ?? STATUS.offline;
            const n = held.get(a.id) ?? 0;
            return (
              <li key={a.id} className={`agent agent-${a.status}`}>
                <span className="agent-status">
                  <Dot tone={s.tone} />
                  <span>{s.label}</span>
                </span>
                <div className="agent-id">
                  <p className="agent-name mono">{a.name}</p>
                  <p className="agent-sub">
                    <span>{a.vendor}</span>
                    <span className="sep" aria-hidden="true" />
                    <span className="mono">{a.device}</span>
                    {n > 0 && (
                      <>
                        <span className="sep" aria-hidden="true" />
                        <span className="num">{plural(n, "lock")}</span>
                      </>
                    )}
                  </p>
                </div>
                <p className={`agent-task ${a.task ? "" : "muted"}`}>{a.task || "No current task"}</p>
                <span className="agent-seen num" title={`Last activity ${fullTime(a.lastSeenAt)}`}>
                  {ago(now - a.lastSeenAt)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
