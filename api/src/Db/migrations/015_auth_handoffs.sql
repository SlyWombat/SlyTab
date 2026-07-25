-- 015_auth_handoffs — mobile "Sign in with Google" via browser handoff (issue #39).
-- The app starts a handoff (public state + secret verifier), the system
-- browser signs in with Google on the web app and completes it, and the
-- app claims a session with the verifier. Rows are short-lived and
-- single-use; the session token never passes through the browser.

CREATE TABLE auth_handoffs (
  id            CHAR(26)     NOT NULL PRIMARY KEY, -- ULID
  state         CHAR(32)     NOT NULL,             -- public id, carried in the browser URL
  verifier_hash CHAR(64)     NOT NULL,             -- sha256 of the app-held secret
  device_label  VARCHAR(80)  NOT NULL DEFAULT '',
  user_id       CHAR(26)     NULL,                 -- set when the browser side completes
  created_at    DATETIME     NOT NULL,
  completed_at  DATETIME     NULL,
  UNIQUE KEY uq_handoff_state (state),
  KEY idx_handoff_created (created_at),
  CONSTRAINT fk_handoff_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO schema_migrations (version) VALUES (15);
