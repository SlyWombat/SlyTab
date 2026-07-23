-- 006_receipt_metrics — issue #10: capture pipeline metrics per upload for
-- the testing phase. Data stays in the DB / data dir, never in the repo.

CREATE TABLE receipt_metrics (
  id               CHAR(26)     NOT NULL PRIMARY KEY,
  receipt_id       CHAR(26)     NULL,
  group_id         CHAR(26)     NOT NULL,
  upload_bytes     INT          NOT NULL,
  normalized_bytes INT          NULL,
  normalize_ms     INT          NULL,
  engine           VARCHAR(20)  NULL,
  parse_ms         INT          NULL,
  outcome          VARCHAR(20)  NOT NULL, -- parsed | parse_failed | rejected
  confidence       VARCHAR(10)  NULL,
  error            VARCHAR(500) NULL,
  created_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO schema_migrations (version) VALUES (6);
