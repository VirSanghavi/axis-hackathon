import { useId, useState, type ReactNode } from "react";
import type { AgentRef } from "../../../src/protocol/types.ts";

export function Panel({ id, title, count, aside, children, className = "" }: { id: string; title: string; count?: ReactNode; aside?: ReactNode; children: ReactNode; className?: string }) {
  const headingId = `${id}-title`;
  return (
    <section id={id} className={`panel ${className}`} aria-labelledby={headingId}>
      <header className="panel-head">
        <h2 id={headingId} className="panel-title" tabIndex={-1}>
          {title}
          {count !== undefined && <span className="panel-count num">{count}</span>}
        </h2>
        {aside && <div className="panel-aside">{aside}</div>}
      </header>
      {children}
    </section>
  );
}

/** Says what the area is for and the exact command that fills it. */
export function Empty({ icon, title, children, cmd }: { icon: ReactNode; title: string; children?: ReactNode; cmd?: string }) {
  return (
    <div className="empty">
      <span className="empty-icon">{icon}</span>
      <div className="empty-body">
        <p className="empty-title">{title}</p>
        {children && <p className="empty-text">{children}</p>}
        {cmd && <CopyCmd cmd={cmd} />}
      </div>
    </div>
  );
}

export function CopyCmd({ cmd, label }: { cmd: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(cmd);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard blocked; the command is selectable text */
    }
  };
  return (
    <span className="cmd">
      <code className="cmd-text">{cmd}</code>
      <button type="button" className="cmd-copy" onClick={copy} aria-label={label ?? `Copy command: ${cmd}`}>
        {copied ? "Copied" : "Copy"}
      </button>
    </span>
  );
}

/** A file path that keeps the file name visible and lets the directory truncate first. */
export function PathText({ path, className = "" }: { path: string; className?: string }) {
  const cut = path.lastIndexOf("/");
  const dir = cut >= 0 ? path.slice(0, cut + 1) : "";
  const base = cut >= 0 ? path.slice(cut + 1) : path;
  return (
    <span className={`path ${className}`} title={path}>
      {dir && <span className="path-dir">{dir}</span>}
      <span className="path-base">{base}</span>
    </span>
  );
}

export function Holder({ agent }: { agent: Pick<AgentRef, "name" | "device"> }) {
  return (
    <span className="holder mono" title={`${agent.name} on ${agent.device}`}>
      <span className="holder-name">{agent.name}</span>
      <span className="holder-at">@{agent.device}</span>
    </span>
  );
}

export type Tone = "ok" | "warn" | "danger" | "muted" | "accent";

export function Dot({ tone, label }: { tone: Tone; label?: string }) {
  return <span className={`dot dot-${tone}`} role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true} />;
}

/**
 * A hint that works for mouse, keyboard and touch: hover or focus shows it,
 * tapping toggles it. The trigger is a real button so it is reachable by Tab.
 */
export function Tip({ children, tip, className = "" }: { children: ReactNode; tip: ReactNode; className?: string }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  return (
    <span className={`tip ${open ? "tip-open" : ""}`} onMouseLeave={() => setOpen(false)}>
      <button type="button" className={`tip-trigger ${className}`} aria-describedby={id} aria-expanded={open} onClick={() => setOpen((o) => !o)} onBlur={() => setOpen(false)} onKeyDown={(e) => e.key === "Escape" && setOpen(false)}>
        {children}
      </button>
      <span role="tooltip" id={id} className="tip-body">
        {tip}
      </span>
    </span>
  );
}

export function Skeleton({ rows = 3, lines = 2 }: { rows?: number; lines?: number }) {
  return (
    <div className="skel" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <div className="skel-row" key={i}>
          <span className="skel-block skel-icon" />
          <div className="skel-lines">
            {Array.from({ length: lines }, (_, j) => (
              <span className="skel-block skel-line" key={j} style={{ width: `${[62, 84, 46, 70][(i + j) % 4]}%` }} />
            ))}
          </div>
          <span className="skel-block skel-meta" />
        </div>
      ))}
    </div>
  );
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
