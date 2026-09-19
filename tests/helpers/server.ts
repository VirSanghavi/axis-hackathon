import { HubClient } from "../../src/client/hub-client.ts";
import { Hub } from "../../src/hub/hub.ts";
import { serveHub } from "../../src/hub/server.ts";
import { testStore } from "./store.ts";

/**
 * A real hub with a fresh project, and a way to start agents as different people
 * on different devices. Local by default; AXIS_TEST_HUB points every integration
 * suite at a deployed hub instead (the hosted Supabase edge function in CI).
 */
export const REMOTE_HUB = process.env.AXIS_TEST_HUB;

export async function liveHub(opts: { leaseMs?: number } = {}) {
  const hub = REMOTE_HUB
    ? null
    : new Hub(await testStore(), { leaseMs: opts.leaseMs, sweepMs: 100 });
  const server = hub ? serveHub({ hub, port: 0 }) : null;
  const url = REMOTE_HUB ?? `http://127.0.0.1:${server!.port}`;
  // The hosted hub requires sign-in: AXIS_TEST_USER_TOKEN is a signed-in user's access token.
  const userToken = REMOTE_HUB ? process.env.AXIS_TEST_USER_TOKEN : undefined;
  const created = await HubClient.createProject(
    url,
    { name: "acme", member: "dana" },
    { userToken }
  );
  const joined = await HubClient.join(url, created.invite, "ben", userToken);
  const dana = new HubClient(url, created.memberToken);
  const ben = new HubClient(url, joined.memberToken);

  async function agent(member: HubClient, name: string, device: string) {
    const { token, agent } = await member.startAgent({ name, vendor: "test", device });
    return Object.assign(member.withToken(token), { sessionToken: token, ref: agent });
  }

  return {
    hub,
    url,
    project: created.project.id,
    invite: created.invite,
    dana,
    ben,
    danaToken: created.memberToken,
    benToken: joined.memberToken,
    agent,
    stopServer: () => server?.stop(true),
    close: () => {
      server?.stop(true);
      hub?.close();
    },
  };
}
