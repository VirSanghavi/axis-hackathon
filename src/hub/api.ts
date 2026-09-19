import { Hub, HttpError } from "./hub.ts";
import type { Identity, LoginConfig } from "./identity.ts";
import type { DeviceHealth } from "../protocol/types.ts";
import type { Principal } from "./store.ts";

/**
 * The hub's HTTP API as a plain `Request -> Response` function, with no runtime
 * APIs of its own, so the same code serves the local Bun hub and the hosted
 * Deno edge function.
 */

export interface ApiOptions {
  /** If set, creating a project requires `Authorization: Bearer <secret>`. */
  adminSecret?: string;
  /**
   * Require people to sign in before they create or join a project. The client
   * sends its access token as `x-user-token`; members are then named after the
   * signed-in user. `allow` further limits who may (by email).
   */
  auth?: { identity: Identity; login: LoginConfig; allow?: (email: string) => boolean };
}

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};
export const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type, x-region, x-user-token",
  "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
};

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...CORS } });
}

/** Bearer token from the header, or `?token=` (browsers cannot set headers on a WebSocket). */
export async function authenticate(hub: Hub, req: Request, url: URL): Promise<Principal> {
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ")
    ? header.slice(7).trim()
    : (url.searchParams.get("token") ?? "");
  if (!token)
    throw new HttpError(
      401,
      "Missing bearer token. Run `axis join <invite>` or `axis init` on this machine."
    );
  const p = await hub.store.authenticate(token);
  if (!p) throw new HttpError(401, "Unknown or revoked token.");
  return p;
}

/**
 * Handle `route` (the path after `/api/v1`). Errors become JSON: HttpError keeps
 * its status, anything else is a 500 whose detail stays in the hub log.
 */
export function createApi(hub: Hub, opts: ApiOptions = {}) {
  const body = async <T>(req: Request): Promise<T> => {
    try {
      return (await req.json()) as T;
    } catch {
      return {} as T;
    }
  };

  /** The signed-in caller when this hub requires sign-in; null when it does not. */
  async function signedIn(req: Request) {
    if (!opts.auth) return null;
    const token = req.headers.get("x-user-token")?.trim();
    if (!token) throw new HttpError(401, "Sign in first: run `axis login`.");
    const user = await opts.auth.identity.verify(token);
    if (!user) throw new HttpError(401, "Your sign-in has expired. Run `axis login` again.");
    if (opts.auth.allow && !opts.auth.allow(user.email))
      throw new HttpError(
        403,
        `${user.email} is not allowed on this hub. Ask its owner to add you.`
      );
    return user;
  }

  async function route(req: Request, url: URL, route: string): Promise<Response> {
    const m = req.method;

    // ── unauthenticated (signed in, on hubs that require it) ──────────────
    if (route === "/auth" && m === "GET")
      return json(opts.auth ? { required: true, ...opts.auth.login } : { required: false });
    if (route === "/projects" && m === "POST") {
      if (opts.adminSecret) {
        const h = req.headers.get("authorization") ?? "";
        if (h !== `Bearer ${opts.adminSecret}`)
          throw new HttpError(401, "This hub requires its admin secret to create projects.");
      }
      const b = await body<{ name?: string; member?: string }>(req);
      if (!b.name?.trim()) throw new HttpError(400, "name is required");
      const user = await signedIn(req);
      const member = user?.name ?? (b.member?.trim().slice(0, 40) || "owner");
      const created = await hub.store.createProject(b.name.trim().slice(0, 80), member);
      return json({ ...created, member }, 201);
    }
    if (route === "/join" && m === "POST") {
      const b = await body<{ invite?: string; member?: string }>(req);
      const user = await signedIn(req);
      const member = user?.name ?? (b.member?.trim().slice(0, 40) || "teammate");
      const joined = await hub.store.join((b.invite ?? "").trim(), member);
      if (!joined)
        throw new HttpError(
          404,
          "That invite is not valid on this hub. Ask for a fresh one with `axis invite`."
        );
      return json({ ...joined, member }, 201);
    }

    // ── authenticated ─────────────────────────────────────────────────────
    const who = await authenticate(hub, req, url);

    switch (true) {
      case route === "/me" && m === "GET":
        return json({ principal: who, leaseMs: hub.leaseMs });

      case route === "/agents" && m === "POST": {
        const b = await body<{ name?: string; vendor?: string; device?: string; task?: string }>(
          req
        );
        return json(await hub.startAgent(who, b), 201);
      }
      case route === "/agents/me" && m === "DELETE":
        return json({ released: (await hub.endAgent(who)).length });
      case route === "/heartbeat" && m === "POST": {
        const b = await body<{ task?: string }>(req);
        await hub.touch(who, b.task);
        return json({ ok: true });
      }

      case route === "/snapshot" && m === "GET":
        return json(
          await hub.snapshot(
            who.projectId,
            who.projectName,
            Math.min(Number(url.searchParams.get("events") ?? 200), 500)
          )
        );

      case route === "/locks" && m === "GET":
        return json({ locks: await hub.store.listLocks(who.projectId) });
      case route === "/locks/watch" && m === "GET":
        return json(
          await hub.watchLocks(
            who.projectId,
            Number(url.searchParams.get("since") ?? -1),
            Number(url.searchParams.get("wait") ?? 0)
          )
        );
      case route === "/locks/mine" && m === "GET":
        return json({ locks: who.agent ? await hub.store.locksOf(who.agent.id) : [] });
      case route === "/locks" && m === "POST": {
        const b = await body<{ targets?: string[]; intent?: string; jobId?: string }>(req);
        return json(await hub.acquire(who, b.targets ?? [], b.intent ?? "", b.jobId));
      }
      case route === "/locks/release" && m === "POST": {
        const b = await body<{ targets?: string[]; all?: boolean }>(req);
        return json(await hub.release(who, b.all ? "all" : (b.targets ?? [])));
      }
      case route === "/locks/wait" && m === "POST": {
        const b = await body<{
          targets?: string[];
          timeoutMs?: number;
          acquire?: boolean;
          intent?: string;
          jobId?: string;
          defer?: boolean;
          holdMs?: number;
        }>(req);
        if (b.defer) {
          if (!b.intent?.trim())
            throw new HttpError(400, "intent is required to queue for a lock.");
          return json(await hub.defer(who, b.targets ?? [], b.intent, b.jobId, b.holdMs));
        }
        return json(await hub.wait(who, b.targets ?? [], b));
      }
      case route === "/feed" && m === "POST": {
        // What an agent should hear on each call: new team events, and anything the queue handed it.
        const b = await body<{ since?: number; limit?: number }>(req);
        const handoffs = await hub.handoffs(who);
        const events = await hub.store.listEvents(
          who.projectId,
          Number(b.since ?? 0),
          Math.min(Number(b.limit ?? 50), 500)
        );
        return json({ events, handoffs });
      }
      case route === "/analytics" && m === "GET":
        return json(
          await hub.contention(
            who.projectId,
            Math.min(Math.max(Number(url.searchParams.get("hours") ?? 24), 1), 24 * 30) * 3600_000
          )
        );
      case route === "/locks/rename" && m === "POST": {
        const b = await body<{ path?: string; from?: string; to?: string }>(req);
        if (!b.path || !b.from || !b.to) throw new HttpError(400, "path, from and to are required");
        return json({ followed: await hub.renameSymbol(who, b.path, b.from, b.to) });
      }
      case route === "/locks/move" && m === "POST": {
        const b = await body<{ from?: string; to?: string }>(req);
        return json({ moved: await hub.moveFile(who, b.from ?? "", b.to ?? "") });
      }
      case route === "/locks/orphaned" && m === "POST": {
        const b = await body<{ path?: string; detail?: string }>(req);
        if (!b.path) throw new HttpError(400, "path is required");
        return json({ locks: await hub.orphaned(who, b.path, (b.detail ?? "").slice(0, 200)) });
      }
      case route === "/locks/force" && m === "POST": {
        const b = await body<{ targets?: string[]; reason?: string }>(req);
        return json({ broken: await hub.forceRelease(who, b.targets ?? [], b.reason ?? "") });
      }

      case route === "/jobs" && m === "GET":
        return json({
          jobs: await hub.store.listJobs(who.projectId, url.searchParams.get("all") === "1"),
        });
      case route === "/jobs" && m === "POST":
        return json(await hub.postJob(who, await body(req)), 201);
      case route === "/jobs/claim" && m === "POST": {
        const b = await body<{ jobId?: string }>(req);
        return json(await hub.claim(who, b.jobId || undefined));
      }
      case /^\/jobs\/[^/]+\/(complete|release|cancel)$/.test(route) && m === "POST": {
        const [, , rawId, action] = route.split("/");
        const jobId = decodeURIComponent(rawId!);
        const b = await body<{ outcome?: string; reason?: string }>(req);
        if (action === "complete") return json(await hub.completeJob(who, jobId, b.outcome ?? ""));
        if (action === "release") return json({ job: await hub.releaseJob(who, jobId) });
        return json({ job: await hub.cancelJob(who, jobId, b.reason ?? "") });
      }

      case route === "/notes" && m === "POST": {
        const b = await body<{ text?: string }>(req);
        return json({ event: await hub.note(who, b.text ?? "") }, 201);
      }
      case route === "/events" && m === "GET":
        return json({
          events: await hub.store.listEvents(
            who.projectId,
            Number(url.searchParams.get("since") ?? 0),
            Math.min(Number(url.searchParams.get("limit") ?? 100), 500)
          ),
        });

      case route === "/writes" && m === "POST": {
        // Daemons and hooks report enforcement outcomes so the whole team sees them.
        const b = await body<{ status?: string; path?: string; detail?: string }>(req);
        const actor = who.agent?.name ?? who.memberName;
        const type = b.status === "blocked" ? "write.blocked" : "write.applied";
        const text =
          type === "write.blocked"
            ? `blocked a write to ${b.path} by ${actor}${b.detail ? `: ${b.detail}` : ""}`
            : `${actor} wrote ${b.path}${b.detail ? ` (${b.detail})` : ""}`;
        await hub.emit(who.projectId, type, text, who.agent, { path: b.path, detail: b.detail });
        return json({ ok: true });
      }

      case route === "/devices/report" && m === "POST": {
        const b = await body<{
          deviceId: string;
          hostname: string;
          platform: string;
          tier: "off" | "guard" | "kernel";
          sealed: string[];
          health?: DeviceHealth;
        }>(req);
        if (!b.deviceId) throw new HttpError(400, "deviceId is required");
        await hub.store.reportDevice(
          who,
          {
            ...b,
            sealed: Array.isArray(b.sealed) ? b.sealed.slice(0, 5000) : [],
            health: cleanHealth(b.health),
          },
          Date.now()
        );
        return json({ ok: true });
      }

      case route === "/soul" && m === "GET":
        return json(await hub.store.getSoul(who.projectId));
      case route === "/soul" && m === "PUT": {
        const b = await body<{ context?: string; conventions?: string }>(req);
        await hub.store.setSoul(who.projectId, b);
        await hub.emit(
          who.projectId,
          "soul.updated",
          `${who.agent?.name ?? who.memberName} updated the project soul`,
          who.agent
        );
        return json({ ok: true });
      }

      case route === "/invite" && m === "GET":
        return json({ invite: await hub.store.getInvite(who.projectId) });
      case route === "/invite/rotate" && m === "POST":
        return json({ invite: await hub.store.rotateInvite(who.projectId) });
    }
    throw new HttpError(404, `No route ${m} ${route}`);
  }

  /** Serve one request whose path, relative to the hub's base, is `pathname`. Returns null for non-API paths. */
  return async function handle(req: Request, pathname: string): Promise<Response | null> {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    try {
      if (pathname === "/healthz") return json({ ok: true, version: 2 });
      if (!pathname.startsWith("/api/v1/")) return null;
      return await route(req, new URL(req.url), pathname.slice("/api/v1".length));
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      if (hub.isClosed) return json({ error: "The hub is shutting down." }, 503);
      console.error("[hub]", e);
      return json({ error: "Internal error. The hub log has details." }, 500);
    }
  };
}

/** Keep a device's self-report to the known fields and sane sizes before it is stored. */
function cleanHealth(h: DeviceHealth | undefined): DeviceHealth {
  if (!h || typeof h !== "object") return {};
  const strs = (v: unknown, n: number) =>
    Array.isArray(v)
      ? v
          .filter((x) => typeof x === "string")
          .slice(0, n)
          .map((x) => x.slice(0, 300))
      : undefined;
  const out: DeviceHealth = {};
  if (typeof h.version === "string") out.version = h.version.slice(0, 40);
  const orphaned = strs(h.orphaned, 500);
  if (orphaned) out.orphaned = orphaned;
  const hosts = strs(h.hosts, 20);
  if (hosts) out.hosts = hosts;
  if (Array.isArray(h.checks))
    out.checks = h.checks.slice(0, 20).map((c) => ({
      name: String(c?.name ?? "").slice(0, 60),
      ok: c?.ok === true,
      detail: String(c?.detail ?? "").slice(0, 300),
    }));
  if (typeof h.checkedAt === "number") out.checkedAt = h.checkedAt;
  return out;
}
