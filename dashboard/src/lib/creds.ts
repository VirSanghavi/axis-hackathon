/**
 * Where the dashboard gets its hub URL and member token.
 *
 * `axis open` launches `<dashboard>/#hub=<url>&token=<token>`. We read the
 * fragment once, persist it so a reload keeps working, then scrub it from the
 * address bar so the token is not left in history, screenshots or a shared link.
 */

export interface Creds {
  hub: string;
  token: string;
}

const KEY = "axis.dashboard.creds";

export function normalizeHub(raw: string): string {
  return raw.trim().replace(/\/+$/, "").replace(/\/api\/v1$/, "");
}

function read(): Creds | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<Creds>;
    return typeof v.hub === "string" && typeof v.token === "string" && v.hub && v.token ? { hub: v.hub, token: v.token } : null;
  } catch {
    return null;
  }
}

export function saveCreds(c: Creds): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(c));
  } catch {
    /* private mode or blocked storage: the session still works until reload */
  }
}

export function clearCreds(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing to clear */
  }
}

/** Fragment first (a fresh `axis open` wins), then storage. */
export function loadCreds(): Creds | null {
  const hash = window.location.hash.replace(/^#/, "");
  if (hash) {
    const params = new URLSearchParams(hash);
    const hub = params.get("hub");
    const token = params.get("token");
    if (hub !== null || token !== null) {
      try {
        window.history.replaceState(null, "", window.location.pathname + window.location.search);
      } catch {
        /* sandboxed frames can refuse this; the token then stays in the URL, nothing breaks */
      }
    }
    if (token) {
      const c = { hub: normalizeHub(hub || window.location.origin), token: token.trim() };
      saveCreds(c);
      return c;
    }
  }
  return read();
}

/** The last hub we talked to, so the connect form can prefill it after a bad token. */
export function lastHub(): string | null {
  return read()?.hub ?? null;
}
