-- 005_receipt_links — several receipts per expense (issue #9 item 4:
-- the itemized bill plus the card slip that carries the tip).

ALTER TABLE receipts
  ADD COLUMN expense_id CHAR(26) NULL AFTER group_id,
  ADD KEY idx_receipts_expense (expense_id),
  ADD CONSTRAINT fk_receipts_expense FOREIGN KEY (expense_id) REFERENCES expenses (id);

UPDATE receipts r JOIN expenses e ON e.receipt_id = r.id SET r.expense_id = e.id;

INSERT INTO schema_migrations (version) VALUES (5);
