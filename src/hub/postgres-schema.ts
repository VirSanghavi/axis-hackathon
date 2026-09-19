import postgres from "postgres";

/**
 * The Postgres schema for the hosted hub. Kept apart from the store so the edge
 * bundle does not carry it; supabase/migrations holds the same SQL (a test keeps
 * them identical).
 */
export const PG_SCHEMA = `
CREATE SCHEMA IF NOT EXISTS axis;
CREATE TABLE IF NOT EXISTS axis.projects (
  id text PRIMARY KEY,
  name text NOT NULL,
  invite text NOT NULL UNIQUE,
  job_seq integer NOT NULL DEFAULT 0,
  soul_context text NOT NULL DEFAULT '',
  soul_conventions text NOT NULL DEFAULT '',
  created_at bigint NOT NULL
);
CREATE TABLE IF NOT EXISTS axis.members (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES axis.projects(id) ON DELETE CASCADE,
  name text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  created_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS members_project ON axis.members(project_id);
CREATE TABLE IF NOT EXISTS axis.agents (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES axis.projects(id) ON DELETE CASCADE,
  member_id text NOT NULL REFERENCES axis.members(id) ON DELETE CASCADE,
  name text NOT NULL,
  vendor text NOT NULL,
  member text NOT NULL,
  device text NOT NULL,
  task text,
  token_hash text NOT NULL UNIQUE,
  started_at bigint NOT NULL,
  last_seen_at bigint NOT NULL,
  ended_at bigint
);
CREATE INDEX IF NOT EXISTS agents_project ON axis.agents(project_id, ended_at);
CREATE INDEX IF NOT EXISTS agents_member ON axis.agents(member_id);
CREATE TABLE IF NOT EXISTS axis.locks (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES axis.projects(id) ON DELETE CASCADE,
  path text NOT NULL,
  symbol text NOT NULL,
  agent_id text NOT NULL REFERENCES axis.agents(id) ON DELETE CASCADE,
  intent text NOT NULL,
  job_id text,
  acquired_at bigint NOT NULL,
  expires_at bigint NOT NULL,
  UNIQUE (project_id, path, symbol)
);
CREATE INDEX IF NOT EXISTS locks_agent ON axis.locks(agent_id);
CREATE INDEX IF NOT EXISTS locks_expires ON axis.locks(expires_at);
CREATE TABLE IF NOT EXISTS axis.waiters (
  seq bigserial PRIMARY KEY,
  id text NOT NULL UNIQUE,
  project_id text NOT NULL REFERENCES axis.projects(id) ON DELETE CASCADE,
  agent_id text NOT NULL REFERENCES axis.agents(id) ON DELETE CASCADE,
  targets jsonb NOT NULL,
  acquire boolean NOT NULL,
  intent text NOT NULL,
  job_id text,
  deadline bigint NOT NULL,
  lease_ms bigint NOT NULL,
  result jsonb
);
CREATE INDEX IF NOT EXISTS waiters_project ON axis.waiters(project_id, seq);
CREATE INDEX IF NOT EXISTS waiters_agent ON axis.waiters(agent_id);
CREATE TABLE IF NOT EXISTS axis.jobs (
  id text NOT NULL,
  project_id text NOT NULL REFERENCES axis.projects(id) ON DELETE CASCADE,
  title text NOT NULL,
  description text NOT NULL,
  priority text NOT NULL,
  status text NOT NULL,
  dependencies jsonb NOT NULL DEFAULT '[]',
  assignee text,
  created_by text NOT NULL,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  outcome text,
  PRIMARY KEY (project_id, id)
);
CREATE TABLE IF NOT EXISTS axis.devices (
  id text NOT NULL,
  project_id text NOT NULL REFERENCES axis.projects(id) ON DELETE CASCADE,
  member text NOT NULL,
  hostname text NOT NULL,
  platform text NOT NULL,
  tier text NOT NULL,
  sealed jsonb NOT NULL DEFAULT '[]',
  health jsonb NOT NULL DEFAULT '{}',
  last_seen_at bigint NOT NULL,
  PRIMARY KEY (project_id, id)
);
ALTER TABLE axis.devices ADD COLUMN IF NOT EXISTS health jsonb NOT NULL DEFAULT '{}';
CREATE TABLE IF NOT EXISTS axis.events (
  seq bigserial PRIMARY KEY,
  project_id text NOT NULL REFERENCES axis.projects(id) ON DELETE CASCADE,
  ts bigint NOT NULL,
  type text NOT NULL,
  agent jsonb,
  text text NOT NULL,
  data jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS events_project ON axis.events(project_id, seq);
ALTER TABLE axis.projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE axis.members ENABLE ROW LEVEL SECURITY;
ALTER TABLE axis.agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE axis.locks ENABLE ROW LEVEL SECURITY;
ALTER TABLE axis.waiters ENABLE ROW LEVEL SECURITY;
ALTER TABLE axis.jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE axis.devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE axis.events ENABLE ROW LEVEL SECURITY;
`;

/** Create the schema (idempotent). Hosted deployments apply the migration file instead. */
export async function migratePostgres(url: string): Promise<void> {
  const sql = postgres(url, { prepare: false, max: 1, onnotice: () => {} });
  try {
    await sql.unsafe(PG_SCHEMA);
  } finally {
    await sql.end();
  }
}
