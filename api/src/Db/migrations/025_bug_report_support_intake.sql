-- 025_bug_report_support_intake — issue #133: in-app reports go to the
-- shared Electric RV support intake instead of becoming GitHub issues.
--
-- `reference` is the ST-YYMMDD-XXXX the support system threads and routes
-- by. It is minted when the report is created and shown to the reporter, so
-- a later email quoting it joins the same case. Reports from before this
-- change keep NULL (they were all closed under the old pipeline).
--
-- `forwarded_at` is set once the support email has been handed to the MTA.
-- A report still NULL here is retried by the 10-minute bug-sync cron, so a
-- mail hiccup delays a report instead of losing it.
--
-- `issue_number` stays for the history of old reports; nothing writes it now.
ALTER TABLE bug_reports
  ADD COLUMN reference    VARCHAR(16) NULL AFTER id,
  ADD COLUMN forwarded_at DATETIME    NULL AFTER issue_number,
  ADD UNIQUE KEY uq_bugs_reference (reference);

INSERT INTO schema_migrations (version) VALUES (25);
