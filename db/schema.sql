-- Initial additive schema. Apply through scripts/migrate.js using a backend database role.
CREATE SCHEMA IF NOT EXISTS member_network;
REVOKE ALL ON SCHEMA member_network FROM PUBLIC;
CREATE TABLE IF NOT EXISTS member_network.members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), discord_id text UNIQUE NOT NULL CHECK(discord_id ~ '^[0-9]{17,20}$'),
  username text NOT NULL, interests text[] NOT NULL DEFAULT '{}', active boolean NOT NULL DEFAULT true,
  connection_status text NOT NULL DEFAULT 'connected' CHECK(connection_status IN ('connected','revoked','expired')),
  created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS member_network.connections (
  member_id uuid PRIMARY KEY REFERENCES member_network.members(id), encrypted_tokens text,expires_at timestamptz NOT NULL,
  revoke_pending boolean NOT NULL DEFAULT false,revoke_after timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS member_network.oauth_states (
  state_hash text PRIMARY KEY,browser_hash text NOT NULL,expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS member_network.sessions (
  token_hash text PRIMARY KEY, kind text NOT NULL CHECK(kind IN ('admin','member')),subject text NOT NULL,
  credential text, expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS member_network.communities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),guild_id text NOT NULL UNIQUE CHECK(guild_id ~ '^[0-9]{17,20}$'),name text NOT NULL,
  description text NOT NULL DEFAULT '',language text NOT NULL DEFAULT 'id', tags text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','suspended')),created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS member_network.consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),member_id uuid NOT NULL REFERENCES member_network.members(id),
  community_id uuid NOT NULL REFERENCES member_network.communities(id),version text NOT NULL,expires_at timestamptz NOT NULL,
  revoked_at timestamptz,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS consent_active ON member_network.consents(member_id,community_id) WHERE revoked_at IS NULL;
CREATE TABLE IF NOT EXISTS member_network.campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),community_id uuid NOT NULL REFERENCES member_network.communities(id),name text NOT NULL,
  member_limit integer NOT NULL DEFAULT 100 CHECK(member_limit BETWEEN 1 AND 1000),tags text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','running','paused','completed','cancelled')),
  starts_at timestamptz NOT NULL,ends_at timestamptz NOT NULL,CHECK(ends_at>starts_at),created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS member_network.jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),campaign_id uuid NOT NULL REFERENCES member_network.campaigns(id),
  community_id uuid NOT NULL REFERENCES member_network.communities(id),member_id uuid NOT NULL REFERENCES member_network.members(id),
  consent_id uuid NOT NULL UNIQUE REFERENCES member_network.consents(id),
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','processing','retry','added','already_member','pending','failed','cancelled','unknown')),
  attempts integer NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL DEFAULT now(), lease_until timestamptz,lease_token uuid,error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(campaign_id,member_id)
);
CREATE INDEX IF NOT EXISTS jobs_due ON member_network.jobs(next_attempt_at) WHERE status IN ('queued','retry');
CREATE INDEX IF NOT EXISTS jobs_member ON member_network.jobs(member_id,created_at DESC);
CREATE INDEX IF NOT EXISTS consents_member ON member_network.consents(member_id);
CREATE TABLE IF NOT EXISTS member_network.audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),actor text NOT NULL,action text NOT NULL,entity text,detail jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_recent ON member_network.audit(created_at DESC);
CREATE TABLE IF NOT EXISTS member_network.runtime (key text PRIMARY KEY,value timestamptz NOT NULL);
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['members','connections','oauth_states','sessions','communities','consents','campaigns','jobs','audit','runtime'] LOOP
    EXECUTE format('ALTER TABLE member_network.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON member_network.%I FROM PUBLIC',t);
  END LOOP;
  -- Supabase roles are optional in isolated PostgreSQL; never grant clients schema access.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON SCHEMA member_network FROM anon;
    REVOKE ALL ON ALL TABLES IN SCHEMA member_network FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    REVOKE ALL ON SCHEMA member_network FROM authenticated;
    REVOKE ALL ON ALL TABLES IN SCHEMA member_network FROM authenticated;
  END IF;
END $$;
