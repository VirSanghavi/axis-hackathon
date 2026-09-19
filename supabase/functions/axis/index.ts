/**
 * The hosted Axis hub: a Supabase Edge Function over the project's Postgres.
 * Same hub, same API as `axis hub`; only the store and the runtime differ.
 * Built into a single file by `bun scripts/build-edge.ts` (Deno resolves
 * `postgres` through the function's import map).
 */
import postgres from "postgres";
import { createApi } from "../../../src/hub/api.ts";
import { Hub } from "../../../src/hub/hub.ts";
import { supabaseAuth } from "../../../src/hub/identity.ts";
import { PostgresStore } from "../../../src/hub/postgres-store.ts";

declare const Deno: {
  env: { get(name: string): string | undefined };
  serve(handler: (req: Request) => Response | Promise<Response>): unknown;
};

const direct = Deno.env.get("SUPABASE_DB_URL");
if (!direct) throw new Error("SUPABASE_DB_URL is not set");

/**
 * Every concurrent request can land in its own isolate, and long polls keep them
 * alive, so direct connections run out fast (the database allows ~60). Supavisor's
 * transaction pooler multiplexes them. Transaction mode is safe for Axis: every
 * lock is transaction-scoped and statements are never prepared. The pooler's
 * host depends on the project's region, so find it once per isolate by asking
 * each candidate in parallel with the function's own credentials.
 */
const REGIONS = [
  "us-west-1",
  "us-west-2",
  "us-east-1",
  "us-east-2",
  "ca-central-1",
  "eu-west-1",
  "eu-west-2",
  "eu-central-1",
  "ap-south-1",
  "ap-southeast-1",
  "ap-northeast-1",
  "ap-southeast-2",
  "sa-east-1",
];

async function pooledUrl(url: string): Promise<{ url: string; mode: string }> {
  const u = new URL(url);
  const ref = u.hostname.match(/^db\.([a-z0-9]+)\.supabase\.co$/)?.[1];
  if (!ref) return { url, mode: "direct" };
  const candidates = REGIONS.flatMap((region) =>
    ["aws-0", "aws-1"].map((prefix) => {
      const p = new URL(url);
      p.hostname = `${prefix}-${region}.pooler.supabase.com`;
      p.port = "6543";
      p.username = `postgres.${ref}`;
      return p.toString();
    })
  );
  try {
    const winner = await Promise.any(
      candidates.map(async (c) => {
        const sql = postgres(c, { prepare: false, max: 1, connect_timeout: 5, onnotice: () => {} });
        try {
          await sql`select 1`;
          return c;
        } finally {
          void sql.end({ timeout: 1 });
        }
      })
    );
    return { url: winner, mode: `pooler ${new URL(winner).hostname}` };
  } catch {
    return { url, mode: "direct" };
  }
}

/**
 * Sign-in is required once the provider is switched on in this project's Auth
 * settings; until then the hub keeps the invite-only flow, so turning Google on
 * in the dashboard is the whole rollout. If the settings cannot be read, require it.
 */
async function authProviderOn(url: string, key: string, provider: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/auth/v1/settings`, {
      headers: { apikey: key },
      signal: AbortSignal.timeout(5000),
    });
    const s = (await res.json()) as { external?: Record<string, boolean> };
    return s.external?.[provider] === true;
  } catch {
    return true;
  }
}

const authUrl = Deno.env.get("SUPABASE_URL");
const authKey = Deno.env.get("SUPABASE_ANON_KEY");
const provider = Deno.env.get("AXIS_AUTH_PROVIDER") || "google";

const ready = Promise.all([
  pooledUrl(direct),
  authUrl && authKey ? authProviderOn(authUrl, authKey, provider) : false,
]).then(([{ url, mode }, signIn]) => {
  // No background timers on serverless; requests sweep lapsed leases.
  // Long polls stay well inside the edge wall-clock limit.
  const hub = new Hub(new PostgresStore(url, { max: 3, idleTimeoutSec: 20 }), {
    maxWaitMs: 100_000,
    sweepMs: 0,
  });
  return {
    hub,
    mode,
    signIn,
    api: createApi(hub, {
      adminSecret: Deno.env.get("AXIS_HUB_SECRET") || undefined,
      auth: signIn
        ? supabaseAuth(authUrl, authKey, provider, Deno.env.get("AXIS_ALLOWED_EMAILS"))
        : undefined,
    }),
  };
});

Deno.serve(async (req) => {
  const { hub, mode, signIn, api } = await ready;
  // Requests arrive as /axis/<route>; the hub's routes are relative to its base.
  const pathname = new URL(req.url).pathname.replace(/^\/axis(?=\/|$)/, "") || "/";
  if (pathname === "/healthz")
    return Response.json(
      { ok: true, version: 2, db: mode, signIn: signIn ? provider : "off" },
      { headers: { "access-control-allow-origin": "*" } }
    );
  void hub.sweepIfDue();
  return (
    (await api(req, pathname)) ??
    new Response("Axis hub. See https://github.com/VirSanghavi/axis-hackathon\n", {
      headers: { "content-type": "text/plain" },
    })
  );
});
