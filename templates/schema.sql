-- Additive tables for official-account login. Nothing here touches existing user data.

-- One row per issued code. Pairing rows keep openid='pending' until the visitor
-- sends the code from WeChat; message_id then holds the HMAC of the browser secret.
CREATE TABLE IF NOT EXISTS wechat_login_codes (
  app_id      text        NOT NULL,          -- namespace, e.g. 'wx123:mysite:pair'
  message_id  text        NOT NULL,
  openid      text        NOT NULL,
  code_hash   text        NOT NULL UNIQUE,   -- HMAC only, never the plain code
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (app_id, message_id)
);
CREATE INDEX IF NOT EXISTS wechat_codes_openid_idx ON wechat_login_codes (app_id, openid, created_at);
CREATE INDEX IF NOT EXISTS wechat_codes_expiry_idx ON wechat_login_codes (expires_at);

-- Fixed-window rate limits shared by every instance.
CREATE TABLE IF NOT EXISTS wechat_rate_limits (
  bucket       text PRIMARY KEY,
  window_start timestamptz NOT NULL,
  attempts     integer     NOT NULL
);

-- Identity mapping. If you use Better Auth / NextAuth, store this as an
-- account row (provider 'wechat-mp', account_id = site subject) instead.
CREATE TABLE IF NOT EXISTS wechat_identities (
  app_id     text        NOT NULL,
  subject    text        NOT NULL,
  user_id    text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (app_id, subject),
  UNIQUE (app_id, user_id)
);

-- Daily cleanup:
-- DELETE FROM wechat_login_codes WHERE expires_at < now() - interval '1 day';
-- DELETE FROM wechat_rate_limits WHERE window_start < now() - interval '1 day';
