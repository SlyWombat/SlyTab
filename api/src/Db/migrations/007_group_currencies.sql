-- 007_group_currencies — per-group favorite currencies: quick picks in
-- the expense form; any other currency remains selectable.

ALTER TABLE `groups` ADD COLUMN currencies JSON NOT NULL DEFAULT (JSON_ARRAY()) AFTER home_currency;

INSERT INTO schema_migrations (version) VALUES (7);
