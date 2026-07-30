-- 017_email_notifications — activity alerts by email (issue #77).
--
-- Push reaches only devices that registered a token, and the push recipient
-- query inner-joins push_tokens: a member who never installed the app was
-- invisible to it and heard nothing, by any channel. Email closes that,
-- reusing users.notify_level rather than adding a second preference.
--
-- The queue exists for batching. A dinner where someone enters six expenses
-- must produce one digest, not six mails, so the chatty kinds land here and
-- a cron sweeps them per recipient. Important kinds (settlements, joins) are
-- sent immediately and written here already-sent, so the table stays the one
-- record of what we mailed.

CREATE TABLE IF NOT EXISTS notification_emails (
    id CHAR(26) NOT NULL PRIMARY KEY,
    user_id CHAR(26) NOT NULL,
    group_id CHAR(26) NOT NULL,
    kind VARCHAR(40) NOT NULL,
    title VARCHAR(200) NOT NULL,
    body VARCHAR(500) NOT NULL,
    -- Copied, not joined: what we said must stay readable even if the
    -- expense is edited or the group renamed afterwards.
    group_name VARCHAR(120) NOT NULL DEFAULT '',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    sent_at DATETIME NULL,
    CONSTRAINT fk_notification_emails_user
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
    -- The digest sweep reads exactly this: unsent, oldest first.
    INDEX idx_notification_emails_pending (sent_at, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO schema_migrations (version) VALUES (17);
