# Property cover image — design

## Goal
Let a property carry a single cover photo, set optionally at creation and editable/removable anytime, shown
on the property profile page so users can identify a property at a glance without drilling in.

## Decisions (approved)
- **Placement:** header avatar — the photo fills the existing 80px icon slot in the profile header
  (`DetailPageShell.iconSlot`), replacing the generic building icon. Click enlarges to full size.
- **Scope:** a single cover photo (not a gallery).
- **Lifecycle:** optional at creation; add/replace/remove later from the property page. Editable by anyone
  who can edit the property (same surface as `PATCH /properties/:id`).
- **Source:** device upload. (Auto map/satellite from lat/lng is out of scope; can be a later option.)

## Storage
Two nullable keys on `properties` (migration `0186`, looped over every `office_*` schema):
- `image_r2_key` — full-size original in R2.
- `image_thumbnail_r2_key` — small server-generated JPEG (sharp) for the header avatar; null when the
  thumbnail step is skipped, in which case the avatar falls back to the full-size original.

Raw keys never leave the server. On read, `getPropertyDetail` presigns them into short-lived **inline**
URLs (`imageUrl`, `imageThumbnailUrl`); null when R2 is unconfigured (tests/local) so the client shows the
fallback icon.

## Server
Reuses the existing R2 + `sharp` thumbnail pipeline. Logic isolated in
`server/src/modules/properties/property-image-service.ts` (pure helpers + key writers), wired by two routes:
- `POST /api/properties/:id/image` — raw image bytes (`express.raw`, ≤15 MB, `image/*` except SVG). Confirms
  the property exists (no orphan objects), uploads the original, generates+stores the thumbnail, points the
  row at the new keys, then best-effort deletes the superseded objects after commit.
- `DELETE /api/properties/:id/image` — clears the keys and best-effort deletes the objects.

## Client
- `use-properties.ts`: `imageUrl`/`imageThumbnailUrl` on `PropertySurface`; `uploadPropertyImage` (raw POST)
  and `deletePropertyImage`.
- `property-image.tsx`: `PropertyImageAvatar` (thumbnail + click-to-enlarge, or fallback icon) and
  `PropertyPhotoButton` (add / change / remove; self-contained file input + busy/error state).
- Profile page renders the avatar in `iconSlot` and the photo button in the header actions.
- Create dialog gains an optional cover-photo picker; the image is uploaded after the property is created
  (best-effort — a failed upload never blocks creation).

## Tests
- Server unit: mime allowlist, extension resolution, key building, presign/URL mapping.
- Server runtime (PGlite): existence probe; set returns previous keys + updates row; clear nulls keys.
- Client (jsdom): avatar image-vs-fallback + view control; photo button add-vs-menu states.
