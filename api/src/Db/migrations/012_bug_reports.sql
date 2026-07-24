-- 012_bug_reports — in-app "Report a bug" from the profile page, with an
-- optional screenshot the reviewer sees alongside the comment.

CREATE TABLE bug_reports (
  id         CHAR(26)      NOT NULL PRIMARY KEY,
  user_id    CHAR(26)      NOT NULL,
  message    VARCHAR(2000) NOT NULL,
  context    VARCHAR(500)  NULL,     -- client-supplied: platform, version, screen
  image_path VARCHAR(255)  NULL,     -- screenshot in DATA_DIR, like receipts
  status     ENUM('new','seen','closed') NOT NULL DEFAULT 'new',
  created_at DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_bugs_status_time (status, created_at),
  CONSTRAINT fk_bugs_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO schema_migrations (version) VALUES (12);
