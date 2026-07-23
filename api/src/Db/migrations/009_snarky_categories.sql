-- 009_snarky_categories — five categories with attitude (owner request).
-- Slugs are stable identifiers; display labels live in the clients.
-- drinks ("Liquid assets"), dining ("Overpriced calories"),
-- travel ("Getting there"), adulting ("Adulting"),
-- other ("Questionable choices").

ALTER TABLE expenses MODIFY category
  ENUM('food','home','travel','fun','utilities','other','drinks','dining','adulting')
  NOT NULL DEFAULT 'other';

UPDATE expenses SET category = 'dining' WHERE category = 'food';
UPDATE expenses SET category = 'adulting' WHERE category IN ('home', 'utilities');
UPDATE expenses SET category = 'other' WHERE category = 'fun';

ALTER TABLE expenses MODIFY category
  ENUM('drinks','dining','travel','adulting','other')
  NOT NULL DEFAULT 'other';

INSERT INTO schema_migrations (version) VALUES (9);
