-- 004_oauth_identities — "Sign in with Google" (issue: Google OAuth).
-- One row per external identity; a user may have several providers.

CREATE TABLE oauth_identities (
  id         CHAR(26)     NOT NULL PRIMARY KEY, -- ULID
  user_id    CHAR(26)     NOT NULL,
  provider   VARCHAR(20)  NOT NULL,             -- 'google'
  subject    VARCHAR(191) NOT NULL,             -- provider's stable user id (JWT `sub`)
  email      VARCHAR(255) NOT NULL,             -- email at link time (informational)
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_provider_subject (provider, subject),
  KEY idx_oauth_user (user_id),
  CONSTRAINT fk_oauth_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO schema_migrations (version) VALUES (4);
