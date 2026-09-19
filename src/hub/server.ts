import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { Server, ServerWebSocket } from "bun";
import type { AxisEvent } from "../protocol/types.ts";
import { authenticate, createApi, json, type ApiOptions } from "./api.ts";
import { type Hub, HttpError } from "./hub.ts";
import type { Principal } from "./store.ts";

export interface ServeOptions {
  hub: Hub;
  port?: number;
  hostname?: string;
  /** If set, creating a project requires `Authorization: Bearer <secret>`. */
  adminSecret?: string;
  auth?: ApiOptions["auth"];
  /** The built dashboard: a directory in development, files embedded in the compiled binary. */
  dashboard?: DashboardFiles;
}

interface WsData {
  principal: Principal;
  unsubscribe?: () => void;
}

export function serveHub(opts: ServeOptions): Server<WsData> {
  const { hub } = opts;
  const api = createApi(hub, { adminSecret: opts.adminSecret, auth: opts.auth });

  return Bun.serve<WsData>({
    port: opts.port ?? 4455,
    hostname: opts.hostname ?? "127.0.0.1",
    idleTimeout: 255, // long polls (`wait`, lock watches) park for up to two minutes
    async fetch(req, server) {
      const url = new URL(req.url);
      const p = url.pathname;
      try {
        // Live event stream for the dashboard. (Daemons use the /locks/watch long poll, which works everywhere.)
        if (p === "/api/v1/stream") {
          const principal = await authenticate(hub, req, url);
          if (server.upgrade(req, { data: { principal } })) return undefined as unknown as Response;
          throw new HttpError(400, "Expected a WebSocket upgrade.");
        }
      } catch (e) {
        if (e instanceof HttpError) return json({ error: e.message }, e.status);
        throw e;
      }
      const res = await api(req, p);
      if (res) return res;
      if (opts.dashboard) return serveDashboard(opts.dashboard, p);
      return new Response(
        "Axis hub is running. Build the dashboard with `bun run build:dashboard` to see it here.\n",
        { headers: { "content-type": "text/plain" } }
      );
    },
    websocket: {
      open(ws: ServerWebSocket<WsData>) {
        const { principal } = ws.data;
        ws.send(JSON.stringify({ type: "hello", project: principal.projectId }));
        ws.data.unsubscribe = hub.subscribe(principal.projectId, (e: AxisEvent) =>
          ws.send(JSON.stringify({ type: "event", event: e }))
        );
      },
      message() {
        /* clients only listen */
      },
      close(ws: ServerWebSocket<WsData>) {
        ws.data.unsubscribe?.();
      },
    },
  });
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
};

/** Relative path (e.g. "assets/app.js") -> readable file path. */
export type DashboardFiles = Map<string, string>;

/** Every file under a built dashboard directory, or undefined when it has not been built. */
export function dashboardFromDir(dir: string): DashboardFiles | undefined {
  if (!existsSync(path.join(dir, "index.html"))) return undefined;
  const files: DashboardFiles = new Map();
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const abs = path.join(d, name);
      if (statSync(abs).isDirectory()) walk(abs);
      else files.set(path.relative(dir, abs).split(path.sep).join("/"), abs);
    }
  };
  walk(dir);
  return files;
}

/** Known files by exact path; anything else is the SPA's index.html (client-side routes). */
function serveDashboard(files: DashboardFiles, pathname: string): Response {
  const rel = decodeURIComponent(pathname).replace(/^\/+/, "");
  const hit = files.get(rel);
  const file = hit ?? files.get("index.html")!;
  const name = hit ? rel : "index.html";
  const immutable = name.startsWith("assets/");
  return new Response(Bun.file(file), {
    headers: {
      "content-type": MIME[path.extname(name)] ?? "application/octet-stream",
      "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    },
  });
}
