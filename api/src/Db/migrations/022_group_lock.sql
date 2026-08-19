-- Locking a trip for settlement, and payments recorded by the person who
-- was paid (#120).
--
-- `locked_at` is a third group state, and it exists because archive cannot
-- serve this purpose: archive is read-only, and `assertWritable` refuses
-- settlements in an archived group. A trip that is being settled needs the
-- opposite pair — expenses frozen so the numbers stop moving, settlements
-- and reminders still flowing until everyone is square. Archiving is what
-- happens afterwards.
--
-- `recorded_by` is who typed it in, which until now was always the payer.
-- A payee recording "he handed me $20" lands confirmed immediately — there
-- is nobody left to confirm it to — and that is only safe if it can still
-- be deleted, which needs this column to tell the two kinds of confirmed
-- settlement apart. Existing rows are backfilled to from_user: every
-- settlement before this migration was recorded by its payer.
ALTER TABLE `groups`
    ADD COLUMN locked_at DATETIME NULL AFTER archived_at;

ALTER TABLE settlements
    ADD COLUMN recorded_by CHAR(26) NULL AFTER method;

UPDATE settlements SET recorded_by = from_user WHERE recorded_by IS NULL;

INSERT INTO schema_migrations (version) VALUES (22);
