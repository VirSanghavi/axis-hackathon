import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { axisHome } from "./config.ts";
import type { AuthConfig } from "./hub-client.ts";

/**
 * Signing in to a hub that requires it (the hosted hub: Google through Supabase
 * Auth). The browser does the OAuth dance and hands a one-time code back to a
 * server on 127.0.0.1; the code is exchanged with the PKCE verifier that never
 * left this process. Sessions live in ~/.axis/auth.json (0600), keyed by the
 * auth server, and are refreshed quietly.
 */

export type SignIn = Extract<AuthConfig, { required: true }>;

export interface AuthSession {
  accessToken: string;
  refreshToken: string;
  /** Unix seconds. */
  expiresAt: number;
  email: string;
}

const file = () => path.join(axisHome(), "auth.json");
const key = (cfg: SignIn) => cfg.url.replace(/\/+$/, "");
const b64url = (b: Buffer) => b.toString("base64url");

function readAll(): Record<string, AuthSession> {
  try {
    return JSON.parse(readFileSync(file(), "utf8")).sessions ?? {};
  } catch {
    return {};
  }
}

function save(cfg: SignIn, s: AuthSession | null): void {
  const all = readAll();
  if (s) all[key(cfg)] = s;
  else delete all[key(cfg)];
  mkdirSync(axisHome(), { recursive: true, mode: 0o700 });
  if (!Object.keys(all).length) return rmSync(file(), { force: true });
  writeFileSync(file(), JSON.stringify({ sessions: all }, null, 2), { mode: 0o600 });
  chmodSync(file(), 0o600);
}

export function signOut(cfg: SignIn): boolean {
  const had = !!readAll()[key(cfg)];
  save(cfg, null);
  return had;
}

export function currentSession(cfg: SignIn): AuthSession | null {
  return readAll()[key(cfg)] ?? null;
}

type TokenResponse = {
  access_token: string;
  refresh_token: string;
  expires_at?: number;
  expires_in?: number;
  user?: { email?: string };
  error_description?: string;
  msg?: string;
};

async function token(cfg: SignIn, grant: string, body: Record<string, string>) {
  const res = await fetch(`${key(cfg)}/auth/v1/token?grant_type=${grant}`, {
    method: "POST",
    headers: { apikey: cfg.anonKey, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const data = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || !data.access_token)
    throw new Error(data.error_description ?? data.msg ?? `sign-in failed (${res.status})`);
  const session: AuthSession = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: data.expires_at ?? Math.floor(Date.now() / 1000) + (data.expires_in ?? 3600),
    email: data.user?.email ?? "",
  };
  return session;
}

/** A valid access token, refreshing the saved session if it is about to expire. Null if signed out. */
export async function accessToken(cfg: SignIn): Promise<string | null> {
  const s = currentSession(cfg);
  if (!s) return null;
  if (s.expiresAt - 60 > Date.now() / 1000) return s.accessToken;
  try {
    const fresh = await token(cfg, "refresh_token", { refresh_token: s.refreshToken });
    save(cfg, { ...fresh, email: fresh.email || s.email });
    return fresh.accessToken;
  } catch {
    save(cfg, null);
    return null;
  }
}

const PAGE = (title: string, detail: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Axis sign-in</title>
<style>
:root{--bg:#f5f6f5;--surface:#fcfcfb;--line:#e1e5e3;--fg:#111714;--fg-3:#5a6560;--accent:#03714f;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#0b0d0c;--surface:#111413;--line:#232927;--fg:#e8ecea;--fg-3:#8d9793;--accent:#3dd6a0}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;padding:16px;box-sizing:border-box}
main{max-width:420px;width:100%;background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:28px 24px}
b{display:block;font-family:ui-monospace,"SF Mono",Menlo,monospace;font-size:13px;color:var(--accent);margin-bottom:12px;letter-spacing:.02em}
h1{font-size:20px;line-height:1.3;margin:0 0 6px;font-weight:650}
p{margin:0;color:var(--fg-3)}
</style></head><body><main><b>axis</b><h1>${title}</h1><p>${detail}</p></main></body></html>`;

const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!
  );

/**
 * Sign in through the browser. `open` shows the URL to the user (the CLI opens
 * the default browser); the promise settles when the browser comes back.
 */
export async function signIn(
  cfg: SignIn,
  open: (url: string) => void,
  timeoutMs = 5 * 60_000
): Promise<AuthSession> {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  let settle!: (r: { code?: string; error?: string }) => void;
  const result = new Promise<{ code?: string; error?: string }>((r) => (settle = r));
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      if (u.pathname !== "/callback") return new Response("Not found", { status: 404 });
      const code = u.searchParams.get("code") ?? undefined;
      const error =
        u.searchParams.get("error_description") ?? u.searchParams.get("error") ?? undefined;
      settle(code ? { code } : { error: error ?? "the sign-in page returned no code" });
      const html = code
        ? PAGE(
            "Back to your terminal",
            "Axis is finishing your sign-in there. You can close this tab."
          )
        : PAGE(
            "Sign-in didn't finish",
            escape(error ?? "No code came back. Run axis login again.")
          );
      return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
    },
  });
  const timer = setTimeout(() => settle({ error: "timed out waiting for the browser" }), timeoutMs);
  try {
    const redirect = `http://127.0.0.1:${server.port}/callback`;
    const authorize = new URL(`${key(cfg)}/auth/v1/authorize`);
    authorize.searchParams.set("provider", cfg.provider);
    authorize.searchParams.set("redirect_to", redirect);
    authorize.searchParams.set("code_challenge", challenge);
    authorize.searchParams.set("code_challenge_method", "s256");
    open(authorize.toString());
    const r = await result;
    if (!r.code) throw new Error(`Sign-in failed: ${r.error}`);
    const session = await token(cfg, "pkce", { auth_code: r.code, code_verifier: verifier });
    save(cfg, session);
    return session;
  } finally {
    clearTimeout(timer);
    // Graceful: the browser's page is still being sent.
    void server.stop();
  }
}
