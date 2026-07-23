-- 003 — email verification (issue #1 item 1).

ALTER TABLE users ADD COLUMN email_verified_at DATETIME NULL AFTER email;

CREATE TABLE email_verifications (
  id         CHAR(26) NOT NULL PRIMARY KEY,
  user_id    CHAR(26) NOT NULL,
  token_hash CHAR(64) NOT NULL UNIQUE,
  expires_at DATETIME NOT NULL,
  used_at    DATETIME NULL,
  CONSTRAINT fk_emailver_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO schema_migrations (version) VALUES (3);
