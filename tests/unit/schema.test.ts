import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PG_SCHEMA } from "../../src/hub/postgres-schema.ts";

// The hosted database is created from the migration file; local Postgres tests from PG_SCHEMA. They must not drift.
test("supabase migration matches PG_SCHEMA", () => {
  const dir = path.resolve(import.meta.dir, "../../supabase/migrations");
  const [file] = readdirSync(dir).filter((f) => f.endsWith("_axis_hub.sql"));
  const sql = readFileSync(path.join(dir, file!), "utf8")
    .split("\n")
    .filter((l) => !l.startsWith("--"))
    .join("\n");
  expect(sql.trim()).toBe(PG_SCHEMA.trim());
});
