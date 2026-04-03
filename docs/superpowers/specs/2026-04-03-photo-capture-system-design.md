# Photo Capture System — Design Spec

**Date:** 2026-04-03
**Goal:** Replace CompanyCam with a native photo capture and feed system built into T Rock CRM.

## Overview

Two new authenticated pages:
1. **`/photos/capture`** — Mobile-optimized camera capture with GPS auto-detect
2. **`/photos/feed`** — Cross-project photo feed with filters and lightbox

No new tables. All photos stored in existing `files` table via R2 upload flow. GPS auto-detect uses new `propertyLat`/`propertyLng` columns on `deals`.

## Two-Tier UX

- **Supers/Admins/Directors:** Full app access + capture page, see all active deals
- **Reps (field crews):** Log in to the app, see simplified capture page with only their assigned deals

Both tiers use the same page, filtered by existing RBAC rules.

---

## 1. Capture Page (`/photos/capture`)

### Route
`/photos/capture` — standalone full-screen layout (no sidebar/topbar)

**Routing note:** This route must live OUTSIDE the `<AppShell />` wrapper in `App.tsx` but still inside `<AuthGate>`. Add a sibling `<Route>` block for chromeless authenticated pages.

### Flow
1. Page loads, grabs GPS via `navigator.geolocation.getCurrentPosition`
2. Project selector: deals sorted by GPS distance (nearest first), showing distance label (e.g., "0.2 mi")
3. Auto-selects deal if within 200m
4. Camera trigger: `<input type="file" accept="image/*" capture="environment">`
5. Photo preview with optional one-line note field
6. Upload button: presigned URL flow to R2, progress indicator
7. Success toast, resets for next photo (stays on same project)

### Layout (Mobile-First)
- Full-screen, no app chrome
- Bottom bar: Camera | Recent (last 5 this session) | Back to App
- PWA-friendly (add to home screen)

### Subcategory Quick-Tags (One-Tap)
- Progress, Site Visit, Damage, Safety, Delivery, Other
- Maps to `files.subcategory`
- Optional — defaults to no subcategory if skipped

### RBAC
- `rep` role: only assigned deals appear in picker
- `director`/`admin`: all active deals

---

## 2. Photo Feed (`/photos/feed`)

### Layout
Masonry-style responsive thumbnail grid:
- 2 columns mobile, 3-4 tablet, 5-6 desktop
- Lazy-loaded thumbnails

### Filters (Sticky Top Bar)
- Project dropdown (all by default)
- Date range: Today, This Week, This Month, Custom
- Uploader (person who took the photo)
- Subcategory tag

### Photo Cards
- Thumbnail image (lazy-loaded)
- Project name + deal number
- Time ago (e.g., "2h ago")
- Uploader name
- Subcategory pill badge

### Thumbnails Strategy
- On upload, the EXIF worker generates a 400px-wide thumbnail variant and stores it at `{r2Key}_thumb.jpg`
- Photo cards load the thumbnail URL, NOT the full-res presigned URL
- For CompanyCam imports, use `externalThumbnailUrl` (already stored)
- This prevents loading 30-50 full-res construction photos in a grid on mobile

### Lightbox (Click to Expand) — v1 Read-Only
- Full-res image from R2 (loaded on demand, not in grid)
- Map pin if geo data exists (static image, no embedded map)
- Metadata: date, uploader, project, subcategory
- Download button
- Prev/next navigation within filtered set
- **v2 follow-up:** Editable notes field, tag editor

### Real-Time Updates
- Lightweight poll endpoint: `GET /api/files/photos/feed/count?since={timestamp}` returns only the count of new photos
- Poll every 30s, show "X new photos" badge at top
- Click badge to prepend new photos (re-fetches first page only)

---

## 3. GPS Auto-Detect

### Schema Changes
New columns on `deals` table:
- `property_lat NUMERIC(10,7)` — geocoded latitude
- `property_lng NUMERIC(10,7)` — geocoded longitude

### Geocoding Strategy
- **Provider:** US Census Bureau Geocoder (free, US-only, no API key)
- **Endpoint:** `https://geocoding.geo.census.gov/geocoder/locations/onelineaddress`
- **When:** On deal create/update when address fields change
- **Backfill:** One-time script using batch CSV endpoint (up to 10k addresses), rate-limited 1 req/sec
- **Resilience:**
  - 10-second timeout on geocoding HTTP call
  - Retry with exponential backoff (max 2 retries)
  - Graceful degradation: if geocoding fails, store NULL for lat/lng and log it. Capture page still works, just no distance sorting.
  - Cache aggressively — address changes are rare
- **Fallback path:** If Census proves unreliable, swap to Nominatim (free) or Google Geocoding API (paid)

### Nearby Endpoint
`GET /api/deals/nearby?lat=X&lng=Y`
- Returns active deals sorted by haversine distance
- Includes `id`, `dealNumber`, `name`, `distance` (miles)
- RBAC-filtered (reps see only assigned deals)
- No PostGIS — haversine math in SQL

### Auto-Select Logic (Client)
- If nearest deal is within 200m, auto-select it
- Highlight nearest 3 deals in the picker regardless
- User can always override

---

## 4. Backend Changes

### New Endpoint: Photo Feed
`GET /api/files/photos/feed`
- Paginated, sorted by `takenAt` desc
- Filters: `dealId`, `uploadedBy`, `subcategory`, `dateFrom`, `dateTo`
- Returns photos across all deals user has access to
- Reuses existing `files` table query patterns

### New Endpoint: Nearby Deals
`GET /api/deals/nearby?lat=X&lng=Y`
- Haversine distance calculation in SQL
- Returns top 20 nearest deals with distance
- RBAC: reps filtered to assigned deals

### Deal Geocoding
- New function in deals service: `geocodeDealAddress()`
- Called on deal create/update when address changes
- Uses Census Bureau geocoder (free, no API key)
- Stores result in `propertyLat`/`propertyLng`
- Backfill script for existing deals

### Migration
- `0008_photo_capture.sql` (multi-tenant loop pattern like 0007):
  - Adds `property_lat`, `property_lng` to deals
  - Adds index: `files_photo_feed_idx ON files(uploaded_by, category, COALESCE(taken_at, created_at) DESC) WHERE category = 'photo' AND is_active = TRUE`

### Nearby Endpoint Guards
- Filter out deals with NULL lat/lng BEFORE computing haversine distance (avoids NaN)
- Limit to top 20 nearest deals

---

## 5. What We Are NOT Building

- Offline mode / service worker queue
- Photo annotations / drawing tools
- Video capture
- QR code access links
- Push notifications for new photos
- Geofencing (auto-trigger camera)

All can be added later if needed.

---

## Technical Notes

- Photos go through existing presigned URL upload flow (no new upload infrastructure)
- EXIF extraction worker already handles metadata after upload
- Thumbnails: R2 presigned URLs for native uploads, `externalThumbnailUrl` for CompanyCam imports
- File records created via existing `confirmUpload` flow
- No new dependencies needed
