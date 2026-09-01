-- A waiting line for receipt scans (#123, requirement 2: queuing with
-- feedback to the user).
--
-- The vision model serialises: one receipt at a time per backend. Until now
-- a second scan arriving during a first was simply refused (SCAN_BUSY, 429)
-- and told to try again "in a few seconds" — which is a queue with no order
-- and no feedback. This table gives each waiting receipt a ticket, so the API
-- can say "you are second in line, about 40 s" and hand out turns oldest
-- first when a backend frees up.
--
-- Rows are short-lived. A client holding a ticket asks again every few
-- seconds; one that has not asked in `last_seen_at` + 45 s has gone away
-- (cancelled, closed the sheet, lost signal) and is purged so it cannot
-- block the people behind it. Nothing here survives a parse: the ticket is
-- deleted the moment its receipt is admitted.
CREATE TABLE scan_queue (
  ticket       CHAR(26)    NOT NULL PRIMARY KEY,
  receipt_id   CHAR(26)    NOT NULL,
  user_id      CHAR(26)    NOT NULL,
  created_at   DATETIME(3) NOT NULL,
  last_seen_at DATETIME(3) NOT NULL,
  KEY scan_queue_created (created_at),
  KEY scan_queue_receipt (receipt_id)
);

INSERT INTO schema_migrations (version) VALUES (23);
