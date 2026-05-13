# UI Polish Batch Diagnosis

Assumptions:
- Work is scoped to `/Users/adnaaniqbal/projects/trockcrm` on branch `fix/ui-polish-batch-files-preview-and-cosmetic`, created from `origin/main` at `6c9e2036`.
- This batch is display-layer only except the `/files` preview behavior, which calls the existing signed file preview endpoint.
- Rep access to `/files` is currently restricted by the page (`filesEnabled = user?.role !== "rep"`). This prompt does not ask to change RBAC, so the preview fix is implemented for users who can load file records.

## BUG-1 Files Page Photo Previews

Root cause:
- `client/src/pages/files/files-page.tsx` treats image/photo files specially, but `FileGridCard` renders a hardcoded gray camera placeholder instead of resolving a thumbnail URL.
- PR #285 established the safe rendering pattern elsewhere: use file metadata (`r2Key`, `externalUrl`, `externalThumbnailUrl`) to pick an immediate URL when possible, fetch `/api/files/:id/download?preview=1` for R2-backed records, and do not fetch full open/download URLs until the user clicks.
- `server/src/modules/files/routes.ts` already supports `GET /api/files/:id/download?preview=1`; R2-backed CompanyCam files are intentionally served through R2 even when external source URLs exist.
- `client/src/hooks/use-files.ts` did not expose `externalUrl` / `externalThumbnailUrl`, even though `shared/src/schema/tenant/files.ts` and the API service include those fields.

Fix plan:
- Extend the file record type to include external photo URLs.
- Add a Files-page preview cache and viewport-triggered signed preview fetch for image media only.
- Keep non-images as icons, with PDF/document/video/file-specific icons.
- Preserve current download behavior; no unconditional full-open URL fetches.

## COSMETIC-1 Enum Display

Root cause:
- `client/src/components/leads/questionnaire-display.ts` returns raw strings for question answers, so values like `senior_living` and `false` can leak into display cards.
- Select options already carry labels in forms, so submit payloads can remain raw.

Fix plan:
- Add a shared display formatter for enum-like strings and booleans.
- Use it in questionnaire answer display.

## COSMETIC-2 System IDs

Current state:
- Lead detail already uses `System references` with non-UUID values (`Tracked internally`, `Linked internally`, etc.).
- Deal detail already displays project/deal-facing identifiers in its System IDs section and does not expose HubSpot/raw deal IDs in tests.

Fix plan:
- Keep support identifiers visible but client-facing.
- Rename the deal system section to `System references` and the primary row to `Deal reference`.

## COSMETIC-3 Property Selector Overflow

Root cause:
- `client/src/components/properties/property-selector.tsx` renders the selected label inside a full-width button without `min-w-0` / `truncate` handling.

Fix plan:
- Add truncation to the selected label and option rows while preserving the full label in `title`.

## COSMETIC-4 Timeline Duplicate Labels

Root cause:
- `timeline_status` is a date field but labeled `Timeline Status`.
- A separate validation/project question uses a free-text timeline label, making the form read like duplicate timeline fields.

Fix plan:
- Rename `timeline_status` display label to `Timeline Target Date`.
- Rename the free-text timeline question/editor label to `Timeline Notes`.
- Preserve stored keys and payload shapes.

## COSMETIC-5 Scope Compression

Current state:
- `LeadQuestionnaireSections` renders scope groups as accordions and hides children until the applies question is answered true.
- Tests already assert ten scope accordions with hidden children until applies is selected.

Fix plan:
- No behavioral rewrite before go-live.
- Add an inline comment documenting that the applies prompt is intentionally inside each collapsed group rather than a separate up-front gate.

## COSMETIC-6 Linked Entity Labels

Current state:
- Searches show prior placeholder fallbacks are gone from non-test code except `Linked property`, which is a rail label, not a missing-name fallback.

Fix plan:
- Rename the rail label to `Property` to remove ambiguity.

## COSMETIC-7 DD Toggle Label

Root cause:
- `/pipeline` toggle label is `Show DD`, which is terse.

Fix plan:
- Rename it to `Show DD stages`.
- Add a title/aria label explaining that the switch includes due diligence stages.
