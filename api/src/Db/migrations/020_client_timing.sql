-- Client-side timing (#111).
--
-- Two testers reported the app as laggy and we had no measurement of either,
-- so the first diagnosis was made by reading code and was wrong. This is the
-- table that makes the next one evidence.
--
-- Nothing identifying about *what* a person did is stored: `name` is a path
-- template with ids stripped (/groups/:id/expenses) or a screen name. There is
-- no third-party analytics anywhere in this app and this does not add one.
CREATE TABLE IF NOT EXISTS client_timing (
    id          CHAR(26)     NOT NULL PRIMARY KEY,
    user_id     CHAR(26)     NULL,
    -- 'api' = one request. 'screen' = opening a screen until its data landed.
    kind        VARCHAR(12)  NOT NULL,
    -- Path template or screen name. Never a raw URL: those carry group ids.
    name        VARCHAR(120) NOT NULL,
    ms          INT UNSIGNED NOT NULL,
    -- HTTP status for kind='api'; 0 when the request never got a response.
    status      SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    platform    VARCHAR(16)  NOT NULL DEFAULT '',
    app_version VARCHAR(24)  NOT NULL DEFAULT '',
    created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_client_timing_user
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE SET NULL,
    -- The dashboard reads "recent rows for this name", and the sweep deletes
    -- by age; both are served by this.
    INDEX idx_client_timing_name_time (name, created_at),
    INDEX idx_client_timing_time (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO schema_migrations (version) VALUES (20);
