#!/usr/bin/env bun
/**
 * Seed a hub with a realistic, small team so the dashboard has something to
 * show: two members, five agent sessions on two machines, symbol and whole-file
 * locks with intents, a job board, one denial, a write stopped by a seal, two
 * devices at different enforcement tiers, and a note.
 *
 *   bun dashboard/scripts/seed.ts [hub-url] [--live] [--empty] [--name acme-web]
 *
 *   --live   keep going: re-report devices and heartbeat agents so they stay
 *            online, and replay a denial now and then so the feed moves.
 *   --empty  create the project and stop (for the empty-state screens).
 *
 * Prints the dashboard link (with the member token in the fragment) last.
 */
import { HubClient } from "../../src/client/hub-client.ts";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const base = (args.find((a) => /^https?:\/\//.test(a)) ?? process.env.AXIS_HUB ?? "http://127.0.0.1:4480").replace(/\/+$/, "");
const projectName = opt("name") ?? "acme-web";
const dashboard = (opt("dashboard") ?? base).replace(/\/+$/, "");

const say = (s: string) => console.error(`  ${s}`);

const owner = await HubClient.createProject(
  base,
  { name: projectName, member: "dana" },
  { adminSecret: process.env.AXIS_HUB_SECRET }
);
const dana = new HubClient(base, owner.memberToken);
const link = `${dashboard}/#hub=${encodeURIComponent(base)}&token=${encodeURIComponent(owner.memberToken)}`;
say(`project ${owner.project.name} (${owner.project.id}) on ${base}`);

if (flag("empty")) {
  console.log(link);
  process.exit(0);
}

const joined = await HubClient.join(base, owner.invite, "sam");
const sam = new HubClient(base, joined.memberToken);
say("sam joined with the invite");

async function agent(member: HubClient, name: string, vendor: string, device: string, task?: string) {
  const { token } = await member.startAgent({ name, vendor, device, task });
  return member.withToken(token);
}

const danaClaude = await agent(dana, "dana/claude-code", "claude-code", "dana-mbp");
const danaCodex = await agent(dana, "dana/codex", "codex", "dana-mbp", "Tidy checkout form validation");
const samCursor = await agent(sam, "sam/cursor", "cursor", "sam-thinkpad");
const samClaude = await agent(sam, "sam/claude-code", "claude-code", "sam-thinkpad");
const samCodex = await agent(sam, "sam/codex", "codex", "sam-thinkpad");
say("5 agent sessions started");

// ── jobs ──────────────────────────────────────────────────────────────────
const argon = await dana.postJob({ title: "Switch password hashing to argon2", priority: "high", description: "Keep bcrypt verify for existing hashes; rehash on next login." });
const rate = await dana.postJob({ title: "Rate limit POST /login per IP", priority: "critical" });
const refresh = await dana.postJob({ title: "Add a session refresh endpoint", priority: "medium", dependencies: [argon.id] });
const flaky = await sam.postJob({ title: "Fix rounding on discounted cart totals", priority: "high" });
const e2e = await sam.postJob({ title: "E2E test for guest checkout", priority: "medium" });
await sam.postJob({ title: "Remove the legacy cookie parser", priority: "low", dependencies: [argon.id, refresh.id] });
const copy = await dana.postJob({ title: "Update password reset email copy", priority: "low" });
say("7 jobs posted");

await danaClaude.claim(argon.id);
await samCursor.claim(rate.id);
await samClaude.claim(e2e.id);
await samClaude.complete(e2e.id, "Guest checkout covered end to end in tests/e2e/checkout.spec.ts");
await samClaude.claim(flaky.id);
await dana.cancelJob(copy.id, "Marketing owns this copy now");
say("jobs claimed, one done, one cancelled");

// ── locks ─────────────────────────────────────────────────────────────────
await danaClaude.acquire(["src/auth/service.ts#AuthService.login", "src/auth/service.ts#AuthService.hashPassword"], "Switch login to argon2 without logging anyone out", argon.id);
await danaClaude.acquire(["src/auth/service.ts#(top)"], "Import argon2 and drop the bcrypt default export", argon.id);
await samCursor.acquire(["src/api/middleware/rateLimit.ts"], "New token bucket limiter, whole file while it takes shape", rate.id);
await samCursor.acquire(["src/api/routes/auth.ts#loginRoute"], "Put the rate limiter in front of /login", rate.id);
await samClaude.acquire(["src/cart/totals.ts#computeTotals", "src/cart/totals.ts#applyDiscount"], "Round per line item before summing, not after", flaky.id);
await danaCodex.acquire(["src/components/CheckoutForm.tsx#CheckoutForm.handleSubmit"], "Block double submits while the payment request is in flight");
await samCodex.acquire(["src/lib/format.ts#formatCurrency"], "Check currency formatting for the rounding fix");
await samCodex.release(["src/lib/format.ts#formatCurrency"]);
await samCodex.endAgent();
say("locks taken, one released, one agent left");

// ── enforcement ───────────────────────────────────────────────────────────
const denied = await danaCodex.acquire(["src/auth/service.ts#AuthService.login"], "Add an audit log line on every login");
say(`denial: ${denied.status}`);
await danaCodex.reportWrite("blocked", "src/auth/service.ts", "sealed (kernel); AuthService.login is held by dana/claude-code");

const devices = [
  { client: dana, deviceId: "d_dana-mbp", hostname: "dana-mbp", platform: "darwin-arm64", tier: "kernel" as const },
  { client: sam, deviceId: "d_sam-thinkpad", hostname: "sam-thinkpad", platform: "linux-x64", tier: "guard" as const },
];
// Like the real daemon: every device seals every file that anyone holds a lock in.
const report = async () => {
  const sealed = [...new Set((await dana.locks()).map((l) => l.path))];
  await Promise.all(devices.map((d) => d.client.reportDevice({ deviceId: d.deviceId, hostname: d.hostname, platform: d.platform, tier: d.tier, sealed })));
  return sealed.length;
};
say(`2 devices reporting, ${await report()} files sealed on each`);

await danaClaude.note("Heads up: session tokens change format once the argon2 job lands. Keep the old cookie parser until then.");

console.error("");
console.log(link);

if (flag("live")) {
  say("live mode: reporting devices every 10s, heartbeats every 30s, a repeat denial every 3m. Ctrl-C to stop.");
  // dana/codex never heartbeats, so its lease visibly drains and it drifts to idle.
  const agents = [danaClaude, samCursor, samClaude];
  let tick = 0;
  setInterval(async () => {
    tick++;
    try {
      await report();
      if (tick % 3 === 0) await Promise.all(agents.map((a) => a.heartbeat()));
      if (tick % 18 === 0) await samCursor.acquire(["src/cart/totals.ts#computeTotals"], "Reuse the totals helper in the limiter response");
    } catch (e) {
      say(`live tick failed: ${(e as Error).message}`);
    }
  }, 10_000);
}
