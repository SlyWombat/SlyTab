-- 002 — password reset tokens + fixed-window rate limiting (NFR-2).

CREATE TABLE password_resets (
  id         CHAR(26) NOT NULL PRIMARY KEY,
  user_id    CHAR(26) NOT NULL,
  token_hash CHAR(64) NOT NULL UNIQUE,
  expires_at DATETIME NOT NULL,
  used_at    DATETIME NULL,
  CONSTRAINT fk_pwreset_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Fixed-window counters; k = sha256(scope:identifier:window-start).
-- Rows are lazily deleted once expired.
CREATE TABLE rate_limits (
  k          CHAR(64) NOT NULL PRIMARY KEY,
  hits       INT      NOT NULL DEFAULT 1,
  expires_at DATETIME NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO schema_migrations (version) VALUES (2);
