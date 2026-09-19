import type { Creds } from "./creds.ts";

export class ApiError extends Error {
  constructor(
    /** HTTP status, or 0 when the hub could not be reached at all. */
    readonly status: number,
    message: string
  ) {
    super(message);
  }
  get isAuth(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

/** The hosted hub routes faster when told its region. Only that exact URL gets the header. */
const HOSTED_HUB = "https://enqocfrutvwvvzcfymxs.supabase.co/functions/v1/axis";
const regionHeader = (hub: string): Record<string, string> => (hub === HOSTED_HUB ? { "x-region": "us-west-2" } : {});

export async function api<T>(creds: Creds, route: string, init: { method?: string; body?: unknown; timeoutMs?: number } = {}): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 15_000);
  let res: Response;
  try {
    res = await fetch(`${creds.hub}/api/v1${route}`, {
      method: init.method ?? "GET",
      headers: {
        authorization: `Bearer ${creds.token}`,
        ...regionHeader(creds.hub),
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: controller.signal,
      cache: "no-store",
    });
  } catch (e) {
    const why = (e as Error).name === "AbortError" ? "timed out" : "network error";
    throw new ApiError(0, `Cannot reach the hub at ${creds.hub} (${why}).`);
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let data: unknown = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new ApiError(res.status || 502, `The hub at ${creds.hub} did not answer with JSON (HTTP ${res.status}). Check the hub URL.`);
  }
  if (!res.ok) {
    const msg = (data as { error?: unknown }).error;
    throw new ApiError(res.status, typeof msg === "string" ? msg : `Hub error ${res.status}`);
  }
  return data as T;
}

export function streamUrl(creds: Creds): string {
  return `${creds.hub.replace(/^http/, "ws")}/api/v1/stream?token=${encodeURIComponent(creds.token)}`;
}

/** True when `origin` looks like an Axis hub, so the connect form can prefill it. */
export async function probeHub(origin: string): Promise<boolean> {
  try {
    const res = await fetch(`${origin}/healthz`, { cache: "no-store" });
    if (!res.ok) return false;
    const body = (await res.json()) as { ok?: unknown };
    return body.ok === true;
  } catch {
    return false;
  }
}
