-- 013_bug_report_issues — issue #25: reporters get emailed when their
-- report is filed and when its GitHub issue closes; the issue number
-- links the two.

ALTER TABLE bug_reports ADD COLUMN issue_number INT NULL AFTER status;

INSERT INTO schema_migrations (version) VALUES (13);
