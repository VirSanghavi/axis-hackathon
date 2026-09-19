import { useEffect, useState } from "react";
import { api, ApiError, probeHub } from "../lib/api.ts";
import { normalizeHub, type Creds } from "../lib/creds.ts";
import { Mark, Terminal } from "./icons.tsx";
import { CopyCmd } from "./ui.tsx";

export function ConnectScreen({ initialHub, notice, onConnect }: { initialHub: string | null; notice?: string | null; onConnect: (c: Creds) => void }) {
  const [hub, setHub] = useState(initialHub ?? "");
  const [token, setToken] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ field: "hub" | "token"; message: string } | null>(null);

  // Served by a local hub? Then this origin is the hub; prefill it.
  useEffect(() => {
    if (initialHub) return;
    let live = true;
    void probeHub(window.location.origin).then((ok) => live && ok && setHub((h) => h || window.location.origin));
    return () => {
      live = false;
    };
  }, [initialHub]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const c = { hub: normalizeHub(hub), token: token.trim() };
    if (!/^https?:\/\/[^\s]+$/i.test(c.hub)) return setError({ field: "hub", message: "Enter the hub's full URL, starting with http:// or https://." });
    if (!c.token) return setError({ field: "token", message: "Paste a member token." });
    setBusy(true);
    setError(null);
    try {
      await api(c, "/me", { timeoutMs: 10_000 });
      onConnect(c);
    } catch (err) {
      const a = err as ApiError;
      setBusy(false);
      if (a.isAuth) setError({ field: "token", message: "The hub did not accept this token. Run axis open in the repo for a fresh link." });
      else setError({ field: "hub", message: a.message });
    }
  };

  return (
    <main className="connect">
      <div className="connect-card">
        <div className="connect-brand">
          <Mark size={28} className="brand-mark" />
          <span className="connect-product">Axis</span>
        </div>
        <h1 className="connect-title">Open your project&rsquo;s live board</h1>
        <p className="connect-lede">Locks, agents, devices and the job board for every coding agent on your team, updating as they work.</p>
        {notice && (
          <p className="notice" role="alert">
            {notice}
          </p>
        )}

        <div className="connect-cmd">
          <p className="connect-step">
            <Terminal size={14} />
            In a repo that uses Axis, run this. It opens this page already connected.
          </p>
          <CopyCmd cmd="axis open" />
        </div>

        <div className="divider" role="separator">
          <span>or connect by hand</span>
        </div>

        <form className="connect-form" onSubmit={submit} noValidate>
          <label className="field">
            <span className="field-label">Hub URL</span>
            <input
              className="input mono"
              type="url"
              inputMode="url"
              autoComplete="url"
              spellCheck={false}
              placeholder="https://xyz.supabase.co/functions/v1/axis"
              value={hub}
              onChange={(e) => setHub(e.target.value)}
              aria-invalid={error?.field === "hub"}
              aria-describedby={error?.field === "hub" ? "hub-error" : undefined}
            />
          </label>
          {error?.field === "hub" && (
            <p className="field-error" id="hub-error" role="alert">
              {error.message}
            </p>
          )}
          <label className="field">
            <span className="field-label">Member token</span>
            <span className="input-group">
              <input
                className="input mono"
                type={show ? "text" : "password"}
                autoComplete="off"
                spellCheck={false}
                placeholder="axm_…"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                aria-invalid={error?.field === "token"}
                aria-describedby={error?.field === "token" ? "token-error" : "token-help"}
              />
              <button type="button" className="btn btn-secondary input-addon" onClick={() => setShow((s) => !s)} aria-pressed={show}>
                {show ? "Hide" : "Show"}
              </button>
            </span>
          </label>
          {error?.field === "token" ? (
            <p className="field-error" id="token-error" role="alert">
              {error.message}
            </p>
          ) : (
            <p className="field-help" id="token-help">
              Stays in this browser only. <code>axis open --no-open</code> prints a link that includes it.
            </p>
          )}
          <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
            {busy ? "Checking…" : "Connect"}
          </button>
        </form>
      </div>
    </main>
  );
}
