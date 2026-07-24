-- 010_push_and_prefs — issue #3: Expo push tokens + per-user preference.

CREATE TABLE push_tokens (
  token      VARCHAR(255) NOT NULL PRIMARY KEY, -- ExponentPushToken[...]
  user_id    CHAR(26)     NOT NULL,
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_push_user (user_id),
  CONSTRAINT fk_push_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

ALTER TABLE users ADD COLUMN notify_level ENUM('all','important','none')
  NOT NULL DEFAULT 'all' AFTER payment_handles;

INSERT INTO schema_migrations (version) VALUES (10);
