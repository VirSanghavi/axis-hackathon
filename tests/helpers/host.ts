/**
 * Stand-in for an agent host (Claude Code, Cursor...). It spawns one Axis MCP
 * server over inherited stdio and lives exactly as long as it does, so each
 * host gets its own pid, and with it its own Axis agent session.
 */
const child = Bun.spawn(process.argv.slice(2), {
  stdio: ["inherit", "inherit", "inherit"],
  env: process.env,
});
process.exit(await child.exited);

export {};
