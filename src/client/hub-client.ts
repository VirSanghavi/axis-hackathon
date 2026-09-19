import { hubRegion } from "./config.ts";
import type {
  AcquireResult,
  AgentRef,
  AxisEvent,
  ClaimResult,
  DeviceHealth,
  EnforcementTier,
  Job,
  Lock,
  Priority,
  ProjectSnapshot,
  ReleaseResult,
  WaitResult,
} from "../protocol/types.ts";

import type { Contention, DeferResult } from "../hub/hub.ts";
import type { Handoff } from "../hub/store.ts";

export type AuthConfig =
  | { required: false }
  | { required: true; kind: "supabase"; url: string; anonKey: string; provider: string };

export class HubError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

/**
 * Typed client for the hub API. Used by the MCP server, the daemon, the CLI and
 * the hooks, so there is exactly one place that knows the wire format.
 */
export class HubClient {
  private readonly region?: string;

  constructor(
    readonly baseUrl: string,
    private token: string,
    private opts: { timeoutMs?: number } = {},
    private userToken?: string
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.region = hubRegion(this.baseUrl);
  }

  withToken(token: string): HubClient {
    return new HubClient(this.baseUrl, token, this.opts);
  }

  async call<T>(method: string, route: string, body?: unknown, timeoutMs?: number): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs ?? this.opts.timeoutMs ?? 15_000);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/v1${route}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
          ...(this.region ? { "x-region": this.region } : {}),
          ...(this.userToken ? { "x-user-token": this.userToken } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (e) {
      const why = (e as Error).name === "AbortError" ? "timed out" : (e as Error).message;
      throw new HubError(0, `Cannot reach the Axis hub at ${this.baseUrl} (${why}).`);
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      throw new HubError(res.status, `Hub returned a non-JSON response (${res.status}).`);
    }
    if (!res.ok)
      throw new HubError(
        res.status,
        (data as { error?: string }).error ?? `Hub error ${res.status}`
      );
    return data as T;
  }

  // unauthenticated: on hubs that require sign-in, `userToken` says who you are
  static async createProject(
    baseUrl: string,
    input: { name: string; member: string },
    auth: { adminSecret?: string; userToken?: string } = {}
  ) {
    const c = new HubClient(baseUrl, auth.adminSecret ?? "", {}, auth.userToken);
    return c.call<{
      project: { id: string; name: string };
      memberToken: string;
      invite: string;
      member: string;
    }>("POST", "/projects", input);
  }
  static async join(baseUrl: string, invite: string, member: string, userToken?: string) {
    const c = new HubClient(baseUrl, "", {}, userToken);
    return c.call<{ projectId: string; projectName: string; memberToken: string; member: string }>(
      "POST",
      "/join",
      { invite, member }
    );
  }
  /** How to sign in to this hub; hubs that predate sign-in answer 404, which means none is needed. */
  static async authConfig(baseUrl: string): Promise<AuthConfig> {
    try {
      return await new HubClient(baseUrl, "").call<AuthConfig>("GET", "/auth");
    } catch (e) {
      if (e instanceof HubError && e.status === 404) return { required: false };
      throw e;
    }
  }

  me() {
    return this.call<{
      principal: {
        kind: string;
        projectId: string;
        projectName: string;
        memberName: string;
        agent?: AgentRef;
      };
      leaseMs: number;
    }>("GET", "/me");
  }
  startAgent(input: { name?: string; vendor?: string; device?: string; task?: string }) {
    return this.call<{ agent: AgentRef; token: string }>("POST", "/agents", input);
  }
  endAgent() {
    return this.call<{ released: number }>("DELETE", "/agents/me");
  }
  heartbeat(task?: string) {
    return this.call<{ ok: true }>("POST", "/heartbeat", { task });
  }
  snapshot(events = 200) {
    return this.call<ProjectSnapshot>("GET", `/snapshot?events=${events}`);
  }
  /** Long poll: returns as soon as the project's event sequence moves past `since`, or after `waitMs`. */
  watchLocks(since: number, waitMs: number) {
    return this.call<{ seq: number; locks: Lock[] }>(
      "GET",
      `/locks/watch?since=${since}&wait=${waitMs}`,
      undefined,
      waitMs + 15_000
    );
  }
  locks() {
    return this.call<{ locks: Lock[] }>("GET", "/locks").then((r) => r.locks);
  }
  myLocks() {
    return this.call<{ locks: Lock[] }>("GET", "/locks/mine").then((r) => r.locks);
  }
  acquire(targets: string[], intent: string, jobId?: string) {
    return this.call<AcquireResult>("POST", "/locks", { targets, intent, jobId });
  }
  release(targets: string[] | "all") {
    return this.call<ReleaseResult>(
      "POST",
      "/locks/release",
      targets === "all" ? { all: true } : { targets }
    );
  }
  wait(
    targets: string[],
    opts: { timeoutMs?: number; acquire?: boolean; intent?: string; jobId?: string }
  ) {
    return this.call<WaitResult>(
      "POST",
      "/locks/wait",
      { targets, ...opts },
      (opts.timeoutMs ?? 60_000) + 15_000
    );
  }
  force(targets: string[], reason: string) {
    return this.call<{ broken: Lock[] }>("POST", "/locks/force", { targets, reason });
  }
  jobs(all = false) {
    return this.call<{ jobs: Job[] }>("GET", `/jobs${all ? "?all=1" : ""}`).then((r) => r.jobs);
  }
  postJob(input: {
    title: string;
    description?: string;
    priority?: Priority;
    dependencies?: string[];
  }) {
    return this.call<Job>("POST", "/jobs", input);
  }
  claim(jobId?: string) {
    return this.call<ClaimResult>("POST", "/jobs/claim", { jobId });
  }
  complete(jobId: string, outcome: string) {
    return this.call<{ job: Job; released: string[] }>(
      "POST",
      `/jobs/${encodeURIComponent(jobId)}/complete`,
      { outcome }
    );
  }
  releaseJob(jobId: string) {
    return this.call<{ job: Job }>("POST", `/jobs/${encodeURIComponent(jobId)}/release`, {});
  }
  cancelJob(jobId: string, reason: string) {
    return this.call<{ job: Job }>("POST", `/jobs/${encodeURIComponent(jobId)}/cancel`, { reason });
  }
  note(text: string) {
    return this.call<{ event: AxisEvent }>("POST", "/notes", { text });
  }
  events(since: number, limit = 100) {
    return this.call<{ events: AxisEvent[] }>("GET", `/events?since=${since}&limit=${limit}`).then(
      (r) => r.events
    );
  }
  /** Queue for targets without blocking; the hand-off arrives through {@link feed}. */
  defer(targets: string[], intent: string, jobId?: string, holdMs?: number) {
    return this.call<AcquireResult | DeferResult>("POST", "/locks/wait", {
      targets,
      intent,
      jobId,
      holdMs,
      defer: true,
    });
  }
  feed(since: number, limit = 50) {
    return this.call<{ events: AxisEvent[]; handoffs: Handoff[] }>("POST", "/feed", {
      since,
      limit,
    });
  }
  analytics(hours = 24) {
    return this.call<Contention>("GET", `/analytics?hours=${hours}`);
  }
  renameLock(path: string, from: string, to: string) {
    return this.call<{ followed: boolean }>("POST", "/locks/rename", { path, from, to });
  }
  moveLocks(from: string, to: string) {
    return this.call<{ moved: Lock[] }>("POST", "/locks/move", { from, to });
  }
  reportOrphaned(path: string, detail: string) {
    return this.call<{ locks: Lock[] }>("POST", "/locks/orphaned", { path, detail });
  }
  reportWrite(status: "applied" | "blocked", path: string, detail?: string) {
    return this.call<{ ok: true }>("POST", "/writes", { status, path, detail });
  }
  reportDevice(input: {
    deviceId: string;
    hostname: string;
    platform: string;
    tier: EnforcementTier;
    sealed: string[];
    health?: DeviceHealth;
  }) {
    return this.call<{ ok: true }>("POST", "/devices/report", input);
  }
  soul() {
    return this.call<{ context: string; conventions: string }>("GET", "/soul");
  }
  setSoul(soul: { context?: string; conventions?: string }) {
    return this.call<{ ok: true }>("PUT", "/soul", soul);
  }
  invite() {
    return this.call<{ invite: string | null }>("GET", "/invite");
  }
}
