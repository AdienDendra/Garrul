-- Google and Facebook sign-ins with no profile name used to fall back to the
-- account's email address as the display name, which then rendered on every
-- comment, feed entry and notification that user produced. oauth.ts no longer
-- does that, and a returning user's name is refreshed on their next login —
-- this clears the rows of users who never come back.
--
-- Matches on the shape rather than `name = email` alone: an unverified Google
-- address was published as the name but never stored in `email`. A display
-- name containing "@" and a dot on these two providers is an address in every
-- case the old fallback produced, and never holds a space, so "Jane @ Acme Co."
-- keeps its name; "user" is the same last resort oauth.ts uses.
UPDATE users
   SET name = 'user'
 WHERE provider IN ('google', 'facebook')
   AND (name = email OR (name LIKE '%_@_%._%' AND name NOT LIKE '% %'));
