import { useMemo, useState } from "react";
import type { Device, Lock } from "../../../src/protocol/types.ts";
import { countdown, dur, fullTime, useNow } from "../lib/time.ts";
import { Braces, Chevron, File, Lock as LockIcon, Shield, Unlock } from "./icons.tsx";
import { Empty, Holder, Panel, PathText, Skeleton, plural } from "./ui.tsx";

interface FileGroup {
  path: string;
  locks: Lock[];
  whole: boolean;
  latest: number;
}

/** Whole-file lock first, then module glue, then symbols by name. */
function order(a: Lock, b: Lock): number {
  const rank = (l: Lock) => (l.symbol === "" ? 0 : l.symbol === "(top)" ? 1 : 2);
  return rank(a) - rank(b) || a.symbol.localeCompare(b.symbol);
}

export function groupLocks(locks: Lock[]): FileGroup[] {
  const map = new Map<string, Lock[]>();
  for (const l of locks) {
    const list = map.get(l.path);
    if (list) list.push(l);
    else map.set(l.path, [l]);
  }
  return [...map.entries()]
    .map(([path, ls]) => ({ path, locks: ls.sort(order), whole: ls.some((l) => l.symbol === ""), latest: Math.max(...ls.map((l) => l.acquiredAt)) }))
    .sort((a, b) => b.latest - a.latest || a.path.localeCompare(b.path));
}

export function LocksPanel({ locks, devices, leaseMs, loading, onBreak }: { locks: Lock[]; devices: Device[]; leaseMs: number; loading: boolean; onBreak: (l: Lock) => void }) {
  const groups = useMemo(() => groupLocks(locks), [locks]);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const toggle = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const sealedOn = useMemo(() => {
    const m = new Map<string, Device[]>();
    for (const d of devices) for (const p of d.sealed) m.set(p, [...(m.get(p) ?? []), d]);
    return m;
  }, [devices]);

  const allOpen = groups.every((g) => !collapsed.has(g.path));
  const aside =
    groups.length > 1 ? (
      <button type="button" className="btn btn-quiet btn-sm" onClick={() => setCollapsed(allOpen ? new Set(groups.map((g) => g.path)) : new Set())}>
        {allOpen ? "Collapse all" : "Expand all"}
      </button>
    ) : null;

  return (
    <Panel id="locks" title="Locks" count={loading ? undefined : `${locks.length} in ${plural(groups.length, "file")}`} aside={aside} className="panel-locks">
      {loading ? (
        <Skeleton rows={4} />
      ) : groups.length === 0 ? (
        <Empty icon={<Unlock size={18} />} title="No locks held" cmd='axis lock src/auth.ts#login -m "why"'>
          Agents lock with the <code>lock</code> tool, or edits auto-lock the functions they touch. From a terminal:
        </Empty>
      ) : (
        <ul className="files" role="list">
          {groups.map((g) => {
            const open = !collapsed.has(g.path);
            const holders = [...new Set(g.locks.map((l) => l.agent.name))];
            const sealed = sealedOn.get(g.path) ?? [];
            const bodyId = `file-${g.path.replace(/[^a-zA-Z0-9]/g, "-")}`;
            return (
              <li key={g.path} className={`file ${g.whole ? "file-whole" : ""}`}>
                <button type="button" className="file-head" aria-expanded={open} aria-controls={bodyId} onClick={() => toggle(g.path)}>
                  <Chevron className="file-chevron" />
                  <File className="file-icon" />
                  <PathText path={g.path} className="file-path" />
                  <span className="file-meta">
                    {g.whole && <span className="badge badge-warn">Whole file</span>}
                    {sealed.length > 0 && (
                      <span className="badge badge-accent" title={`Sealed on ${sealed.map((d) => d.hostname).join(", ")}`}>
                        <Shield size={12} />
                        Sealed on {sealed.length === 1 ? sealed[0]!.hostname : plural(sealed.length, "device")}
                      </span>
                    )}
                    <span className="file-count num">{plural(g.locks.length, "lock")}</span>
                    <span className="file-holders">{holders.length > 2 ? `${holders.slice(0, 2).join(", ")} +${holders.length - 2}` : holders.join(", ")}</span>
                  </span>
                </button>
                {open && (
                  <ul className="locks" id={bodyId} role="list">
                    {g.locks.map((l) => (
                      <LockRow key={l.id} lock={l} leaseMs={leaseMs} onBreak={onBreak} />
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

export function SymbolName({ symbol }: { symbol: string }) {
  if (symbol === "") {
    return (
      <span className="sym sym-whole">
        <File size={14} />
        <span>Entire file</span>
      </span>
    );
  }
  if (symbol === "(top)") {
    return (
      <span className="sym">
        <Braces size={14} className="sym-icon" />
        <span className="mono sym-leaf">(top)</span>
        <span className="sym-note">imports and module glue</span>
      </span>
    );
  }
  const cut = symbol.lastIndexOf(".");
  return (
    <span className="sym mono" title={symbol}>
      <Braces size={14} className="sym-icon" />
      <span className="sym-text">
        {cut > 0 && (
          <span className="sym-scope">
            {symbol
              .slice(0, cut + 1)
              .split(/(?<=\.)/)
              .map((part, i) => (
                <span key={i}>
                  {part}
                  <wbr />
                </span>
              ))}
          </span>
        )}
        <span className="sym-leaf">{symbol.slice(cut + 1)}</span>
      </span>
    </span>
  );
}

function LockRow({ lock, leaseMs, onBreak }: { lock: Lock; leaseMs: number; onBreak: (l: Lock) => void }) {
  const now = useNow();
  const left = lock.expiresAt - now;
  // Activity renews a lease to a full `leaseMs`, so that is the bar's 100%.
  const frac = Math.min(1, Math.max(0, left / Math.max(leaseMs, 1)));
  const tone = left <= 0 ? "danger" : frac < 0.2 ? "warn" : "ok";
  const whole = lock.symbol === "";
  return (
    <li className={`lock ${whole ? "lock-whole" : ""}`}>
      <div className="lock-target">
        <SymbolName symbol={lock.symbol} />
      </div>
      <div className="lock-main">
        <p className="lock-intent">
          <span className="sr-only">Intent: </span>&ldquo;{lock.intent}&rdquo;
        </p>
        <p className="lock-sub">
          <Holder agent={lock.agent} />
          {lock.jobId && <span className="chip mono">{lock.jobId}</span>}
          <span className="num" title={`Acquired ${fullTime(lock.acquiredAt)}`}>
            held {dur(now - lock.acquiredAt)}
          </span>
        </p>
      </div>
      <div className="lease" title={`Lease ends ${fullTime(lock.expiresAt)}. Any activity by the holder renews it.`}>
        <div className="lease-label">
          <span>{left <= 0 ? "Lapsing" : "Lease"}</span>
          <span className={`num lease-time tone-${tone}`}>{left <= 0 ? "0s" : countdown(left)}</span>
        </div>
        <div className="lease-track" role="meter" aria-label="Lease remaining" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(frac * 100)} aria-valuetext={`${countdown(left)} left`}>
          <span className={`lease-fill fill-${tone}`} style={{ width: `${frac * 100}%` }} />
        </div>
      </div>
      <div className="lock-action">
        <button type="button" className="btn btn-quiet btn-sm btn-danger-quiet" onClick={() => onBreak(lock)} aria-label={`Break lock on ${lock.symbol ? `${lock.path}#${lock.symbol}` : lock.path}, held by ${lock.agent.name}`}>
          <LockIcon size={14} />
          Break
        </button>
      </div>
    </li>
  );
}
