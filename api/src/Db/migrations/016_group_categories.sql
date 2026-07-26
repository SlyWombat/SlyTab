-- 016_group_categories — per-group category customisation (issue #18).
--
-- The taxonomy itself ships in @slytab/core; this table holds only what a
-- group CHANGED about it, so the shipped defaults stay free to improve and
-- a group that never opens the manage screen stores nothing at all.
-- Expenses keep storing the category slug as a plain string.

-- expenses.category has been an ENUM of exactly the assignable values since
-- 001. Subcategory slugs ('adulting.maintenance') don't fit it, and pinning
-- the taxonomy into the schema would mean an ALTER every time a category is
-- added. Widen it to a string and let Support\Categories be the one
-- authority — the parity test keeps that honest against @slytab/core.
ALTER TABLE expenses MODIFY category VARCHAR(48) NOT NULL DEFAULT 'other';

CREATE TABLE group_categories (
  group_id   CHAR(26)     NOT NULL,
  slug       VARCHAR(48)  NOT NULL,             -- 'travel' or 'travel.taxi'
  label      VARCHAR(60)  NULL,                 -- NULL = keep the shipped label
  hidden     TINYINT(1)   NOT NULL DEFAULT 0,   -- kept out of the picker
  sort_order INT          NULL,                 -- NULL = shipped order
  updated_at DATETIME     NOT NULL,
  PRIMARY KEY (group_id, slug),
  CONSTRAINT fk_gcat_group FOREIGN KEY (group_id) REFERENCES `groups` (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO schema_migrations (version) VALUES (16);
