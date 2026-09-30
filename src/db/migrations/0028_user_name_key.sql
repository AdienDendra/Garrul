-- Comparison key for signed-in display names, so an anonymous commenter can be
-- refused a name that a signed-in user already posts under.
-- Forward-only. The migration runner records this as applied; never edit
-- once shipped — make a 0029_*.sql instead.
--
-- The key is `nameKey` from src/lib/display-name.ts, written by
-- upsertOauthUser on every login. Anonymous rows never carry one: a ghost's
-- name is not reserved, only a signed-in account's.
ALTER TABLE users ADD COLUMN name_key TEXT;

-- ponytail: SQLite has no NFKC and lower() folds ASCII only, so this backfill
-- approximates nameKey for existing rows (case, spaces and . _ - ' dropped).
-- A non-ASCII or styled name gets its exact key on the account's next login.
UPDATE users
   SET name_key = lower(replace(replace(replace(replace(replace(
         name, ' ', ''), '.', ''), '_', ''), '-', ''), '''', ''))
 WHERE provider != 'anon' AND erased_at IS NULL;

CREATE INDEX idx_users_name_key ON users (name_key) WHERE name_key IS NOT NULL;
