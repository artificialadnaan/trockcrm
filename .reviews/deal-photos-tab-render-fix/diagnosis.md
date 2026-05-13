# Deal Photos Tab Rendering Diagnosis

Date: 2026-05-12
Branch: `fix/deal-photos-tab-render`

## Assumptions

- Production office for the reported project is `office_dallas`.
- The user's `DFW-2-13126-AA` reference is case-insensitive; production stores it as `DFW-2-13126-aa`.
- This pass stays render-layer only. I am not changing CompanyCam import behavior, R2 storage, or schema.

## Production Reproduction

### Reported deal

- Deal: `hidden ridge`
- Deal ID: `540f6342-84b8-4457-9bb7-393f1bdb23c5`
- Project/deal number: `DFW-2-13126-aa`
- Route tested: `https://trockcrm.com/deals/540f6342-84b8-4457-9bb7-393f1bdb23c5?tab=photos`
- Result: reproduced. The Photos tab displays a gray placeholder tile instead of a visible thumbnail.
- On click, the tab requests `/api/files/b7914996-5461-4a5c-ad23-65b973631988/download?preview=1`, then tries to load the returned R2 URL in an `<img>`.
- Browser result: `net::ERR_BLOCKED_BY_ORB` for the signed R2 object.

### Pilot regression check

- Deal: `Instrata Upper Kirby`
- Deal ID: `794f3056-dd5b-45f5-a68f-11d21ade168a`
- Route tested: `https://trockcrm.com/deals/794f3056-dd5b-45f5-a68f-11d21ade168a/photos`
- Result: the PR #285 route still loads 29 photo records and fetches signed R2 preview URLs for CompanyCam JPEG records. This path is intact for actual image files.

## Production Data Shape

### Reported deal file row

The reported deal has exactly one active record returned by the photo query:

| File ID | Display name | Category | MIME type | R2 key | External URL | External thumb |
| --- | --- | --- | --- | --- | --- | --- |
| `b7914996-5461-4a5c-ad23-65b973631988` | `DFW-2-13126-aa Photo 2026-05-11 001 b640357e` | `photo` | `application/pdf` | yes | no | no |

Root data issue: this row is categorized as `photo`, but it is a PDF. The current render path treats all rows returned by `/files/deal/:dealId/photos` as image-previewable photos.

### Pilot deal file rows

The pilot deal has 29 active photo rows. They are CompanyCam JPEGs with:

- `mime_type = image/jpeg`
- `r2_key` populated
- `external_url` and `external_thumbnail_url` populated

The shared helper correctly prefers signed R2 URLs for these records instead of using `img.companycam.com`.

## Code Path

- `client/src/pages/deals/deal-detail-page.tsx` renders `DealPhotosTab` when the Photos tab is active.
- `client/src/pages/deals/deal-photos-tab.tsx` uses `useDealPhotosData`.
- `client/src/components/photos/deal-photo-components.tsx` owns:
  - `useDealPhotosData`
  - `PhotoGridTile`
  - `PhotoViewerModal`
- `client/src/lib/photo-url-resolution.ts` is the shared URL resolver introduced for R2-backed photos.
- `client/src/components/files/deal-file-photos-subview.tsx`, `/files`, `/photos/feed`, and admin photo audit also use the same helper or the same photo data shape.

## Root Cause

The helper only checks whether a record has `r2Key`; it does not check whether the record is actually an image. For any R2-backed record in the photo endpoint, including a PDF categorized as `photo`, it fetches a signed URL and hands it to `<img>`.

For a PDF, Chrome blocks that R2 response in the image context with ORB. That creates the exact visible symptom: gray placeholder / metadata instead of an image preview, with failed R2 preview requests in the network log.

## Fix Plan

1. Extend the shared photo URL helper with media-awareness:
   - `isPhotoImagePreviewable(file)` returns true only for `image/*` MIME types or clear image extensions.
   - signed preview fetches only happen for previewable image records.
   - non-image records return no image URL.
2. Update shared deal photo UI to render a document/file placeholder for non-image records instead of an empty camera tile or a broken `<img>`.
3. Update `PhotoViewerModal` so non-image records do not render signed PDF URLs inside `<img>`; show file metadata and offer Download.
4. Keep the PR #285 lazy-loading pattern: no unconditional signed URL fetch per card; only visible image cards or opened image modal records fetch signed URLs.
5. Add regression tests before implementation for:
   - non-image `photo` rows do not fetch signed image previews.
   - non-image `photo` rows do not render an `<img>` in the modal.
   - image records with R2 keys still fetch signed preview URLs and render.

## Surfaces Audited

| Surface | Code path | Status |
| --- | --- | --- |
| Deal detail Photos tab | `DealPhotosTab` + `PhotoGridTile` | Broken for non-image rows categorized as `photo`; images work after signed URL fetch. |
| Standalone `/deals/:id/photos` route | Same `DealPhotosTab` route alias | Pilot image route intact; shares the same non-image risk. |
| Deal Files tab Photos subview | `DealFilePhotosSubview` | Shares `useDealPhotosData`; likely same non-image risk. |
| `/files` page | `FilesPage` + `useFilePreviewUrl` | Uses helper; image preview fix from PR #292 is present, but helper should also avoid signed image fetches for non-images. |
| `/photos/feed` | `PhotoFeedPage` | Uses helper; should inherit image-only resolution behavior. |
| Admin photo audit | `PhotoAuditPage` | Uses helper; should avoid signed PDF-in-img behavior for non-image audit rows. |
| Public photo viewer | `PublicPhotoViewerPage` | Server returns `imageUrl`; no client-side helper use. Needs no client change in this pass. |

## Risk Notes

- This does not invent thumbnails for PDFs. It prevents bad image loads and gives users a correct file/document affordance.
- If the business expectation is that `DFW-2-13126-aa` should have real image photos, that is a data/import/upload classification issue outside this render-layer fix.
