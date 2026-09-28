-- Pinned comments: one top-level comment per post shown above the sort.
-- Forward-only. Never edit once shipped — make a 0026_*.sql instead.
--
-- pinned_at is NULL for every unpinned row (epoch ms when pinned), so the
-- partial UNIQUE index below costs nothing for the ~all rows that are NULL and
-- is how the DB — not app code — enforces one pin per post. The app swaps a
-- pin by clearing the old row first, in the same D1 batch; set-then-clear
-- would trip this index.
--
-- Only top-level approved comments are pinnable (checked in the admin action
-- and again in the UPDATE's WHERE). Hiding a comment leaves pinned_at alone:
-- reads serve the pin only while the row is approved, so a re-approve brings
-- it back and a new pin on the post clears the dormant one.

ALTER TABLE comments ADD COLUMN pinned_at INTEGER;

CREATE UNIQUE INDEX comments_pinned_idx ON comments(post_slug)
	WHERE pinned_at IS NOT NULL;
