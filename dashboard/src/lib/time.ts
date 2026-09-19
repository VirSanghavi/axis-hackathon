import { createContext, useContext, useEffect, useState } from "react";

/**
 * One clock for the whole page, corrected to the hub's clock. `skew` is
 * serverTime minus local time at the moment a snapshot arrived, so lease
 * countdowns stay right even when the viewer's laptop clock is off.
 */
export const NowContext = createContext<number>(Date.now());

export function useNow(): number {
  return useContext(NowContext);
}

export function useTicker(skew: number): number {
  const [now, setNow] = useState(() => Date.now() + skew);
  useEffect(() => {
    setNow(Date.now() + skew);
    const id = setInterval(() => setNow(Date.now() + skew), 1000);
    return () => clearInterval(id);
  }, [skew]);
  return now;
}

/** Compact duration: 12s, 4m, 1h 5m, 2d 3h. */
export function dur(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

/** Countdown with seconds so a lease visibly ticks: 9m 04s, 42s. */
export function countdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return dur(ms);
}

export function ago(ms: number): string {
  if (ms < 5_000) return "just now";
  return `${dur(ms)} ago`;
}

export function clock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function fullTime(ts: number): string {
  return new Date(ts).toLocaleString([], { dateStyle: "medium", timeStyle: "medium" });
}
