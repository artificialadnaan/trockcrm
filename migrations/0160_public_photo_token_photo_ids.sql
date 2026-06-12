-- Token-subset support for public photo share links.
--
-- A public photo token can now be scoped to a specific set of photos. NULL photo_ids
-- preserves the original whole-deal behavior (every active photo on the deal); a non-NULL
-- array restricts the viewer/asset/download to exactly those photo ids. The viewer and the
-- per-photo asset/download paths both enforce the subset, so an out-of-scope photo id is 404'd
-- even if guessed.
ALTER TABLE public.public_photo_tokens
  ADD COLUMN IF NOT EXISTS photo_ids uuid[];
