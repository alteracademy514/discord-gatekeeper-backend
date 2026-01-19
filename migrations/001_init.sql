CREATE TABLE IF NOT EXISTS users (
  discord_id TEXT PRIMARY KEY,
  stripe_customer_id TEXT,
  subscription_status TEXT NOT NULL DEFAULT 'unlinked',
  link_deadline TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS link_tokens (
  token TEXT PRIMARY KEY,
  discord_id TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_link_tokens_discord_id ON link_tokens(discord_id);
CREATE INDEX IF NOT EXISTS idx_link_tokens_expires_at ON link_tokens(expires_at);