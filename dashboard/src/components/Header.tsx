import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api.ts";
import type { Creds } from "../lib/creds.ts";
import type { ThemePref } from "../lib/theme.ts";
import { ago, useNow } from "../lib/time.ts";
import type { Transport } from "../lib/useAxis.ts";
import { Monitor, Moon, Plug, Sun, UserPlus, Mark } from "./icons.tsx";
import { CopyCmd, Dot, type Tone } from "./ui.tsx";

const TRANSPORT: Record<Transport, { label: string; tone: Tone; detail: string }> = {
  live: { label: "Live", tone: "ok", detail: "Streaming events over a WebSocket." },
  polling: { label: "Live", tone: "ok", detail: "Polling the hub every 1.5 seconds (this hub has no WebSocket)." },
  connecting: { label: "Connecting", tone: "muted", detail: "Reaching the hub." },
  offline: { label: "Offline", tone: "danger", detail: "The hub is not answering. Retrying." },
  unauthorized: { label: "Not authorized", tone: "danger", detail: "The hub rejected this token." },
};

const NEXT: Record<ThemePref, ThemePref> = { system: "light", light: "dark", dark: "system" };
const THEME_NAME: Record<ThemePref, string> = { system: "System", light: "Light", dark: "Dark" };

export function Header({
  project,
  creds,
  transport,
  lastSyncAt,
  theme,
  onTheme,
  onDisconnect,
}: {
  project: string | null;
  creds: Creds;
  transport: Transport;
  lastSyncAt: number | null;
  theme: ThemePref;
  onTheme: (t: ThemePref) => void;
  onDisconnect: () => void;
}) {
  const t = TRANSPORT[transport];
  const ThemeIcon = theme === "light" ? Sun : theme === "dark" ? Moon : Monitor;
  const localNow = useNow();
  const synced = lastSyncAt ? ` Last sync ${ago(Math.max(0, Date.now() - lastSyncAt))}.` : "";
  void localNow; // re-render each second so the sync age in the tooltip stays current
  return (
    <header className="topbar">
      <div className="topbar-inner wrap">
        <div className="brand">
          <Mark size={22} className="brand-mark" />
          <div className="brand-text">
            <span className="brand-product">Axis</span>
            {transport !== "unauthorized" && (
              <span className="brand-slash" aria-hidden="true">
                /
              </span>
            )}
            {project ? (
              <h1 className="brand-project">{project}</h1>
            ) : transport === "unauthorized" ? null : (
              <span className="skel-block skel-title" role="img" aria-label="Loading project" />
            )}
          </div>
        </div>
        <p className={`conn conn-${transport}`} title={`${t.detail}${synced} Hub: ${creds.hub}`} role="status">
          <Dot tone={t.tone} />
          <span>{t.label}</span>
          <span className="sr-only">. {t.detail}</span>
        </p>
        <div className="topbar-actions">
          {transport !== "unauthorized" && <InviteButton creds={creds} />}
          <button type="button" className="btn btn-icon" onClick={() => onTheme(NEXT[theme])} aria-label={`Theme: ${THEME_NAME[theme]}. Switch to ${THEME_NAME[NEXT[theme]]}.`} title={`Theme: ${THEME_NAME[theme]}`}>
            <ThemeIcon />
          </button>
          <button type="button" className="btn btn-icon" onClick={onDisconnect} aria-label="Disconnect from this hub" title="Disconnect">
            <Plug />
          </button>
        </div>
      </div>
    </header>
  );
}

function InviteButton({ creds }: { creds: Creds }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<{ invite?: string | null; error?: string; copied?: boolean }>({});
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const click = async () => {
    if (open) return setOpen(false);
    setOpen(true);
    try {
      const { invite } = await api<{ invite: string | null }>(creds, "/invite");
      let copied = false;
      if (invite) {
        try {
          await navigator.clipboard.writeText(`axis join ${invite}`);
          copied = true;
        } catch {
          /* clipboard blocked: the popover shows the command with its own copy button */
        }
      }
      setState({ invite, copied });
    } catch (e) {
      setState({ error: (e as Error).message });
    }
  };

  return (
    <div className="pop-anchor" ref={ref}>
      <button type="button" className="btn btn-secondary invite-btn" onClick={click} aria-expanded={open} aria-haspopup="dialog">
        <UserPlus />
        <span className="invite-label">Invite</span>
      </button>
      {open && (
        <div className="pop" role="dialog" aria-label="Invite a teammate">
          {state.error ? (
            <p className="pop-error">{state.error}</p>
          ) : state.invite === undefined ? (
            <p className="muted">Fetching the invite…</p>
          ) : state.invite === null ? (
            <p className="muted">This project has no invite code. Run <code>axis invite</code> in the repo to create one.</p>
          ) : (
            <>
              <p className="pop-title">{state.copied ? "Copied. A teammate runs this in their clone:" : "A teammate runs this in their clone:"}</p>
              <CopyCmd cmd={`axis join ${state.invite}`} />
              <p className="pop-note">Outside a clone, point it at this hub:</p>
              <CopyCmd cmd={`axis join ${state.invite} --hub ${creds.hub}`} />
            </>
          )}
        </div>
      )}
    </div>
  );
}
