import { useState } from "react";
import type { Job, JobStatus, Priority } from "../../../src/protocol/types.ts";
import { ago, fullTime, useNow } from "../lib/time.ts";
import { CheckCircle, Circle, HalfCircle } from "./icons.tsx";
import { Empty, Panel, Skeleton } from "./ui.tsx";

const PRIORITY: Record<Priority, { label: string; rank: number }> = {
  critical: { label: "Critical", rank: 0 },
  high: { label: "High", rank: 1 },
  medium: { label: "Medium", rank: 2 },
  low: { label: "Low", rank: 3 },
};

const COLUMNS: { key: "todo" | "in_progress" | "done"; title: string; icon: typeof Circle }[] = [
  { key: "todo", title: "To do", icon: Circle },
  { key: "in_progress", title: "In progress", icon: HalfCircle },
  { key: "done", title: "Done", icon: CheckCircle },
];

const DONE_PREVIEW = 6;

function PriorityTag({ p }: { p: Priority }) {
  const meta = PRIORITY[p] ?? PRIORITY.medium;
  return (
    <span className={`prio prio-${p}`}>
      <span className="prio-bars" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      {meta.label}
    </span>
  );
}

function JobCard({ job, statusOf }: { job: Job; statusOf: (id: string) => JobStatus | undefined }) {
  const now = useNow();
  const waiting = job.status === "todo" ? job.dependencies.filter((d) => statusOf(d) !== "done") : [];
  const cancelled = job.status === "cancelled";
  return (
    <li className={`job ${cancelled ? "job-cancelled" : ""}`}>
      <div className="job-top">
        <span className="mono job-id">{job.id}</span>
        {cancelled ? <span className="badge">Cancelled</span> : job.status !== "done" && <PriorityTag p={job.priority} />}
      </div>
      <p className="job-title">{job.title}</p>
      {job.outcome && <p className="job-outcome">{job.outcome}</p>}
      <p className="job-meta">
        {job.assignee ? <span className="mono">{job.assignee.name}</span> : <span className="muted">Unassigned</span>}
        <span className="sep" aria-hidden="true" />
        <span className="num" title={`Updated ${fullTime(job.updatedAt)}`}>
          {ago(now - job.updatedAt)}
        </span>
      </p>
      {job.dependencies.length > 0 && (
        <p className={`job-deps ${waiting.length ? "job-blocked" : ""}`}>
          {waiting.length ? "Blocked by " : "After "}
          {job.dependencies.map((d, i) => (
            <span key={d}>
              {i > 0 && ", "}
              <span className={`mono ${statusOf(d) === "done" ? "dep-done" : ""}`}>{d}</span>
            </span>
          ))}
        </p>
      )}
    </li>
  );
}

export function JobsPanel({ jobs, loading }: { jobs: Job[]; loading: boolean }) {
  const [showAllDone, setShowAllDone] = useState(false);
  const statusById = new Map(jobs.map((j) => [j.id, j.status]));
  const statusOf = (id: string) => statusById.get(id);
  const byCol = {
    todo: jobs.filter((j) => j.status === "todo").sort((a, b) => PRIORITY[a.priority].rank - PRIORITY[b.priority].rank || a.createdAt - b.createdAt),
    in_progress: jobs.filter((j) => j.status === "in_progress").sort((a, b) => b.updatedAt - a.updatedAt),
    done: jobs.filter((j) => j.status === "done" || j.status === "cancelled").sort((a, b) => b.updatedAt - a.updatedAt),
  };
  const open = byCol.todo.length + byCol.in_progress.length;

  return (
    <Panel id="jobs" title="Jobs" count={loading ? undefined : `${open} open`}>
      {loading ? (
        <Skeleton rows={3} />
      ) : jobs.length === 0 ? (
        <Empty icon={<Circle size={18} />} title="The job board is empty" cmd='axis post "Add rate limiting to login"'>
          Post work for agents to claim. Blocked agents get open jobs offered as somewhere else to work.
        </Empty>
      ) : (
        <div className="board">
          {COLUMNS.map((c) => {
            const list = byCol[c.key];
            const shown = c.key === "done" && !showAllDone ? list.slice(0, DONE_PREVIEW) : list;
            const Icon = c.icon;
            return (
              <section key={c.key} className={`col col-${c.key}`} aria-labelledby={`col-${c.key}`}>
                <h3 className="col-title" id={`col-${c.key}`}>
                  <Icon size={14} />
                  {c.title}
                  <span className="num col-count">{list.length}</span>
                </h3>
                {list.length === 0 ? (
                  <p className="col-empty">{c.key === "todo" ? "Nothing waiting" : c.key === "in_progress" ? "No one is working a job" : "Nothing finished yet"}</p>
                ) : (
                  <ul className="job-list" role="list">
                    {shown.map((j) => (
                      <JobCard key={j.id} job={j} statusOf={statusOf} />
                    ))}
                  </ul>
                )}
                {c.key === "done" && list.length > DONE_PREVIEW && (
                  <button type="button" className="btn btn-quiet btn-sm col-more" onClick={() => setShowAllDone((v) => !v)} aria-expanded={showAllDone}>
                    {showAllDone ? "Show fewer" : `Show all ${list.length}`}
                  </button>
                )}
              </section>
            );
          })}
        </div>
      )}
    </Panel>
  );
}
