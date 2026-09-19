/**
 * Who is creating or joining a project. A hub can require people to sign in
 * (the hosted hub uses Google through Supabase Auth): the CLI signs in, sends the
 * access token once when it creates or joins, and the hub asks Supabase who it
 * belongs to. Everything after that uses the Axis member token.
 */

export interface User {
  id: string;
  email: string;
  /** Short display name used in lock output, e.g. "vir". */
  name: string;
}

export interface Identity {
  /** The token's user, or null if the auth server rejects it. */
  verify(token: string): Promise<User | null>;
}

/** What a client needs to sign in to this hub. Served at GET /api/v1/auth. */
export interface LoginConfig {
  kind: "supabase";
  url: string;
  /** The project's public (anon / publishable) key. */
  anonKey: string;
  provider: string;
}

export function displayName(email: string, metadata: Record<string, unknown> = {}): string {
  const full = [metadata.full_name, metadata.name].find(
    (v): v is string => typeof v === "string" && v.trim() !== ""
  );
  const first = full?.trim().split(/\s+/)[0];
  const raw = first || email.split("@")[0] || "member";
  return (
    raw
      .toLowerCase()
      .replace(/[^\p{L}\p{N}._-]+/gu, "")
      .slice(0, 40) || "member"
  );
}

/** Verify Supabase Auth access tokens by asking the project's auth server. */
export function supabaseIdentity(url: string, anonKey: string): Identity {
  const base = url.replace(/\/+$/, "");
  return {
    async verify(token) {
      const res = await fetch(`${base}/auth/v1/user`, {
        headers: { apikey: anonKey, authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status === 401 || res.status === 403) return null;
      if (!res.ok) throw new Error(`Supabase Auth /user returned ${res.status}`);
      const u = (await res.json()) as {
        id?: string;
        email?: string;
        user_metadata?: Record<string, unknown>;
      };
      if (!u.id || !u.email) return null;
      return { id: u.id, email: u.email, name: displayName(u.email, u.user_metadata) };
    },
  };
}

/**
 * `AXIS_ALLOWED_EMAILS`-style allow list: exact addresses and `@domain` entries,
 * comma separated. Empty means everyone who can sign in.
 */
export function emailAllowList(spec: string | undefined): ((email: string) => boolean) | undefined {
  const entries = (spec ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (!entries.length) return undefined;
  return (email) => {
    const e = email.toLowerCase();
    return entries.some((x) => (x.startsWith("@") ? e.endsWith(x) : e === x));
  };
}

/**
 * Sign-in through a Supabase project's Auth, configured from the environment:
 * AXIS_AUTH_URL (the project URL), AXIS_AUTH_KEY (its anon / publishable key),
 * AXIS_AUTH_PROVIDER (default google) and AXIS_ALLOWED_EMAILS. Unset: no sign-in.
 */
export function supabaseAuth(
  url: string | undefined,
  anonKey: string | undefined,
  provider = "google",
  allowed?: string
) {
  if (!url || !anonKey) return undefined;
  return {
    identity: supabaseIdentity(url, anonKey),
    login: { kind: "supabase" as const, url: url.replace(/\/+$/, ""), anonKey, provider },
    allow: emailAllowList(allowed),
  };
}
