-- 008_placeholder_members — issue #2: Splitwise imports can include people
-- who haven't joined yet. They get a placeholder account that holds their
-- expense history; registering (or Google/Apple sign-in) with the same
-- email claims it, history intact.

ALTER TABLE users ADD COLUMN placeholder_at DATETIME NULL AFTER deleted_at;

INSERT INTO schema_migrations (version) VALUES (8);
