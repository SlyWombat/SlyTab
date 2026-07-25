-- 014_onboarding — issue #36: first sign-in welcome flow. onboarded_at
-- NULL means the user hasn't completed onboarding yet. Existing users are
-- backfilled so they never see it.

ALTER TABLE users ADD COLUMN onboarded_at DATETIME NULL AFTER notify_level;
UPDATE users SET onboarded_at = created_at WHERE onboarded_at IS NULL;

INSERT INTO schema_migrations (version) VALUES (14);
