import { useState } from "react";
import type { Agent, Device, EnforcementTier } from "../../../src/protocol/types.ts";
import { ago, fullTime, useNow } from "../lib/time.ts";
import { Laptop, Shield, ShieldOff } from "./icons.tsx";
import { Dot, Empty, Panel, PathText, Skeleton, Tip, plural } from "./ui.tsx";

export const TIERS: Record<EnforcementTier, { label: string; short: string; tip: string }> = {
  kernel: {
    label: "Kernel",
    short: "Kernel seal",
    tip: "Root-owned immutable flag (chflags schg on macOS, chattr +i on Linux). No process without root can write, rename, delete or unseal a locked file, including editors and shells outside Axis.",
  },
  guard: {
    label: "Guard",
    short: "User seal",
    tip: "User-level seal (chflags uchg on macOS, read-only mode on Linux). Blocks writes, renames and deletes from every tool that does not deliberately strip the flag. Run axis enforcer install for the kernel tier.",
  },
  off: {
    label: "Off",
    short: "Advisory",
    tip: "This machine cannot seal files, so nothing stops a raw write. Locks still coordinate every agent that goes through Axis.",
  },
};

export function TierBadge({ tier }: { tier: EnforcementTier }) {
  const t = TIERS[tier] ?? TIERS.off;
  const Icon = tier === "off" ? ShieldOff : Shield;
  return (
    <Tip
      className={`badge badge-btn tier tier-${tier}`}
      tip={
        <>
          <strong>{t.short}.</strong> {t.tip}
        </>
      }
    >
      <Icon size={12} />
      {t.label}
      <span className="sr-only"> enforcement tier, details</span>
    </Tip>
  );
}

const SEALED_PREVIEW = 4;

function DeviceRow({ device, agents }: { device: Device; agents: Agent[] }) {
  const now = useNow();
  const [all, setAll] = useState(false);
  const sealed = [...device.sealed].sort();
  const shown = all ? sealed : sealed.slice(0, SEALED_PREVIEW);
  const here = agents.filter((a) => a.device === device.hostname && a.status !== "offline").length;
  return (
    <li className="device">
      <div className="device-head">
        <Laptop className="device-icon" />
        <div className="device-id">
          <p className="device-name mono">{device.hostname}</p>
          <p className="device-sub">
            <span>{device.member}</span>
            <span className="sep" aria-hidden="true" />
            <span className="mono">{device.platform}</span>
            {here > 0 && (
              <>
                <span className="sep" aria-hidden="true" />
                <span>{plural(here, "agent")}</span>
              </>
            )}
          </p>
        </div>
        <div className="device-state">
          <TierBadge tier={device.tier} />
          <span className="presence" title={`Last report ${fullTime(device.lastSeenAt)}`}>
            <Dot tone={device.online ? "ok" : "muted"} />
            {device.online ? "Online" : <span className="num">Seen {ago(now - device.lastSeenAt)}</span>}
          </span>
        </div>
      </div>
      <div className="sealed">
        <p className="sealed-title">
          {sealed.length ? (
            <>
              <Shield size={13} />
              <span className="num">{plural(sealed.length, "file")}</span> sealed on this machine
            </>
          ) : (
            <span className="muted">Nothing sealed right now</span>
          )}
        </p>
        {sealed.length > 0 && (
          <ul className="sealed-list" role="list">
            {shown.map((p) => (
              <li key={p}>
                <PathText path={p} />
              </li>
            ))}
          </ul>
        )}
        {sealed.length > SEALED_PREVIEW && (
          <button type="button" className="btn btn-quiet btn-sm sealed-more" onClick={() => setAll((v) => !v)} aria-expanded={all}>
            {all ? "Show fewer" : `Show all ${sealed.length}`}
          </button>
        )}
      </div>
    </li>
  );
}

export function DevicesPanel({ devices, agents, loading }: { devices: Device[]; agents: Agent[]; loading: boolean }) {
  const sorted = [...devices].sort((a, b) => Number(b.online) - Number(a.online) || a.hostname.localeCompare(b.hostname));
  const online = devices.filter((d) => d.online).length;
  return (
    <Panel id="devices" title="Devices" count={loading ? undefined : `${online}/${devices.length} online`}>
      {loading ? (
        <Skeleton rows={2} lines={3} />
      ) : sorted.length === 0 ? (
        <Empty icon={<Laptop size={18} />} title="No devices reporting" cmd="axis init">
          Each machine's daemon reports its enforcement tier and the files it has sealed. Run this in the repo to start one:
        </Empty>
      ) : (
        <ul className="devices" role="list">
          {sorted.map((d) => (
            <DeviceRow key={d.id} device={d} agents={agents} />
          ))}
        </ul>
      )}
    </Panel>
  );
}
