# CompanyCam Photo Rendering Diagnosis

## Finding

CompanyCam pilot photos were imported successfully into R2, but the CRM rendered broken images in production because UI image sources resolved to CompanyCam CDN URLs (`https://img.companycam.com/...`). Production CSP allows R2 image origins and `data:`, not CompanyCam.

## Storage

`scripts/companycam-import.ts` stores the imported image bytes in R2 under `files.r2_key`. It also preserves the source CompanyCam URLs in `files.external_url` and `files.external_thumbnail_url` for audit/reference value.

Assumption: the importer is correct and should not be changed. The CompanyCam URL should remain stored, but should not be used as an `<img src>` when an R2 key exists.

## Rendering Surface

- Deal photos: `client/src/components/photos/deal-photo-components.tsx`
- Global photo feed and project photo strips: `client/src/pages/photos/photo-feed-page.tsx`
- Photo lightbox: `client/src/components/photos/photo-lightbox.tsx`
- Shared download URL endpoint: `server/src/modules/files/routes.ts`

The client preferred `external_thumbnail_url` / `external_url` before fetching `/api/files/:id/download`. The download endpoint also returned `external_url` before generating an R2 signed URL. Together, this made R2-backed CompanyCam photos render through the CSP-blocked CompanyCam CDN.

## Decision

Use Approach A: prefer R2 signed URLs whenever `r2_key` is present. Fall back to external URLs only for records without an R2 key.

Rationale:

- Imported photos are already stored and verified in R2.
- Existing R2 signed URLs are compatible with production CSP.
- This avoids loosening CSP and removes the runtime dependency on CompanyCam image delivery.
- CompanyCam source URLs remain available as metadata/audit trail.

## Bundled PR #282 Findings

- P1: `PhotoGridCard` eagerly fetched both thumbnail and open/download URLs. The fix should keep thumbnail fetching on render and fetch open/download URLs only when the user opens a non-image file.
- P2: project recent-photo fallback fabricated all-null photo records. The current API returns `recentPhotos`, but if an older/degraded payload only has `recentPhotoIds`, the fallback should still treat those IDs as photo records so thumbnails can fetch and render.
