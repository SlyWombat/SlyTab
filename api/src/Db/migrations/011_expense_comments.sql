-- 011_expense_comments — issue #15: discussion on an expense.

CREATE TABLE expense_comments (
  id         CHAR(26)     NOT NULL PRIMARY KEY,
  expense_id CHAR(26)     NOT NULL,
  user_id    CHAR(26)     NOT NULL,
  body       VARCHAR(1000) NOT NULL,
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_comments_expense (expense_id),
  CONSTRAINT fk_comments_expense FOREIGN KEY (expense_id) REFERENCES expenses (id),
  CONSTRAINT fk_comments_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO schema_migrations (version) VALUES (11);
