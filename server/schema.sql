\encoding UTF8

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), username varchar(40) UNIQUE, password_hash text, recovery_code_hash text, legacy_open_id text UNIQUE,
  display_name varchar(40) NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

-- Upgrade the token-only web deployment in place.  These statements are
-- intentionally additive so the previous server can still be used for a
-- rollback after this schema has been applied.
ALTER TABLE users ADD COLUMN IF NOT EXISTS username varchar(40);
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS recovery_code_hash text;
ALTER TABLE users ALTER COLUMN display_name TYPE varchar(40);
CREATE UNIQUE INDEX IF NOT EXISTS users_username_unique ON users(username) WHERE username IS NOT NULL;
CREATE TABLE IF NOT EXISTS spaces (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), invite_code varchar(12) UNIQUE NOT NULL, owner_user_id uuid NOT NULL REFERENCES users(id), currency varchar(3) NOT NULL DEFAULT 'CNY', created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE spaces ADD COLUMN IF NOT EXISTS currency varchar(3) NOT NULL DEFAULT 'CNY';
CREATE TABLE IF NOT EXISTS space_members (space_id uuid NOT NULL REFERENCES spaces(id) ON DELETE CASCADE, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, display_name varchar(40) NOT NULL, credit integer NOT NULL DEFAULT 0 CHECK (credit >= 0 AND credit <= 500), created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (space_id, user_id), UNIQUE (user_id));
ALTER TABLE space_members ALTER COLUMN display_name TYPE varchar(40);
CREATE TABLE IF NOT EXISTS sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, token_hash text UNIQUE NOT NULL, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz);
CREATE TABLE IF NOT EXISTS recovery_attempts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid REFERENCES users(id) ON DELETE CASCADE, attempted_at timestamptz NOT NULL DEFAULT now(), success boolean NOT NULL DEFAULT false);
CREATE TABLE IF NOT EXISTS missions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), space_id uuid NOT NULL REFERENCES spaces(id) ON DELETE CASCADE, creator_id uuid NOT NULL REFERENCES users(id), title varchar(120) NOT NULL, description varchar(1000) NOT NULL DEFAULT '', credit integer NOT NULL CHECK (credit > 0 AND credit <= 500), available boolean NOT NULL DEFAULT true, star boolean NOT NULL DEFAULT false, completed_by uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz);
ALTER TABLE missions ALTER COLUMN title TYPE varchar(120);
ALTER TABLE missions ALTER COLUMN description TYPE varchar(1000);
CREATE TABLE IF NOT EXISTS market_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), space_id uuid NOT NULL REFERENCES spaces(id) ON DELETE CASCADE, creator_id uuid NOT NULL REFERENCES users(id), title varchar(120) NOT NULL, description varchar(1000) NOT NULL DEFAULT '', credit integer NOT NULL CHECK (credit > 0 AND credit <= 500), available boolean NOT NULL DEFAULT true, purchased_by uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), purchased_at timestamptz);
ALTER TABLE market_items ALTER COLUMN title TYPE varchar(120);
ALTER TABLE market_items ALTER COLUMN description TYPE varchar(1000);
CREATE TABLE IF NOT EXISTS storage_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), space_id uuid NOT NULL REFERENCES spaces(id) ON DELETE CASCADE, owner_id uuid NOT NULL REFERENCES users(id), source_item_id uuid REFERENCES market_items(id), title varchar(120) NOT NULL, description varchar(1000) NOT NULL DEFAULT '', credit integer NOT NULL, available boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), used_at timestamptz);
ALTER TABLE storage_items ALTER COLUMN title TYPE varchar(120);
ALTER TABLE storage_items ALTER COLUMN description TYPE varchar(1000);
CREATE TABLE IF NOT EXISTS recipes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), space_id uuid NOT NULL REFERENCES spaces(id) ON DELETE CASCADE, creator_id uuid REFERENCES users(id), title varchar(160) NOT NULL, description varchar(1000) NOT NULL DEFAULT '', ingredients text NOT NULL DEFAULT '', steps text NOT NULL DEFAULT '', flavor varchar(40) NOT NULL DEFAULT '家常', difficulty varchar(40) NOT NULL DEFAULT '简单', minutes integer, cuisine varchar(60) NOT NULL DEFAULT '家常菜', is_preset boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE recipes ALTER COLUMN title TYPE varchar(160);
ALTER TABLE recipes ALTER COLUMN description TYPE varchar(1000);
ALTER TABLE recipes ALTER COLUMN ingredients TYPE text;
ALTER TABLE recipes ALTER COLUMN steps TYPE text;
ALTER TABLE recipes ALTER COLUMN flavor TYPE varchar(40);
ALTER TABLE recipes ALTER COLUMN difficulty TYPE varchar(40);
ALTER TABLE recipes ALTER COLUMN cuisine TYPE varchar(60);
CREATE TABLE IF NOT EXISTS calendar_connections (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), space_id uuid NOT NULL REFERENCES spaces(id) ON DELETE CASCADE, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, provider varchar(30) NOT NULL DEFAULT 'caldav', calendar_url text NOT NULL, account_label varchar(120) NOT NULL DEFAULT '', credential_ciphertext text NOT NULL, status varchar(30) NOT NULL DEFAULT 'pending', last_synced_at timestamptz, UNIQUE(space_id, user_id));
CREATE TABLE IF NOT EXISTS calendar_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), space_id uuid NOT NULL REFERENCES spaces(id) ON DELETE CASCADE, external_id varchar(300), title varchar(200) NOT NULL, notes text NOT NULL DEFAULT '', starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL, all_day boolean NOT NULL DEFAULT false, source varchar(30) NOT NULL DEFAULT 'local', updated_by uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(space_id, external_id));
CREATE TABLE IF NOT EXISTS calendar_sync_conflicts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), space_id uuid NOT NULL REFERENCES spaces(id) ON DELETE CASCADE, event_id uuid REFERENCES calendar_events(id) ON DELETE CASCADE, local_payload jsonb NOT NULL, remote_payload jsonb NOT NULL, status varchar(20) NOT NULL DEFAULT 'open', created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS expenses (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), space_id uuid NOT NULL REFERENCES spaces(id) ON DELETE CASCADE, created_by uuid NOT NULL REFERENCES users(id), amount numeric(12,2) NOT NULL CHECK (amount > 0), category varchar(50) NOT NULL, note varchar(300) NOT NULL DEFAULT '', spent_on date NOT NULL DEFAULT CURRENT_DATE, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS budgets (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), space_id uuid NOT NULL REFERENCES spaces(id) ON DELETE CASCADE, month date NOT NULL, amount numeric(12,2) NOT NULL CHECK (amount >= 0), UNIQUE(space_id, month));
CREATE TABLE IF NOT EXISTS albums (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), space_id uuid NOT NULL REFERENCES spaces(id) ON DELETE CASCADE, title varchar(120) NOT NULL DEFAULT '我们的相册', created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS photos (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), album_id uuid NOT NULL REFERENCES albums(id) ON DELETE CASCADE, uploaded_by uuid NOT NULL REFERENCES users(id), original_path text NOT NULL, thumbnail_path text NOT NULL, caption varchar(300) NOT NULL DEFAULT '', taken_at timestamptz, metadata jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS ai_action_proposals (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), space_id uuid NOT NULL REFERENCES spaces(id) ON DELETE CASCADE, created_by uuid NOT NULL REFERENCES users(id), action varchar(80) NOT NULL, payload jsonb NOT NULL DEFAULT '{}'::jsonb, status varchar(20) NOT NULL DEFAULT 'pending', result jsonb, created_at timestamptz NOT NULL DEFAULT now(), confirmed_at timestamptz);
CREATE TABLE IF NOT EXISTS audit_logs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), space_id uuid REFERENCES spaces(id) ON DELETE CASCADE, user_id uuid REFERENCES users(id) ON DELETE SET NULL, action varchar(120) NOT NULL, entity_type varchar(80), entity_id uuid, metadata jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS channel_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel varchar(40) NOT NULL,
  agent_account_id varchar(160) NOT NULL,
  sender_key_hash char(64) NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  space_id uuid NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(channel, agent_account_id, sender_key_hash),
  UNIQUE(channel, agent_account_id, user_id)
);
CREATE INDEX IF NOT EXISTS channel_identities_user ON channel_identities(user_id, space_id);
CREATE TABLE IF NOT EXISTS identity_link_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  space_id uuid NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  token_hash char(64) NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS identity_link_tokens_active ON identity_link_tokens(token_hash, expires_at) WHERE used_at IS NULL;

ALTER TABLE ai_action_proposals ADD COLUMN IF NOT EXISTS source_channel varchar(40);
ALTER TABLE ai_action_proposals ADD COLUMN IF NOT EXISTS source_agent_account_id varchar(160);
ALTER TABLE ai_action_proposals ADD COLUMN IF NOT EXISTS source_sender_key_hash char(64);
ALTER TABLE ai_action_proposals ADD COLUMN IF NOT EXISTS confirmation_code_hash char(64);
ALTER TABLE ai_action_proposals ADD COLUMN IF NOT EXISTS confirmation_expires_at timestamptz;
ALTER TABLE ai_action_proposals ADD COLUMN IF NOT EXISTS confirmation_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE ai_action_proposals ADD COLUMN IF NOT EXISTS confirmed_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE ai_action_proposals ADD COLUMN IF NOT EXISTS executed_at timestamptz;
CREATE INDEX IF NOT EXISTS ai_proposals_confirmation ON ai_action_proposals(confirmation_code_hash) WHERE status = 'pending';
CREATE TABLE IF NOT EXISTS api_usage (service varchar(40) NOT NULL, usage_date date NOT NULL, count integer NOT NULL DEFAULT 0 CHECK (count >= 0), actions jsonb NOT NULL DEFAULT '{}'::jsonb, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(service, usage_date));
CREATE INDEX IF NOT EXISTS missions_space_created ON missions(space_id, created_at DESC);
CREATE INDEX IF NOT EXISTS market_space_created ON market_items(space_id, created_at DESC);
CREATE INDEX IF NOT EXISTS storage_owner_created ON storage_items(owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS expenses_space_date ON expenses(space_id, spent_on DESC);
CREATE INDEX IF NOT EXISTS events_space_start ON calendar_events(space_id, starts_at);
