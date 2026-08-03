-- Profile photos (#112).
--
-- A separate column from `avatar`, which is a 16-character string that has
-- been empty for every user since the table was created. Overloading it to
-- hold a path would give a "did someone set a photo?" check two different
-- answers depending on which code asked.
--
-- Path, not a blob: receipt images already live on disk under DATA_DIR and
-- there is no reason for photos to be the exception. NULL means no photo,
-- which is the case for everyone until they choose otherwise — the initials
-- badge is not a fallback for a failure, it is the normal state.
ALTER TABLE users
    ADD COLUMN avatar_path VARCHAR(200) NULL AFTER avatar;

INSERT INTO schema_migrations (version) VALUES (21);
