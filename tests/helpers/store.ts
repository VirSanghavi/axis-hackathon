import { migratePostgres } from "../../src/hub/postgres-schema.ts";
import { PostgresStore } from "../../src/hub/postgres-store.ts";
import { SqliteStore } from "../../src/hub/sqlite-store.ts";
import type { Store } from "../../src/hub/store.ts";

/**
 * Every hub and integration suite runs against both stores: SQLite by default,
 * Postgres when AXIS_TEST_PG is a connection string (CI runs both).
 */
const PG = process.env.AXIS_TEST_PG;
let migrated: Promise<void> | undefined;

export const storeKind = PG ? "postgres" : "sqlite";

export async function testStore(): Promise<Store> {
  if (!PG) return new SqliteStore(":memory:");
  migrated ??= migratePostgres(PG);
  await migrated;
  return new PostgresStore(PG, { max: 10 });
}
