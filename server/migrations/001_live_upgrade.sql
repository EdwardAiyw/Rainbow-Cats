\encoding UTF8

-- Give browsers from the token-only deployment enough time to open the new
-- Settings page and claim a durable username/password.  This affects only
-- legacy users and remains compatible with the previous server.
UPDATE sessions
SET expires_at = now() + interval '90 days'
WHERE revoked_at IS NULL
  AND expires_at < now() + interval '90 days'
  AND user_id IN (SELECT id FROM users WHERE username IS NULL);
