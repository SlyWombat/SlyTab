-- 024_ops_alerts — remember which operational alerts have already been sent.
--
-- The owner asked (2026-09-04) to be told when the scan queue ever goes over
-- five people waiting, and when the service reaches 10 and then 100 real
-- signups. Both need memory, for opposite reasons:
--
--   · A MILESTONE must fire exactly once, ever. "You have 10 users" is not
--     news the second time, and the count is recomputed on every signup, so
--     without a record every subsequent signup would send it again.
--   · A THRESHOLD must fire at most once per cooldown. The scan queue drains
--     in seconds, so a busy minute crosses "over five waiting" repeatedly;
--     a mail per crossing would be a stampede about a stampede.
--
-- One row per alert key. `INSERT IGNORE` on the primary key is what makes
-- "once, ever" atomic, and a conditional UPDATE on `last_fired_at` is what
-- makes "once per cooldown" atomic — both without a transaction, so this can
-- never hold a lock on the path of a user's scan.
--
-- Nothing here is user data and nothing is on a hot path: at most one row is
-- touched per signup, and one per scan that finds a queue.
CREATE TABLE ops_alerts (
  alert_key      VARCHAR(64) NOT NULL PRIMARY KEY,
  first_fired_at DATETIME(3) NOT NULL,
  last_fired_at  DATETIME(3) NOT NULL,
  times          INT UNSIGNED NOT NULL DEFAULT 1
);

INSERT INTO schema_migrations (version) VALUES (24);
