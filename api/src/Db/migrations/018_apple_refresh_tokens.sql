-- 018_apple_refresh_tokens — hold what Apple needs to revoke an account (#81).
--
-- Apple requires an app offering Sign in with Apple to call the revoke
-- endpoint when a user deletes their account, and revoking needs a refresh
-- token. We never had one: AppleAuthService verifies the identity token and
-- stops there, so there was nothing to revoke WITH.
--
-- Nullable on purpose. Existing Apple identities predate this and will have
-- no token, sign-ins before the SIWA key is configured will have none either,
-- and deletion must never be blocked by its absence — a user asking to be
-- deleted gets deleted, whatever Apple's side does.

ALTER TABLE oauth_identities
    ADD COLUMN refresh_token VARCHAR(512) NULL AFTER email;

INSERT INTO schema_migrations (version) VALUES (18);
