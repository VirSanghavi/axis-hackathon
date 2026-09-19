/**
 * Multi-device, multi-employee end-to-end test.
 *
 *   bun tests/devices/run.ts
 *
 * One hub container and three "laptops" (Linux containers), each with:
 *   - its own clone of the repo, owned by a non-root developer account
 *   - the root Axis daemon at the kernel tier (chattr +i, needs CAP_LINUX_IMMUTABLE)
 *   - an agent speaking MCP to `axis mcp` inside the container (driven from here)
 * Plus a rogue: the same developer account writing with plain shell tools, the way
 * an agent that has never heard of Axis would.
 *
 * Every check prints a line; the process exits non-zero if any fails.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = path.resolve(import.meta.dir, "../..");
const ARCH = process.env.AXIS_DEVICE_ARCH ?? (os.arch() === "arm64" ? "arm64" : "x64");
const BIN = path.join(ROOT, `dist/bin/axis-linux-${ARCH}`);
const RUN = `axis-e2e-${Date.now().toString(36)}`;
const NET = `${RUN}-net`;
const IMAGE = `${RUN}-image`;
const DEVICES = ["laptop-ana", "laptop-ben", "desktop-cy"] as const;
type Device = (typeof DEVICES)[number];

let failures = 0;
const results: string[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  const line = `${ok ? "✓" : "✗"} ${name}${detail ? `  (${detail})` : ""}`;
  results.push(line);
  console.log(line);
  if (!ok) failures++;
}

function sh(
  cmd: string[],
  opts: { input?: string; allowFail?: boolean } = {}
): { code: number; out: string } {
  const p = Bun.spawnSync(cmd, {
    stdin: opts.input ? new Blob([opts.input]) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = (p.stdout.toString() + p.stderr.toString()).trim();
  if (p.exitCode !== 0 && !opts.allowFail)
    throw new Error(`${cmd.join(" ")} failed (${p.exitCode}): ${out}`);
  return { code: p.exitCode ?? 1, out };
}
const docker = (...args: string[]) => sh(["docker", ...args]);
/** Run a shell command inside a device as the developer (never root). */
const asDev = (d: Device, script: string, allowFail = false) =>
  sh(
    ["docker", "exec", "-u", "dev", "-w", "/home/dev/repo", `${RUN}-${d}`, "bash", "-lc", script],
    { allowFail }
  );

const SEED: Record<string, string> = {
  "src/auth.ts": `export class Auth {
  login(user: string) {
    return user;
  }

  logout() {
    return true;
  }
}
`,
  "src/billing.py": `def charge(amount):
    return amount


def refund(amount):
    return -amount
`,
  "README.md": "# acme\n",
};

async function main() {
  if (!existsSync(BIN)) {
    console.log(`building ${path.basename(BIN)}...`);
    sh([
      "bun",
      "build",
      path.join(ROOT, "dist/build/entry.ts"),
      "--compile",
      "--minify",
      `--target=bun-linux-${ARCH}`,
      "--outfile",
      BIN,
    ]);
  }
  const ctx = mkdtempSync(path.join(os.tmpdir(), "axis-devices-"));
  cpSync(path.join(import.meta.dir, "Dockerfile"), path.join(ctx, "Dockerfile"));
  cpSync(BIN, path.join(ctx, path.basename(BIN)));
  for (const [f, text] of Object.entries(SEED)) {
    mkdirSync(path.dirname(path.join(ctx, "seed", f)), { recursive: true });
    writeFileSync(path.join(ctx, "seed", f), text);
  }
  console.log("building device image...");
  docker("build", "-q", "--build-arg", `AXIS_BIN=${path.basename(BIN)}`, "-t", IMAGE, ctx);
  rmSync(ctx, { recursive: true, force: true });

  const clients: Client[] = [];
  try {
    docker("network", "create", NET);
    docker(
      "run",
      "-d",
      "--name",
      `${RUN}-hub`,
      "--network",
      NET,
      "--network-alias",
      "hub",
      IMAGE,
      "axis",
      "hub",
      "--host",
      "0.0.0.0",
      "--port",
      "4455",
      "--db",
      "/tmp/hub.db"
    );
    for (const d of DEVICES) {
      docker(
        "run",
        "-d",
        "--name",
        `${RUN}-${d}`,
        "--hostname",
        d,
        "--network",
        NET,
        "--cap-add",
        "LINUX_IMMUTABLE",
        IMAGE,
        "bash",
        "-c",
        // Each laptop: its own clone, and the root daemon at the kernel tier.
        "cp -r /seed /home/dev/repo && chown -R dev:dev /home/dev/repo && su dev -c 'cd ~/repo && git init -q' && exec axis daemon --system"
      );
    }
    await waitFor(
      () =>
        sh(["docker", "exec", `${RUN}-hub`, "bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/4455"], {
          allowFail: true,
        }).code === 0,
      "hub"
    );
    for (const d of DEVICES)
      await waitFor(
        () =>
          sh(["docker", "exec", `${RUN}-${d}`, "test", "-S", "/var/run/axis/axisd.sock"], {
            allowFail: true,
          }).code === 0,
        `${d} daemon`
      );

    // ── onboarding: one init, two joins, exactly as a team would ──────────────
    const init = asDev(
      "laptop-ana",
      "AXIS_MEMBER=ana axis init --hub http://hub:4455 --no-open"
    ).out;
    const invite = init.match(/axis join ([a-z0-9-]+)/)?.[1];
    check("ana: axis init creates the project and prints an invite", !!invite, invite);
    check(
      "ana: enforcement is the kernel tier",
      /kernel \(chattr \+i\)/.test(init),
      init.match(/enforcement\s+(.*)/)?.[1]
    );
    const cfg = asDev("laptop-ana", "cat .axis/axis.json").out;
    for (const d of ["laptop-ben", "desktop-cy"] as const) {
      // A teammate's clone already has the committed .axis/axis.json.
      asDev(d, `mkdir -p .axis && cat > .axis/axis.json <<'EOF'\n${cfg}\nEOF`);
      const who = d === "laptop-ben" ? "ben" : "cy";
      const out = asDev(d, `AXIS_MEMBER=${who} axis join ${invite}`).out;
      check(
        `${who}: axis join on ${d}`,
        /kernel/.test(out),
        out.split("\n").find((l) => l.includes("enforcement"))
      );
    }

    // ── agents ───────────────────────────────────────────────────────────────
    const agent = async (d: Device, member: string) => {
      const c = new Client({ name: member, version: "1" });
      await c.connect(
        new StdioClientTransport({
          command: "docker",
          args: [
            "exec",
            "-i",
            "-u",
            "dev",
            "-w",
            "/home/dev/repo",
            "-e",
            `AXIS_MEMBER=${member}`,
            "-e",
            "AXIS_AGENT_VENDOR=claude-code",
            `${RUN}-${d}`,
            "axis",
            "mcp",
          ],
        })
      );
      clients.push(c);
      return async (name: string, args: Record<string, unknown> = {}) =>
        ((await c.callTool({ name, arguments: args })) as { content: { text: string }[] }).content
          .map((x) => x.text)
          .join("\n");
    };
    const ana = await agent("laptop-ana", "ana");
    const ben = await agent("laptop-ben", "ben");
    const cy = await agent("desktop-cy", "cy");

    const status = await ana("axis_status");
    check(
      "ana's agent sees the team and the kernel tier",
      /enforcement here: kernel/.test(status),
      status.split("\n")[0]
    );

    // 1. Ana edits login on her laptop.
    let r = await ana("axis_edit", {
      path: "src/auth.ts",
      old: "return user;",
      new: "return user.trim();",
      why: "trim usernames before lookup",
    });
    check(
      "ana edits Auth.login (auto-locks just that function)",
      /^OK wrote src\/auth.ts \[Auth.login\] · auto-locked Auth.login/.test(r),
      r.split("\n")[0]
    );

    // 2. Every laptop seals auth.ts in the kernel, including ones where nobody on it holds a lock.
    for (const d of DEVICES) {
      await waitFor(
        () => /-i-/.test(asDev(d, "lsattr src/auth.ts", true).out.split(" ")[0] ?? ""),
        `${d} seal`,
        15_000
      ).catch(() => {});
      const attrs = asDev(d, "lsattr src/auth.ts", true).out.split(" ")[0];
      check(`${d}: src/auth.ts carries the immutable flag`, /i/.test(attrs ?? ""), attrs);
    }

    // 3. The rogue: same developer account, plain tools, no Axis. Everything fails.
    for (const [what, cmd] of [
      ["overwrite", "echo hacked > src/auth.ts"],
      ["append", "echo hacked >> src/auth.ts"],
      ["delete", "rm -f src/auth.ts"],
      ["rename over", "echo x > /tmp/x && mv -f /tmp/x src/auth.ts"],
      ["clear the flag", "chattr -i src/auth.ts"],
      ["chmod", "chmod 777 src/auth.ts"],
    ] as const) {
      const out = asDev("laptop-ben", cmd, true);
      check(
        `rogue on laptop-ben cannot ${what}`,
        out.code !== 0 && /not permitted|Permission denied/i.test(out.out),
        out.out.split("\n")[0]
      );
    }
    check(
      "laptop-ben's auth.ts is untouched",
      asDev("laptop-ben", "cat src/auth.ts").out === SEED["src/auth.ts"]!.trim()
    );
    check(
      "unlocked files stay writable for the rogue",
      asDev("laptop-ben", "echo notes >> README.md && echo ok", true).out.endsWith("ok")
    );

    // 4. Ben edits a different function of the same file, on his own laptop, at the same time.
    r = await ben("axis_edit", {
      path: "src/auth.ts",
      old: "return true;",
      new: "return false;",
      why: "logout must report failure",
    });
    check(
      "ben edits Auth.logout in the same file concurrently",
      /^OK wrote src\/auth.ts \[Auth.logout\]/.test(r),
      r.split("\n")[0]
    );
    check(
      "ben's write landed on his laptop",
      asDev("laptop-ben", "grep -c 'return false;' src/auth.ts", true).out === "1"
    );

    // 5. Cy wants Ana's function: denied with her reason, the free functions, and advice.
    r = await cy("axis_edit", {
      path: "src/auth.ts",
      old: "return user;",
      new: "return user.toLowerCase();",
    });
    check(
      "cy is denied Auth.login",
      r.startsWith("DENIED src/auth.ts#Auth.login"),
      r.split("\n")[0]
    );
    check(
      "the denial carries ana's reason and device",
      /ana\/claude-code@laptop-ana: "trim usernames before lookup"/.test(r),
      r.split("\n")[1]?.trim()
    );
    check(
      "the denial carries advice",
      /→ (wait|work_elsewhere|take_over): /.test(r),
      r.split("\n").find((l) => l.startsWith("→"))
    );

    // 6. Python, function level, on the third machine.
    r = await cy("axis_edit", {
      path: "src/billing.py",
      old: "    return amount\n",
      new: "    return round(amount, 2)\n",
      why: "round charges",
    });
    check(
      "cy edits billing.py#charge (Python, function level)",
      /^OK wrote src\/billing.py \[charge\]/.test(r),
      r.split("\n")[0]
    );

    // 7. Cy waits for login; Ana finishes; Cy is handed the lock across machines.
    const waiting = cy("axis_wait", {
      targets: ["src/auth.ts#Auth.login"],
      why: "lowercase usernames",
      seconds: 60,
    });
    await Bun.sleep(1500);
    await ana("axis_unlock");
    r = await waiting;
    check(
      "cy's wait is handed Auth.login when ana releases it",
      /^OK locked src\/auth.ts#Auth.login/.test(r),
      r.split("\n")[0]
    );

    // 8. Jobs across the team.
    await ana("axis_job", { do: "post", title: "add rate limiting", priority: "high" });
    r = await ben("axis_job", { do: "claim" });
    check(
      "ben claims the job ana posted",
      /^CLAIMED J1: add rate limiting/.test(r),
      r.split("\n")[0]
    );

    // 9. The hub knows every device and its tier.
    r = await ana("axis_status");
    const devicesLine = r.split("\n").find((l) => l.startsWith("devices:")) ?? "";
    check(
      "status lists three kernel-tier devices",
      DEVICES.every((d) => devicesLine.includes(`${d} kernel (`)),
      devicesLine
    );

    // 10. Everyone leaves: no seal survives anywhere.
    for (const c of clients.splice(0)) await c.close();
    for (const d of DEVICES) {
      const clear = await waitFor(
        () =>
          !/i/.test(
            asDev(d, "lsattr src/auth.ts src/billing.py", true)
              .out.split("\n")
              .map((l) => l.split(" ")[0])
              .join("")
          ),
        `${d} unseal`,
        20_000
      ).then(
        () => true,
        () => false
      );
      check(`${d}: all seals released after the agents left`, clear);
    }
    check(
      "the rogue can write again once nobody holds a lock",
      asDev("laptop-ben", "echo ok >> src/auth.ts && echo ok", true).out.endsWith("ok")
    );
  } finally {
    for (const c of clients) await c.close().catch(() => {});
    for (const n of ["hub", ...DEVICES])
      sh(["docker", "rm", "-f", `${RUN}-${n}`], { allowFail: true });
    sh(["docker", "network", "rm", NET], { allowFail: true });
    sh(["docker", "rmi", "-f", IMAGE], { allowFail: true });
  }
  console.log(
    `\n${results.length - failures}/${results.length} checks passed across ${DEVICES.length} devices.`
  );
  process.exit(failures ? 1 : 0);
}

async function waitFor(fn: () => boolean, what: string, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await Bun.sleep(250);
  }
  throw new Error(`timed out waiting for ${what}`);
}

await main();
