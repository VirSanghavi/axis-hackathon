import { useEffect, useRef, useState } from "react";
import type { Lock } from "../../../src/protocol/types.ts";
import { formatTarget, relation } from "../../../src/protocol/target.ts";
import { api } from "../lib/api.ts";
import type { Creds } from "../lib/creds.ts";
import { dur, useNow } from "../lib/time.ts";
import { Bolt } from "./icons.tsx";
import { Holder } from "./ui.tsx";

/**
 * Force-release a lock. Uses the native <dialog> so focus is trapped, Esc
 * closes it and focus returns to the Break button without extra code.
 */
export function BreakDialog({ lock, allLocks, creds, onClose, onDone }: { lock: Lock | null; allLocks: Lock[]; creds: Creds; onClose: () => void; onDone: (broken: number) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const now = useNow();

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (lock && !d.open) {
      setReason("");
      setError(null);
      setBusy(false);
      d.showModal();
    } else if (!lock && d.open) d.close();
  }, [lock]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!lock) return;
    if (!reason.trim()) return setError("Say why. The holder and the whole team see it.");
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ broken: Lock[] }>(creds, "/locks/force", { method: "POST", body: { targets: [formatTarget(lock)], reason: reason.trim() } });
      onDone(Array.isArray(res.broken) ? res.broken.length : 0);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const target = lock ? formatTarget(lock) : "";
  // Mirror the hub: force-release removes every lock that overlaps the target.
  const alsoBroken = lock ? allLocks.filter((l) => l.id !== lock.id && relation(lock, l)) : [];
  return (
    <dialog ref={ref} className="dialog" onClose={onClose} aria-labelledby="break-title">
      {lock && (
        <form onSubmit={submit} className="dialog-body">
          <h2 id="break-title" className="dialog-title">
            <Bolt />
            Break this lock?
          </h2>
          <p className="dialog-target mono">{target}</p>
          <p className="dialog-text">
            Held by <Holder agent={lock.agent} /> for <span className="num">{dur(now - lock.acquiredAt)}</span>: &ldquo;{lock.intent}&rdquo;
          </p>
          <p className="dialog-text muted">
            {lock.symbol === ""
              ? "This is a whole-file lock. Breaking it also releases any symbol locks held inside this file."
              : "The hub breaks every overlapping lock: anything nested inside this symbol, and any lock on its enclosing class or the whole file."}{" "}
            Once no lock is left on the file, every device unseals it and the holder&rsquo;s work can be overwritten.
          </p>
          {alsoBroken.length > 0 && (
            <div className="dialog-also">
              <p className="field-label">Also breaks</p>
              <ul role="list">
                {alsoBroken.map((l) => (
                  <li key={l.id}>
                    <span className="mono">{formatTarget(l)}</span> <Holder agent={l.agent} />
                  </li>
                ))}
              </ul>
            </div>
          )}
          <label className="field">
            <span className="field-label">Reason</span>
            <textarea
              className="input"
              rows={2}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="dana's session crashed an hour ago"
              autoFocus
              aria-invalid={!!error}
              aria-describedby={error ? "break-error" : undefined}
            />
          </label>
          {error && (
            <p className="field-error" id="break-error" role="alert">
              {error}
            </p>
          )}
          <div className="dialog-actions">
            <button type="button" className="btn btn-secondary" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn btn-danger" disabled={busy}>
              {busy ? "Breaking…" : "Break lock"}
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
}
