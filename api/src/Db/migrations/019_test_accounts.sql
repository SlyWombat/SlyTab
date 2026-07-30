-- 019_test_accounts — mark accounts that are not real people.
--
-- The owner asked for a management dashboard and, sensibly, for test accounts
-- to be excluded from it. Nine accounts existed when this was written and only
-- four were real people; a dashboard reading "9 users" would flatter and
-- mislead exactly when the number starts to matter.
--
-- A column rather than a hard-coded list in the query: new test accounts get
-- created all the time (App Store reviewers, emulator runs, picker fixtures),
-- and a list in code rots silently. Flagging is explicit and auditable.
--
-- Deliberately NOT a filter on email domain. Test accounts here live on
-- example.com, electricrv.ca, slymega.com and drscapital.com — the last two
-- are the owner's own domains, which also carry his REAL account. There is no
-- rule that separates them; a human has to say.

ALTER TABLE users
    ADD COLUMN is_test TINYINT(1) NOT NULL DEFAULT 0 AFTER placeholder_at;

INSERT INTO schema_migrations (version) VALUES (19);
