-- M4.6: Optional WebAuthn passkey sign-in. Email OTP remains the always-on
-- fallback, so a user deleting their last passkey cannot lock themselves out.

CREATE TABLE passkeys (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL REFERENCES users(id),
  -- base64url-encoded credentialId from the authenticator
  credential_id   TEXT NOT NULL UNIQUE,
  -- base64url-encoded COSE public key bytes
  public_key      TEXT NOT NULL,
  -- WebAuthn signature counter; we reject responses that don't advance it
  counter         INTEGER NOT NULL DEFAULT 0,
  -- JSON-encoded string array, e.g. '["internal","hybrid"]'
  transports      TEXT,
  -- user-visible label so they can tell their keys apart in the management UI
  nickname        TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at    TEXT
);

CREATE INDEX idx_passkeys_user ON passkeys(user_id);
