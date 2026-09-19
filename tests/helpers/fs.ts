import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** A scratch workspace. `dispose` clears any seal first, or the directory could not be removed. */
export function scratchDir(prefix = "axis-test-"): { dir: string; dispose: () => void } {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
  return {
    dir,
    dispose: () => {
      if (process.platform === "darwin") Bun.spawnSync(["chflags", "-R", "nouchg", dir]);
      else Bun.spawnSync(["chmod", "-R", "u+w", dir]);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Try a raw, non-Axis write the way any other tool would. Returns the error code, or "written". */
export function rogueWrite(file: string, text: string): string {
  try {
    writeFileSync(file, text);
    return "written";
  } catch (e) {
    return (e as NodeJS.ErrnoException).code ?? "error";
  }
}

export async function until(
  fn: () => boolean | Promise<boolean>,
  ms = 5000,
  step = 25
): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await Bun.sleep(step);
  }
  return false;
}

/** Stop the daemon on `socket` and make sure its process is really gone (a stray daemon keeps sealing files). */
export async function stopDaemon(socket: string): Promise<void> {
  const pid = await fetch("http://axisd/status", { unix: socket } as RequestInit)
    .then((r) => r.json() as Promise<{ pid: number }>)
    .then(
      (s) => s.pid,
      () => 0
    );
  await fetch("http://axisd/shutdown", { method: "POST", unix: socket } as RequestInit).catch(
    () => {}
  );
  if (!pid) return;
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  if (!(await until(() => !alive(), 5_000))) process.kill(pid, "SIGKILL");
}
