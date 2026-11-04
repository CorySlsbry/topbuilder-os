-- 0022: the visual flat-rate pricebook.
--
-- ServiceTitan's most-loved revenue feature; Housecall Pro charges $149/mo
-- for theirs. Ours lives in the base price: items get a photo and a
-- category so the estimate composer reads like a menu, not a spreadsheet.

ALTER TABLE pricebook_items
  ADD COLUMN category text NOT NULL DEFAULT '',
  ADD COLUMN photo_key text,
  ADD COLUMN photo_type text;
