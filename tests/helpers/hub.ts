import { Hub } from "../../src/hub/hub.ts";
import type { Principal } from "../../src/hub/store.ts";
import { testStore } from "./store.ts";

/** An in-memory hub with one project and helpers to mint agents on it. */
export async function testHub(
  opts: { leaseMs?: number; sweepMs?: number; pollMs?: number; contendedIdleMs?: number } = {}
) {
  const hub = new Hub(await testStore(), {
    leaseMs: opts.leaseMs,
    sweepMs: opts.sweepMs ?? 60_000,
    pollMs: opts.pollMs,
    contendedIdleMs: opts.contendedIdleMs,
  });
  const created = await hub.store.createProject("acme", "dana");
  const member = (await hub.store.authenticate(created.memberToken))!;

  async function agent(name: string, device = "laptop"): Promise<Principal> {
    const { token } = await hub.startAgent(member, { name, vendor: "test", device });
    return (await hub.store.authenticate(token))!;
  }

  return {
    hub,
    member,
    projectId: created.project.id,
    invite: created.invite,
    memberToken: created.memberToken,
    agent,
    close: () => hub.close(),
  };
}
