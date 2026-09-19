/**
 * Bundle the hosted hub into dist/edge/: one JS file plus the Deno import map,
 * ready for `supabase functions deploy axis --no-verify-jwt` (or the MCP deploy).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const out = path.join(root, "dist/edge");
mkdirSync(out, { recursive: true });

const result = await Bun.build({
  entrypoints: [path.join(root, "supabase/functions/axis/index.ts")],
  target: "node",
  format: "esm",
  external: ["postgres"],
  minify: false,
});
if (!result.success) {
  for (const l of result.logs) console.error(l);
  process.exit(1);
}
const code = await result.outputs[0]!.text();
if (/\bBun\./.test(code) || code.includes("bun:sqlite"))
  throw new Error("The edge bundle must not depend on Bun APIs.");
writeFileSync(path.join(out, "index.js"), code);
writeFileSync(
  path.join(out, "deno.json"),
  JSON.stringify({ imports: { postgres: "npm:postgres@3.4.7" } }, null, 2) + "\n"
);
console.log(`dist/edge/index.js ${(code.length / 1024).toFixed(0)} KB`);
