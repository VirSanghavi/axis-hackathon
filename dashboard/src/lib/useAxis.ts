import { useCallback, useEffect, useRef, useState } from "react";
import type { AxisEvent, ProjectSnapshot } from "../../../src/protocol/types.ts";
import { api, ApiError, streamUrl } from "./api.ts";
import type { Creds } from "./creds.ts";

/**
 * Live project state.
 *
 * Transport: a WebSocket when the hub offers one, otherwise polling
 * `/events?since=` every 1.5s (the hosted edge hub has no sockets). Events
 * only say that something changed, so any lock/agent/job/device event triggers
 * a debounced snapshot refetch, and a 10s refetch runs regardless because
 * leases and online states age without emitting anything.
 */

export type Transport = "connecting" | "live" | "polling" | "offline" | "unauthorized";

export interface AxisState {
  snapshot: ProjectSnapshot | null;
  /** Ascending by seq, deduplicated, capped. */
  events: AxisEvent[];
  /** serverTime minus local time, in ms. */
  skew: number;
  transport: Transport;
  error: ApiError | null;
  leaseMs: number;
  lastSyncAt: number | null;
  member: string | null;
}

const POLL_MS = 1_500;
const SNAPSHOT_MS = 10_000;
const WS_RETRY_MS = 20_000;
const WS_MAX_FAILURES = 3;
const DEBOUNCE_MS = 250;
const EVENT_CAP = 500;
const PAGE = 100;

const STATEFUL = /^(lock|agent|job)\.|^device\.report$/;

function mergeEvents(prev: AxisEvent[], incoming: AxisEvent[]): AxisEvent[] {
  if (!incoming.length) return prev;
  const bySeq = new Map<number, AxisEvent>();
  for (const e of prev) bySeq.set(e.seq, e);
  for (const e of incoming) if (e && typeof e.seq === "number") bySeq.set(e.seq, e);
  const out = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  return out.length > EVENT_CAP ? out.slice(out.length - EVENT_CAP) : out;
}

const initial: AxisState = {
  snapshot: null,
  events: [],
  skew: 0,
  transport: "connecting",
  error: null,
  leaseMs: 10 * 60_000,
  lastSyncAt: null,
  member: null,
};

export function useAxis(creds: Creds): AxisState & { refresh: () => void; retry: () => void } {
  const [state, setState] = useState<AxisState>(initial);
  const [epoch, setEpoch] = useState(0);
  const refreshRef = useRef<() => void>(() => {});

  useEffect(() => {
    let disposed = false;
    let lastSeq = 0;
    let ws: WebSocket | null = null;
    let wsLive = false;
    let authFailed = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let wsRetry: ReturnType<typeof setTimeout> | null = null;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    let inFlight = false;
    let again = false;
    let polling = false;
    let wsFailures = 0;
    let snapTimer: ReturnType<typeof setInterval> | null = null;

    setState(initial);

    const patch = (p: Partial<AxisState> | ((s: AxisState) => Partial<AxisState>)) => {
      if (disposed) return;
      setState((s) => ({ ...s, ...(typeof p === "function" ? p(s) : p) }));
    };

    const stopAll = () => {
      if (pollTimer) clearInterval(pollTimer);
      if (wsRetry) clearTimeout(wsRetry);
      if (debounce) clearTimeout(debounce);
      if (snapTimer) clearInterval(snapTimer);
      pollTimer = wsRetry = debounce = snapTimer = null;
      if (ws) {
        ws.onclose = ws.onerror = ws.onmessage = ws.onopen = null;
        ws.close();
        ws = null;
      }
    };

    const fail = (e: unknown) => {
      const err = e instanceof ApiError ? e : new ApiError(0, (e as Error)?.message ?? "Unknown error");
      if (err.isAuth) {
        authFailed = true;
        stopAll();
      }
      patch({ error: err, transport: err.isAuth ? "unauthorized" : "offline" });
    };

    const ingest = (events: AxisEvent[]) => {
      if (!events.length) return;
      for (const e of events) if (e.seq > lastSeq) lastSeq = e.seq;
      patch((s) => ({ events: mergeEvents(s.events, events) }));
      if (events.some((e) => STATEFUL.test(e.type))) scheduleRefresh();
    };

    const refresh = async () => {
      if (disposed || authFailed) return;
      if (inFlight) {
        again = true;
        return;
      }
      inFlight = true;
      const sentAt = Date.now();
      try {
        const snap = await api<ProjectSnapshot>(creds, "/snapshot?events=200");
        if (disposed) return;
        const receivedAt = Date.now();
        // Assume the server stamped the snapshot halfway through the round trip.
        const skew = snap.serverTime - (sentAt + receivedAt) / 2;
        const events = Array.isArray(snap.events) ? snap.events : [];
        for (const e of events) if (e.seq > lastSeq) lastSeq = e.seq;
        patch((s) => ({
          snapshot: snap,
          events: mergeEvents(s.events, events),
          skew,
          error: null,
          lastSyncAt: receivedAt,
          transport: wsLive ? "live" : polling ? "polling" : s.transport === "offline" ? "connecting" : s.transport,
        }));
      } catch (e) {
        fail(e);
      } finally {
        inFlight = false;
        if (again && !disposed) {
          again = false;
          void refresh();
        }
      }
    };
    refreshRef.current = () => void refresh();

    const scheduleRefresh = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => void refresh(), DEBOUNCE_MS);
    };

    const pollOnce = async () => {
      if (disposed || authFailed) return;
      try {
        const res = await api<{ events: AxisEvent[] }>(creds, `/events?since=${lastSeq}&limit=${PAGE}`);
        if (disposed) return;
        const events = Array.isArray(res.events) ? res.events : [];
        ingest(events);
        // A full page may have skipped events; the snapshot is the source of truth.
        if (events.length >= PAGE) scheduleRefresh();
        if (!wsLive) patch((s) => ({ transport: "polling", error: s.error && s.error.status === 0 ? null : s.error }));
      } catch (e) {
        if (e instanceof ApiError && e.isAuth) return fail(e);
        patch({ transport: "offline" });
      }
    };

    const startPolling = () => {
      if (pollTimer || disposed || authFailed) return;
      polling = true;
      void pollOnce();
      pollTimer = setInterval(() => void pollOnce(), POLL_MS);
    };
    const stopPolling = () => {
      polling = false;
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
    };

    const openSocket = () => {
      if (disposed || authFailed || typeof WebSocket === "undefined") return startPolling();
      let sock: WebSocket;
      try {
        sock = new WebSocket(streamUrl(creds));
      } catch {
        return startPolling();
      }
      ws = sock;
      sock.onmessage = (m) => {
        let frame: { type?: string; event?: AxisEvent };
        try {
          frame = JSON.parse(String(m.data));
        } catch {
          return;
        }
        if (frame.type === "hello") {
          wsLive = true;
          wsFailures = 0;
          stopPolling();
          patch({ transport: "live" });
          // Catch anything that happened between the snapshot and the socket opening.
          void pollOnce();
        } else if (frame.type === "event" && frame.event) {
          ingest([frame.event]);
        }
      };
      sock.onclose = () => {
        if (ws !== sock) return;
        ws = null;
        if (!wsLive) wsFailures++;
        wsLive = false;
        if (disposed || authFailed) return;
        startPolling();
        // A hub without sockets (the hosted edge hub) fails every time; stop asking after a few tries.
        if (wsFailures >= WS_MAX_FAILURES) return;
        if (wsRetry) clearTimeout(wsRetry);
        wsRetry = setTimeout(openSocket, wsFailures ? WS_RETRY_MS * wsFailures : 1_000);
      };
      sock.onerror = () => {
        /* onclose follows and handles the fallback */
      };
    };

    snapTimer = setInterval(() => void refresh(), SNAPSHOT_MS);

    const onWake = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("online", onWake);

    void (async () => {
      await refresh();
      if (disposed || authFailed) return;
      openSocket();
      try {
        const me = await api<{ leaseMs?: number; principal?: { memberName?: string } }>(creds, "/me");
        patch((s) => ({
          leaseMs: typeof me.leaseMs === "number" && me.leaseMs > 0 ? me.leaseMs : s.leaseMs,
          member: me.principal?.memberName ?? null,
        }));
      } catch {
        /* lease length falls back to the hub default */
      }
    })();

    return () => {
      disposed = true;
      stopAll();
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("online", onWake);
    };
  }, [creds, epoch]);

  const refresh = useCallback(() => refreshRef.current(), []);
  /** Start over: new snapshot, new socket. The only way back from a 401. */
  const retry = useCallback(() => setEpoch((n) => n + 1), []);
  return { ...state, refresh, retry };
}
