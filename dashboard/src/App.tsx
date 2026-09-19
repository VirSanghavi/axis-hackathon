import { useCallback, useEffect, useMemo, useState } from "react";
import type { Lock } from "../../src/protocol/types.ts";
import { AgentsPanel } from "./components/Agents.tsx";
import { BreakDialog } from "./components/BreakDialog.tsx";
import { ConnectScreen } from "./components/Connect.tsx";
import { DevicesPanel } from "./components/Devices.tsx";
import { FeedPanel } from "./components/Feed.tsx";
import { Header } from "./components/Header.tsx";
import { Key, Plug, Refresh } from "./components/icons.tsx";
import { JobsPanel } from "./components/Jobs.tsx";
import { LocksPanel } from "./components/Locks.tsx";
import { clearCreds, lastHub, loadCreds, saveCreds, type Creds } from "./lib/creds.ts";
import { useTheme } from "./lib/theme.ts";
import { ago, NowContext, useTicker } from "./lib/time.ts";
import { useAxis } from "./lib/useAxis.ts";

export function App() {
  const [creds, setCreds] = useState<Creds | null>(() => loadCreds());
  const [notice, setNotice] = useState<string | null>(null);
  const [prevHub, setPrevHub] = useState<string | null>(() => lastHub());
  const [theme, setTheme] = useTheme();

  const connect = (c: Creds) => {
    saveCreds(c);
    setNotice(null);
    setCreds(c);
  };
  const disconnect = (why?: string) => {
    if (creds) setPrevHub(creds.hub);
    clearCreds();
    setNotice(why ?? null);
    setCreds(null);
  };

  if (!creds) return <ConnectScreen initialHub={prevHub} notice={notice} onConnect={connect} />;
  return <Dashboard key={`${creds.hub}|${creds.token}`} creds={creds} theme={theme} onTheme={setTheme} onDisconnect={disconnect} />;
}

function Dashboard({ creds, theme, onTheme, onDisconnect }: { creds: Creds; theme: ReturnType<typeof useTheme>[0]; onTheme: ReturnType<typeof useTheme>[1]; onDisconnect: (why?: string) => void }) {
  const axis = useAxis(creds);
  const now = useTicker(axis.skew);
  const [breaking, setBreaking] = useState<Lock | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const snap = axis.snapshot;
  const loading = !snap;

  useEffect(() => {
    document.title = snap ? `${snap.project.name} · Axis` : "Axis";
  }, [snap?.project.name]);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(id);
  }, [toast]);

  const reconnect = useCallback(
    (auth: boolean) => onDisconnect(auth ? "That token was not accepted. Paste a fresh one, or run axis open in the repo." : undefined),
    [onDisconnect]
  );

  const locks = snap?.locks ?? [];
  const stats = useMemo(() => {
    if (!snap) return null;
    const dayAgo = now - 24 * 3600_000;
    return {
      locks: snap.locks.length,
      files: new Set(snap.locks.map((l) => l.path)).size,
      agentsActive: snap.agents.filter((a) => a.status === "active").length,
      agents: snap.agents.length,
      devicesOnline: snap.devices.filter((d) => d.online).length,
      kernel: snap.devices.filter((d) => d.tier === "kernel").length,
      sealed: snap.devices.reduce((n, d) => n + d.sealed.length, 0),
      open: snap.jobs.filter((j) => j.status === "todo" || j.status === "in_progress").length,
      inProgress: snap.jobs.filter((j) => j.status === "in_progress").length,
      blocked: axis.events.filter((e) => (e.type === "lock.denied" || e.type === "write.blocked") && e.ts >= dayAgo).length,
    };
    // `now` only matters for the 24h window; recompute when data changes, not every second.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap, axis.events]);

  const fatal = axis.error && (axis.error.isAuth || !snap) ? axis.error : null;

  return (
    <NowContext.Provider value={now}>
      <a className="skip" href="#locks">
        Skip to locks
      </a>
      <Header project={snap?.project.name ?? null} creds={creds} transport={axis.transport} lastSyncAt={axis.lastSyncAt} theme={theme} onTheme={onTheme} onDisconnect={() => onDisconnect()} />

      {fatal ? (
        <main className="wrap">
          <ErrorState error={fatal} hub={creds.hub} onRetry={axis.retry} onReconnect={() => reconnect(fatal.isAuth)} />
        </main>
      ) : (
        <>
          {axis.error && snap && (
            <div className="wrap">
              <p className="banner" role="status">
                <span>
                  Lost contact with the hub. Showing what it said {axis.lastSyncAt ? ago(Date.now() - axis.lastSyncAt) : "earlier"}; retrying every 10 seconds.
                </span>
                <button type="button" className="btn btn-secondary btn-sm" onClick={axis.refresh}>
                  <Refresh size={14} />
                  Retry now
                </button>
              </p>
            </div>
          )}
          <Stats stats={stats} />
          <main className="wrap grid" id="main">
            <div className="area-locks">
              <LocksPanel locks={locks} devices={snap?.devices ?? []} leaseMs={axis.leaseMs} loading={loading} onBreak={setBreaking} />
            </div>
            <div className="area-feed">
              <FeedPanel events={axis.events} loading={loading} />
            </div>
            <div className="area-pair">
              <div className="pair">
                <DevicesPanel devices={snap?.devices ?? []} agents={snap?.agents ?? []} loading={loading} />
                <AgentsPanel agents={snap?.agents ?? []} locks={locks} loading={loading} />
              </div>
            </div>
            <div className="area-jobs">
              <JobsPanel jobs={snap?.jobs ?? []} loading={loading} />
            </div>
          </main>
        </>
      )}

      <BreakDialog
        lock={breaking}
        allLocks={locks}
        creds={creds}
        onClose={() => setBreaking(null)}
        onDone={(n) => {
          setBreaking(null);
          // The Break button left with its lock; put focus somewhere meaningful.
          requestAnimationFrame(() => document.getElementById("locks-title")?.focus());
          setToast(n ? `Broke ${n} lock${n === 1 ? "" : "s"}. The team feed shows who and why.` : "That lock was already gone.");
          axis.refresh();
        }}
      />
      <div className="toast-region" aria-live="polite">
        {toast && <p className="toast">{toast}</p>}
      </div>
    </NowContext.Provider>
  );
}

type StatsData = {
  locks: number;
  files: number;
  agentsActive: number;
  agents: number;
  devicesOnline: number;
  kernel: number;
  sealed: number;
  open: number;
  inProgress: number;
  blocked: number;
};

function Stats({ stats }: { stats: StatsData | null }) {
  const items: { label: string; value: string; sub: string; tone?: "danger" }[] = stats
    ? [
        { label: "Locks", value: String(stats.locks), sub: `${stats.files} file${stats.files === 1 ? "" : "s"}` },
        { label: "Agents", value: `${stats.agentsActive}`, sub: `active of ${stats.agents}` },
        { label: "Devices", value: `${stats.devicesOnline}`, sub: `online · ${stats.kernel} kernel` },
        { label: "Sealed", value: String(stats.sealed), sub: "files, all devices" },
        { label: "Open jobs", value: String(stats.open), sub: `${stats.inProgress} in progress` },
        { label: "Blocked", value: String(stats.blocked), sub: "last 24h", tone: stats.blocked ? "danger" : undefined },
      ]
    : [];
  return (
    <div className="wrap">
      <dl className="stats" aria-busy={!stats}>
        {stats
          ? items.map((s) => (
              <div className={`stat ${s.tone ? `stat-${s.tone}` : ""}`} key={s.label}>
                <dt className="stat-label">{s.label}</dt>
                <dd className="stat-value num">{s.value}</dd>
                <dd className="stat-sub">{s.sub}</dd>
              </div>
            ))
          : Array.from({ length: 6 }, (_, i) => (
              <div className="stat" key={i} aria-hidden="true">
                <span className="skel-block skel-line" style={{ width: "40%" }} />
                <span className="skel-block skel-stat" />
              </div>
            ))}
      </dl>
    </div>
  );
}

function ErrorState({ error, hub, onRetry, onReconnect }: { error: { status: number; message: string; isAuth: boolean }; hub: string; onRetry: () => void; onReconnect: () => void }) {
  const title = error.isAuth ? "This token was not accepted" : error.status === 0 ? "Cannot reach the hub" : "The hub returned an error";
  const body = error.isAuth
    ? "The member token is unknown or was revoked. Run axis open in the repo for a fresh link, or paste a new token."
    : error.status === 0
      ? "Check that the hub is running and the URL is right. The dashboard retries on its own every 10 seconds."
      : "Something went wrong on the hub. Its log has the details.";
  return (
    <section className="error-state" aria-labelledby="error-title">
      <span className="error-icon">{error.isAuth ? <Key size={20} /> : <Plug size={20} />}</span>
      <h2 id="error-title" className="error-title">
        {title}
      </h2>
      <p className="error-text">{body}</p>
      <dl className="error-facts">
        <div>
          <dt>Hub</dt>
          <dd className="mono">{hub}</dd>
        </div>
        <div>
          <dt>Response</dt>
          <dd className="mono">
            {error.status ? `HTTP ${error.status}: ` : ""}
            {error.message}
          </dd>
        </div>
      </dl>
      <div className="error-actions">
        {error.isAuth ? (
          <>
            <button type="button" className="btn btn-primary" onClick={onReconnect}>
              Reconnect with a new token
            </button>
            <button type="button" className="btn btn-secondary" onClick={onRetry}>
              Try again
            </button>
          </>
        ) : (
          <>
            <button type="button" className="btn btn-primary" onClick={onRetry}>
              <Refresh size={14} />
              Retry
            </button>
            <button type="button" className="btn btn-secondary" onClick={onReconnect}>
              Change hub or token
            </button>
          </>
        )}
      </div>
    </section>
  );
}
