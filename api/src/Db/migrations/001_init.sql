-- 001_init — SlyTab schema v1 (docs/architecture.md §4).
-- MySQL 8 / MariaDB 10.6+. All money columns are BIGINT minor units in the
-- row's own currency; converted values are derived via fx_rate, never stored.

CREATE TABLE users (
  id            CHAR(26)      NOT NULL PRIMARY KEY, -- ULID
  email         VARCHAR(255)  NOT NULL UNIQUE,
  password_hash VARCHAR(255)  NOT NULL,
  display_name  VARCHAR(80)   NOT NULL,
  avatar        VARCHAR(16)   NOT NULL DEFAULT '',
  default_currency CHAR(3)    NOT NULL DEFAULT 'CAD',
  payment_handles JSON        NOT NULL DEFAULT ('{}'),
  created_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at    DATETIME      NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE sessions (
  id           CHAR(26)     NOT NULL PRIMARY KEY,
  user_id      CHAR(26)     NOT NULL,
  token_hash   CHAR(64)     NOT NULL UNIQUE, -- sha256 of the opaque token
  device_label VARCHAR(120) NOT NULL DEFAULT '',
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at   DATETIME     NOT NULL,
  revoked_at   DATETIME     NULL,
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `groups` (
  id            CHAR(26)    NOT NULL PRIMARY KEY,
  name          VARCHAR(80) NOT NULL,
  emoji         VARCHAR(16) NOT NULL DEFAULT '',
  home_currency CHAR(3)     NOT NULL,
  is_direct     TINYINT(1)  NOT NULL DEFAULT 0, -- friend pair (FR-2.2)
  created_by    CHAR(26)    NOT NULL,
  created_at    DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  archived_at   DATETIME    NULL,
  CONSTRAINT fk_groups_creator FOREIGN KEY (created_by) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE memberships (
  group_id  CHAR(26) NOT NULL,
  user_id   CHAR(26) NOT NULL,
  joined_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  left_at   DATETIME NULL,
  PRIMARY KEY (group_id, user_id),
  CONSTRAINT fk_memb_group FOREIGN KEY (group_id) REFERENCES `groups` (id),
  CONSTRAINT fk_memb_user  FOREIGN KEY (user_id)  REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE invites (
  id         CHAR(26)  NOT NULL PRIMARY KEY,
  group_id   CHAR(26)  NOT NULL,
  token_hash CHAR(64)  NOT NULL UNIQUE,
  created_by CHAR(26)  NOT NULL,
  expires_at DATETIME  NOT NULL,
  used_by    CHAR(26)  NULL,
  CONSTRAINT fk_inv_group FOREIGN KEY (group_id) REFERENCES `groups` (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE receipts (
  id         CHAR(26)     NOT NULL PRIMARY KEY,
  group_id   CHAR(26)     NOT NULL,
  image_path VARCHAR(255) NOT NULL,
  parsed     JSON         NULL, -- merchant, items[], subtotal/tax/tip/total
  created_by CHAR(26)     NOT NULL,
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_rcpt_group FOREIGN KEY (group_id) REFERENCES `groups` (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE expenses (
  id             CHAR(26)      NOT NULL PRIMARY KEY,
  group_id       CHAR(26)      NOT NULL,
  description    VARCHAR(200)  NOT NULL,
  amount         BIGINT        NOT NULL, -- minor units of `currency`
  currency       CHAR(3)       NOT NULL,
  fx_rate        DECIMAL(18,8) NULL,     -- to group home currency; NULL = same
  fx_rate_source ENUM('ecb','manual') NULL,
  expense_date   DATE          NOT NULL,
  category       ENUM('food','home','travel','fun','utilities','other') NOT NULL,
  notes          TEXT          NULL,
  receipt_id     CHAR(26)      NULL,
  created_by     CHAR(26)      NOT NULL,
  created_at     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at     DATETIME      NULL, -- soft delete, 30-day restore (FR-3.5)
  INDEX idx_exp_group_date (group_id, expense_date),
  CONSTRAINT fk_exp_group   FOREIGN KEY (group_id)   REFERENCES `groups` (id),
  CONSTRAINT fk_exp_receipt FOREIGN KEY (receipt_id) REFERENCES receipts (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Invariant (enforced in Domain + service layer): SUM(amount) per expense
-- over expense_payers == expenses.amount, likewise expense_shares.
CREATE TABLE expense_payers (
  expense_id CHAR(26) NOT NULL,
  user_id    CHAR(26) NOT NULL,
  amount     BIGINT   NOT NULL,
  PRIMARY KEY (expense_id, user_id),
  CONSTRAINT fk_pay_exp  FOREIGN KEY (expense_id) REFERENCES expenses (id) ON DELETE CASCADE,
  CONSTRAINT fk_pay_user FOREIGN KEY (user_id)    REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE expense_shares (
  expense_id   CHAR(26) NOT NULL,
  user_id      CHAR(26) NOT NULL,
  amount       BIGINT   NOT NULL,
  split_method ENUM('equal','exact','shares','percent','adjustment') NOT NULL,
  split_input  JSON     NULL, -- shares/pct/adjustment exactly as entered
  PRIMARY KEY (expense_id, user_id),
  CONSTRAINT fk_shr_exp  FOREIGN KEY (expense_id) REFERENCES expenses (id) ON DELETE CASCADE,
  CONSTRAINT fk_shr_user FOREIGN KEY (user_id)    REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE settlements (
  id           CHAR(26)      NOT NULL PRIMARY KEY,
  group_id     CHAR(26)      NOT NULL,
  from_user    CHAR(26)      NOT NULL,
  to_user      CHAR(26)      NOT NULL,
  amount       BIGINT        NOT NULL,
  currency     CHAR(3)       NOT NULL,
  fx_rate      DECIMAL(18,8) NULL,
  method       ENUM('interac','paypal','venmo','cash','other') NOT NULL,
  note         VARCHAR(500)  NULL,
  status       ENUM('pending','confirmed') NOT NULL DEFAULT 'pending',
  created_at   DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  confirmed_at DATETIME      NULL,
  INDEX idx_set_group (group_id),
  CONSTRAINT fk_set_group FOREIGN KEY (group_id)  REFERENCES `groups` (id),
  CONSTRAINT fk_set_from  FOREIGN KEY (from_user) REFERENCES users (id),
  CONSTRAINT fk_set_to    FOREIGN KEY (to_user)   REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE fx_rates (
  rate_date DATE          NOT NULL,
  base      CHAR(3)       NOT NULL,
  quote     CHAR(3)       NOT NULL,
  rate      DECIMAL(18,8) NOT NULL,
  PRIMARY KEY (rate_date, base, quote)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE activity (
  id          CHAR(26)    NOT NULL PRIMARY KEY,
  group_id    CHAR(26)    NOT NULL,
  user_id     CHAR(26)    NOT NULL,
  verb        VARCHAR(32) NOT NULL, -- added, edited, deleted, joined, settled…
  entity_type VARCHAR(32) NOT NULL,
  entity_id   CHAR(26)    NOT NULL,
  diff        JSON        NULL,
  created_at  DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_act_group_time (group_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE schema_migrations (
  version    INT      NOT NULL PRIMARY KEY,
  applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO schema_migrations (version) VALUES (1);
