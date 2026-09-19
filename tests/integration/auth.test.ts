import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import path from "node:path";
import { HubClient, type AuthConfig } from "../../src/client/hub-client.ts";
import {
  accessToken,
  currentSession,
  signIn,
  signOut,
  type SignIn,
} from "../../src/client/login.ts";
import { Hub } from "../../src/hub/hub.ts";
import { displayName, emailAllowList, supabaseAuth } from "../../src/hub/identity.ts";
import { serveHub } from "../../src/hub/server.ts";
import { scratchDir } from "../helpers/fs.ts";
import { testStore } from "../helpers/store.ts";

/**
 * Sign-in end to end against a stand-in for Supabase Auth that speaks the same
 * endpoints (authorize with PKCE, token for pkce and refresh_token, user): the
 * real CLI login code, the real hub API, a real browser redirect over HTTP.
 */

const ANON = "anon-key";
const USERS: Record<string, { id: string; email: string; user_metadata: Record<string, unknown> }> =
  {
    ana: { id: "u1", email: "ana@acme.dev", user_metadata: { full_name: "Ana Lima" } },
    eve: { id: "u2", email: "eve@elsewhere.io", user_metadata: {} },
  };

/** Fake auth server state; tests flip these to take the unhappy paths. */
const auth = {
  signInAs: "ana",
  denyNext: false,
  refreshWorks: true,
  challenges: new Map<string, { challenge: string; user: string }>(),
  tokens: new Map<string, string>(), // access token -> user
  refreshes: new Map<string, string>(), // refresh token -> user
  refreshCalls: 0,
};

function issue(user: string, expiresIn = 3600) {
  const access = `at_${crypto.randomUUID()}`;
  const refresh = `rt_${crypto.randomUUID()}`;
  auth.tokens.set(access, user);
  auth.refreshes.set(refresh, user);
  return Response.json({
    access_token: access,
    refresh_token: refresh,
    expires_in: expiresIn,
    user: { email: USERS[user]!.email },
  });
}

const authServer = Bun.serve({
  port: 0,
  async fetch(req) {
    const u = new URL(req.url);
    if (u.pathname === "/auth/v1/authorize") {
      const to = new URL(u.searchParams.get("redirect_to")!);
      if (auth.denyNext) {
        auth.denyNext = false;
        to.searchParams.set("error", "access_denied");
        to.searchParams.set("error_description", "The user cancelled the Google sign-in");
        return Response.redirect(to.toString(), 302);
      }
      if (
        u.searchParams.get("provider") !== "google" ||
        u.searchParams.get("code_challenge_method") !== "s256"
      )
        return new Response("bad authorize", { status: 400 });
      const code = crypto.randomUUID();
      auth.challenges.set(code, {
        challenge: u.searchParams.get("code_challenge")!,
        user: auth.signInAs,
      });
      to.searchParams.set("code", code);
      return Response.redirect(to.toString(), 302);
    }
    if (req.headers.get("apikey") !== ANON)
      return Response.json({ msg: "no apikey" }, { status: 401 });
    if (u.pathname === "/auth/v1/token") {
      const b = (await req.json()) as Record<string, string>;
      if (u.searchParams.get("grant_type") === "pkce") {
        const c = auth.challenges.get(b.auth_code!);
        auth.challenges.delete(b.auth_code!);
        const ok =
          c && createHash("sha256").update(b.code_verifier!).digest("base64url") === c.challenge;
        return ok
          ? issue(c.user)
          : Response.json({ error_description: "invalid flow state" }, { status: 400 });
      }
      auth.refreshCalls++;
      const user = auth.refreshes.get(b.refresh_token!);
      if (!user || !auth.refreshWorks)
        return Response.json({ error_description: "refresh token revoked" }, { status: 400 });
      auth.refreshes.delete(b.refresh_token!);
      return issue(user);
    }
    if (u.pathname === "/auth/v1/user") {
      const user = auth.tokens.get((req.headers.get("authorization") ?? "").slice(7));
      return user ? Response.json(USERS[user]) : Response.json({ msg: "bad jwt" }, { status: 401 });
    }
    return new Response("not found", { status: 404 });
  },
});
const AUTH_URL = `http://127.0.0.1:${authServer.port}`;

/** The browser: follows the authorize redirect back to the CLI's loopback server. */
const browser = (url: string) => void fetch(url);

let home: ReturnType<typeof scratchDir>;
let hub: Hub;
let server: ReturnType<typeof serveHub>;
let open: ReturnType<typeof serveHub>;
let hubUrl: string;
let openUrl: string;
let cfg: SignIn;

beforeAll(async () => {
  home = scratchDir("axis-auth-");
  process.env.AXIS_HOME = home.dir;
  hub = new Hub(await testStore(), { sweepMs: 0 });
  server = serveHub({
    hub,
    port: 0,
    auth: supabaseAuth(AUTH_URL, ANON, "google", "@acme.dev, eve@elsewhere.io"),
  });
  open = serveHub({ hub, port: 0 });
  hubUrl = `http://127.0.0.1:${server.port}`;
  openUrl = `http://127.0.0.1:${open.port}`;
  const c = await HubClient.authConfig(hubUrl);
  if (!c.required) throw new Error("hub should require sign-in");
  cfg = c;
});

afterAll(() => {
  server.stop(true);
  open.stop(true);
  hub.close();
  authServer.stop(true);
  delete process.env.AXIS_HOME;
  home.dispose();
});

describe("sign-in (PKCE through the browser)", () => {
  test("the hub tells clients how to sign in; an open hub says none is needed", async () => {
    expect(cfg).toEqual({
      required: true,
      kind: "supabase",
      url: AUTH_URL,
      anonKey: ANON,
      provider: "google",
    });
    expect(await HubClient.authConfig(openUrl)).toEqual({ required: false } as AuthConfig);
  });

  test("a cancelled sign-in fails with the provider's reason and saves nothing", async () => {
    auth.denyNext = true;
    await expect(signIn(cfg, browser)).rejects.toThrow(/cancelled the Google sign-in/);
    expect(currentSession(cfg)).toBeNull();
  });

  test("a code exchanged without the matching verifier is refused", async () => {
    // Intercept the redirect and replay the code against the token endpoint with a wrong verifier.
    let code = "";
    await expect(
      signIn(
        cfg,
        async (url) => {
          const r = await fetch(url, { redirect: "manual" });
          const back = new URL(r.headers.get("location")!);
          code = back.searchParams.get("code")!;
          const stolen = await fetch(`${AUTH_URL}/auth/v1/token?grant_type=pkce`, {
            method: "POST",
            headers: { apikey: ANON, "content-type": "application/json" },
            body: JSON.stringify({ auth_code: code, code_verifier: "not-the-verifier" }),
          });
          expect(stolen.status).toBe(400);
          await fetch(back); // the real CLI now gets a code that was already burned
        },
        5000
      )
    ).rejects.toThrow(/invalid flow state/);
    expect(code).not.toBe("");
    expect(currentSession(cfg)).toBeNull();
  });

  test("signing in saves a private session and the token verifies", async () => {
    const s = await signIn(cfg, browser);
    expect(s.email).toBe("ana@acme.dev");
    expect(currentSession(cfg)?.accessToken).toBe(s.accessToken);
    expect(statSync(path.join(home.dir, "auth.json")).mode & 0o777).toBe(0o600);
    expect(await accessToken(cfg)).toBe(s.accessToken);
  });

  test("an expiring session refreshes quietly; a revoked one signs you out", async () => {
    const f = path.join(home.dir, "auth.json");
    const data = JSON.parse(await Bun.file(f).text());
    data.sessions[AUTH_URL].expiresAt = Math.floor(Date.now() / 1000) + 30;
    await Bun.write(f, JSON.stringify(data));
    const before = auth.refreshCalls;
    const fresh = await accessToken(cfg);
    expect(auth.refreshCalls).toBe(before + 1);
    expect(fresh).not.toBe(data.sessions[AUTH_URL].accessToken);
    expect(auth.tokens.has(fresh!)).toBe(true);

    const again = JSON.parse(await Bun.file(f).text());
    again.sessions[AUTH_URL].expiresAt = 0;
    await Bun.write(f, JSON.stringify(again));
    auth.refreshWorks = false;
    expect(await accessToken(cfg)).toBeNull();
    expect(currentSession(cfg)).toBeNull();
    auth.refreshWorks = true;
  });

  test("sign out forgets the session", async () => {
    await signIn(cfg, browser);
    expect(signOut(cfg)).toBe(true);
    expect(signOut(cfg)).toBe(false);
  });
});

describe("a hub that requires sign-in", () => {
  test("creating a project needs a signed-in, allowed user; the member is named after them", async () => {
    await expect(HubClient.createProject(hubUrl, { name: "p", member: "x" })).rejects.toThrow(
      /axis login/
    );
    await expect(
      HubClient.createProject(hubUrl, { name: "p", member: "x" }, { userToken: "forged" })
    ).rejects.toThrow(/expired/);

    auth.signInAs = "ana";
    const ana = await signIn(cfg, browser);
    const created = await HubClient.createProject(
      hubUrl,
      { name: "acme", member: "claims-to-be-the-ceo" },
      { userToken: ana.accessToken }
    );
    expect(created.member).toBe("ana");
    const me = await new HubClient(hubUrl, created.memberToken).me();
    expect(me.principal.memberName).toBe("ana");

    // Joining: invite alone is not enough, and the allow list is enforced.
    await expect(HubClient.join(hubUrl, created.invite, "ben")).rejects.toThrow(/axis login/);
    const outsider = [...auth.tokens.keys()].find((t) => auth.tokens.get(t) === "ana")!;
    auth.tokens.set("t_mallory", "mallory");
    USERS.mallory = { id: "u3", email: "mallory@evil.test", user_metadata: {} };
    await expect(HubClient.join(hubUrl, created.invite, "m", "t_mallory")).rejects.toThrow(
      /mallory@evil.test is not allowed/
    );
    await expect(HubClient.join(hubUrl, "nope", "x", outsider)).rejects.toThrow(/not valid/);

    auth.signInAs = "eve";
    signOut(cfg);
    const eve = await signIn(cfg, browser);
    const joined = await HubClient.join(hubUrl, created.invite, "whatever", eve.accessToken);
    expect(joined.member).toBe("eve");
    expect(joined.projectId).toBe(created.project.id);
  });

  test("a hub without sign-in keeps the self-named, invite-only flow", async () => {
    const created = await HubClient.createProject(openUrl, { name: "open", member: "dana" });
    expect(created.member).toBe("dana");
    const joined = await HubClient.join(openUrl, created.invite, "ben");
    expect(joined.member).toBe("ben");
  });
});

describe("identity helpers", () => {
  test("display names come from the profile's first name, else the email", () => {
    expect(displayName("ana@acme.dev", { full_name: "Ana Lima" })).toBe("ana");
    expect(displayName("Vir.S@gmail.com", {})).toBe("vir.s");
    expect(displayName("x@y.z", { name: "  " })).toBe("x");
    expect(displayName("@", {})).toBe("member");
  });
  test("allow lists match exact addresses and @domains, case-insensitively", () => {
    expect(emailAllowList("")).toBeUndefined();
    const allow = emailAllowList(" @Acme.dev , eve@elsewhere.io")!;
    expect(allow("bob@ACME.dev")).toBe(true);
    expect(allow("eve@elsewhere.io")).toBe(true);
    expect(allow("eve@elsewhere.io.evil")).toBe(false);
    expect(allow("bob@notacme.dev")).toBe(false);
  });
});
