import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { axisHome } from "../client/config.ts";
import type { WorkspaceReg } from "../daemon/daemon.ts";
import { DaemonClient } from "../daemon/client.ts";
import { SYSTEM_SOCKET, userSocket } from "../client/config.ts";

/**
 * The kernel tier: a root daemon that seals with flags only root can clear
 * (macOS `schg`, Linux `chattr +i`). Installing it is the one step that needs
 * your password, once.
 *
 * Security: the root daemon runs a root-owned copy of the binary in a
 * root-owned directory. Pointing a root service at a user-writable binary would
 * hand root to anything that can overwrite it.
 */

const LIBEXEC = "/usr/local/libexec/axis";
const BIN = `${LIBEXEC}/axis`;
const PLIST = "/Library/LaunchDaemons/dev.axis.enforcer.plist";
const UNIT = "/etc/systemd/system/axis-enforcer.service";
const LABEL = "dev.axis.enforcer";

function sudo(args: string[]): void {
  const p = Bun.spawnSync(["sudo", ...args], { stdio: ["inherit", "inherit", "inherit"] });
  if (p.exitCode !== 0) throw new Error(`sudo ${args.join(" ")} failed`);
}

function compiledBinary(): string {
  const entry = process.argv[1] ?? "";
  if (/\.(ts|js)$/.test(entry)) {
    throw new Error(
      "The kernel enforcer installs the compiled binary. Install Axis with the one-line installer (or `bun run build`) and run `axis enforcer install` from it."
    );
  }
  return process.execPath;
}

export async function installEnforcer(): Promise<void> {
  const binary = compiledBinary();
  const tmp = mkdtempSync(path.join(os.tmpdir(), "axis-enforcer-"));
  try {
    console.log("Installing the Axis kernel enforcer (needs your password once)...");
    sudo(["mkdir", "-p", LIBEXEC, "/var/lib/axis", "/var/run/axis"]);
    sudo(["cp", binary, BIN]);
    sudo(["chown", "-R", "root:" + (process.platform === "darwin" ? "wheel" : "root"), LIBEXEC]);
    sudo(["chmod", "755", LIBEXEC, BIN]);

    if (process.platform === "darwin") {
      const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${BIN}</string><string>daemon</string><string>--system</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>/var/log/axisd.log</string>
  <key>StandardOutPath</key><string>/var/log/axisd.log</string>
</dict></plist>
`;
      const f = path.join(tmp, "enforcer.plist");
      writeFileSync(f, plist);
      sudo(["cp", f, PLIST]);
      sudo(["chown", "root:wheel", PLIST]);
      sudo(["chmod", "644", PLIST]);
      Bun.spawnSync(["sudo", "launchctl", "bootout", `system/${LABEL}`], {
        stdio: ["inherit", "ignore", "ignore"],
      });
      sudo(["launchctl", "bootstrap", "system", PLIST]);
    } else if (process.platform === "linux") {
      const unit = `[Unit]
Description=Axis kernel lock enforcer
After=network-online.target

[Service]
ExecStart=${BIN} daemon --system
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
`;
      const f = path.join(tmp, "axis-enforcer.service");
      writeFileSync(f, unit);
      sudo(["cp", f, UNIT]);
      sudo(["systemctl", "daemon-reload"]);
      sudo(["systemctl", "enable", "--now", "axis-enforcer"]);
    } else {
      throw new Error(`The kernel enforcer supports macOS and Linux, not ${process.platform}.`);
    }

    const sys = await waitFor(SYSTEM_SOCKET);
    await migrateWorkspaces(sys);
    const st = await sys.status();
    console.log(
      `Kernel enforcer running: ${st.tier} (${st.mechanism}). ${st.workspaces.length} workspace(s) protected.`
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export async function uninstallEnforcer(): Promise<void> {
  if (process.platform === "darwin") {
    Bun.spawnSync(["sudo", "launchctl", "bootout", `system/${LABEL}`], {
      stdio: ["inherit", "inherit", "inherit"],
    });
    sudo(["rm", "-f", PLIST]);
  } else if (process.platform === "linux") {
    Bun.spawnSync(["sudo", "systemctl", "disable", "--now", "axis-enforcer"], {
      stdio: ["inherit", "inherit", "inherit"],
    });
    sudo(["rm", "-f", UNIT]);
  }
  sudo(["rm", "-rf", LIBEXEC, SYSTEM_SOCKET]);
  console.log("Kernel enforcer removed. The user-level daemon takes over on the next Axis call.");
}

async function waitFor(socket: string): Promise<DaemonClient> {
  const c = new DaemonClient(socket);
  for (let i = 0; i < 100; i++) {
    if (
      await c.status().then(
        () => true,
        () => false
      )
    )
      return c;
    await Bun.sleep(100);
  }
  throw new Error("The kernel enforcer did not come up. Check /var/log/axisd.log.");
}

/** Hand every workspace the user daemon was protecting to the root daemon, then stop the user daemon. */
async function migrateWorkspaces(sys: DaemonClient): Promise<void> {
  const stateFile = path.join(axisHome(), "daemon.json");
  const regs: WorkspaceReg[] = existsSync(stateFile)
    ? (JSON.parse(readFileSync(stateFile, "utf8")).workspaces ?? [])
    : [];
  if (existsSync(userSocket())) {
    await fetch("http://axisd/shutdown", {
      method: "POST",
      unix: userSocket(),
    } as RequestInit).catch(() => {});
  }
  for (const r of regs) {
    try {
      await sys.register({
        root: r.root,
        hub: r.hub,
        project: r.project,
        memberToken: r.memberToken,
      });
      console.log(`  protecting ${r.root}`);
    } catch (e) {
      console.log(`  could not move ${r.root}: ${(e as Error).message}`);
    }
  }
}
