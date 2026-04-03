# Photo Capture System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace CompanyCam with a native photo capture and feed system — mobile camera page with GPS auto-detect + cross-project photo feed with filters and lightbox.

**Architecture:** Two new pages (capture + feed), two new API endpoints (nearby deals + photo feed), geocoding service for deal addresses, and a migration adding lat/lng to deals + photo feed index. All photos use existing R2 upload flow and files table.

**Tech Stack:** React + TypeScript, Express, Drizzle ORM, Cloudflare R2, Census Bureau Geocoder, Haversine SQL

---

## File Map

### New Files
- `migrations/0008_photo_capture.sql` — adds propertyLat/Lng to deals, photo feed index
- `shared/src/schema/tenant/deals.ts` — add propertyLat/propertyLng columns (modify)
- `server/src/modules/deals/geocode.ts` — Census geocoder client + deal geocoding
- `server/src/modules/files/feed-service.ts` — photo feed query + count endpoint logic
- `client/src/pages/photos/photo-capture-page.tsx` — full-screen camera capture
- `client/src/pages/photos/photo-feed-page.tsx` — masonry photo grid + filters
- `client/src/components/photos/photo-lightbox.tsx` — full-res lightbox with metadata
- `client/src/hooks/use-photo-feed.ts` — feed data fetching + polling
- `client/src/hooks/use-nearby-deals.ts` — GPS + nearby deals hook

### Modified Files
- `client/src/App.tsx` — add routes (capture outside AppShell, feed inside)
- `server/src/modules/deals/routes.ts` — add `GET /nearby` endpoint
- `server/src/modules/deals/service.ts` — add geocoding on create/update
- `server/src/modules/files/routes.ts` — add feed + count endpoints
- `server/src/app.ts` — no changes needed (deals/files routes already registered)

---

### Task 1: Migration + Schema

**Files:**
- Create: `migrations/0008_photo_capture.sql`
- Modify: `shared/src/schema/tenant/deals.ts`

- [ ] **Step 1: Create migration file**

```sql
-- migrations/0008_photo_capture.sql
-- Adds GPS columns to deals and photo feed index across all tenant schemas.

DO $$
DECLARE
  tenant_schema TEXT;
BEGIN
  FOR tenant_schema IN
    SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'office_%'
  LOOP
    -- GPS coordinates for deal property address
    EXECUTE format('ALTER TABLE %I.deals ADD COLUMN IF NOT EXISTS property_lat NUMERIC(10,7)', tenant_schema);
    EXECUTE format('ALTER TABLE %I.deals ADD COLUMN IF NOT EXISTS property_lng NUMERIC(10,7)', tenant_schema);

    -- Index for photo feed queries (cross-deal, sorted by date)
    EXECUTE format('CREATE INDEX IF NOT EXISTS files_photo_feed_idx ON %I.files (uploaded_by, category, COALESCE(taken_at, created_at) DESC) WHERE category = ''photo'' AND is_active = TRUE', tenant_schema);

    RAISE NOTICE 'Applied photo capture migration to schema: %', tenant_schema;
  END LOOP;
END $$;
```

- [ ] **Step 2: Update Drizzle schema**

Add to `shared/src/schema/tenant/deals.ts` after the `companycamProjectId` line:

```typescript
propertyLat: numeric("property_lat", { precision: 10, scale: 7 }),
propertyLng: numeric("property_lng", { precision: 10, scale: 7 }),
```

- [ ] **Step 3: Rebuild shared package**

Run: `cd shared && npm run build`
Expected: Clean compile, no errors.

- [ ] **Step 4: Verify server types**

Run: `npx tsc --noEmit --project server/tsconfig.json`
Expected: No errors.

- [ ] **Step 5: Commit**

```
git add migrations/0008_photo_capture.sql shared/src/schema/tenant/deals.ts shared/dist/
git commit -m "feat: migration 0008 adds GPS columns to deals + photo feed index"
```

---

### Task 2: Geocoding Service

**Files:**
- Create: `server/src/modules/deals/geocode.ts`
- Modify: `server/src/modules/deals/service.ts`

- [ ] **Step 1: Create geocode.ts**

```typescript
// server/src/modules/deals/geocode.ts
/**
 * Census Bureau Geocoder client.
 * Geocodes US street addresses to lat/lng coordinates.
 * Free, no API key required.
 */

const CENSUS_URL = "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress";

interface GeocodeResult {
  lat: number;
  lng: number;
}

/**
 * Geocode a street address using the US Census Bureau geocoder.
 * Returns null if geocoding fails (graceful degradation).
 */
export async function geocodeAddress(
  address: string,
  city: string,
  state: string,
  zip?: string | null
): Promise<GeocodeResult | null> {
  const fullAddress = [address, city, state, zip].filter(Boolean).join(", ");
  if (!fullAddress.trim()) return null;

  const params = new URLSearchParams({
    address: fullAddress,
    benchmark: "Public_AR_Current",
    format: "json",
  });

  let lastError: Error | null = null;

  // Retry with exponential backoff (max 2 retries)
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${CENSUS_URL}?${params}`, {
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) {
        lastError = new Error(`Census API HTTP ${res.status}`);
        continue;
      }

      const data = await res.json() as {
        result?: {
          addressMatches?: Array<{
            coordinates: { x: number; y: number };
          }>;
        };
      };

      const match = data.result?.addressMatches?.[0];
      if (!match) return null; // No match found — not an error

      return {
        lat: match.coordinates.y,
        lng: match.coordinates.x,
      };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      // Exponential backoff: 500ms, 1000ms
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      }
    }
  }

  console.error(`[Geocode] Failed after 3 attempts for "${fullAddress}":`, lastError?.message);
  return null;
}
```

- [ ] **Step 2: Add geocoding to deal create/update in service.ts**

In `server/src/modules/deals/service.ts`, add import at the top:

```typescript
import { geocodeAddress } from "./geocode.js";
```

In the `createDeal` function, after the deal is inserted and before returning, add:

```typescript
// Geocode the property address in the background (non-blocking)
if (input.propertyAddress && input.propertyCity && input.propertyState) {
  geocodeAddress(input.propertyAddress, input.propertyCity, input.propertyState, input.propertyZip)
    .then(async (result) => {
      if (result) {
        await tenantDb
          .update(deals)
          .set({ propertyLat: String(result.lat), propertyLng: String(result.lng) })
          .where(eq(deals.id, newDeal.id));
      }
    })
    .catch((err) => console.error("[Geocode] Background geocode failed:", err));
}
```

Add same pattern in `updateDeal` when address fields change:

```typescript
// Re-geocode if address changed
const addressChanged =
  input.propertyAddress !== undefined ||
  input.propertyCity !== undefined ||
  input.propertyState !== undefined;

if (addressChanged) {
  const addr = input.propertyAddress ?? existing.propertyAddress;
  const city = input.propertyCity ?? existing.propertyCity;
  const state = input.propertyState ?? existing.propertyState;
  const zip = input.propertyZip ?? existing.propertyZip;

  if (addr && city && state) {
    geocodeAddress(addr, city, state, zip)
      .then(async (result) => {
        if (result) {
          await tenantDb
            .update(deals)
            .set({ propertyLat: String(result.lat), propertyLng: String(result.lng) })
            .where(eq(deals.id, dealId));
        }
      })
      .catch((err) => console.error("[Geocode] Background geocode failed:", err));
  }
}
```

- [ ] **Step 3: Verify types compile**

Run: `npx tsc --noEmit --project server/tsconfig.json`
Expected: No errors.

- [ ] **Step 4: Commit**

```
git add server/src/modules/deals/geocode.ts server/src/modules/deals/service.ts
git commit -m "feat: add Census Bureau geocoder for deal property addresses"
```

---

### Task 3: Nearby Deals Endpoint

**Files:**
- Modify: `server/src/modules/deals/routes.ts`

- [ ] **Step 1: Add nearby endpoint**

Add before the `export` statement in `server/src/modules/deals/routes.ts`:

```typescript
// GET /api/deals/nearby?lat=X&lng=Y — Find nearest deals by GPS coordinates
router.get("/nearby", async (req, res, next) => {
  try {
    const lat = parseFloat(req.query.lat as string);
    const lng = parseFloat(req.query.lng as string);

    if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      throw new AppError(400, "Valid lat and lng query parameters are required.");
    }

    const isRep = req.user!.role === "rep";
    const userId = req.user!.id;

    // Haversine distance in miles, filtering out NULL coordinates
    const haversine = sql`
      3959 * acos(
        cos(radians(${lat})) * cos(radians(CAST(${deals.propertyLat} AS FLOAT)))
        * cos(radians(CAST(${deals.propertyLng} AS FLOAT)) - radians(${lng}))
        + sin(radians(${lat})) * sin(radians(CAST(${deals.propertyLat} AS FLOAT)))
      )
    `;

    const conditions = [
      eq(deals.isActive, true),
      isNotNull(deals.propertyLat),
      isNotNull(deals.propertyLng),
    ];

    if (isRep) {
      conditions.push(eq(deals.assignedRepId, userId));
    }

    const nearbyDeals = await req.tenantDb!
      .select({
        id: deals.id,
        dealNumber: deals.dealNumber,
        name: deals.name,
        propertyCity: deals.propertyCity,
        distance: haversine.as("distance"),
      })
      .from(deals)
      .where(and(...conditions))
      .orderBy(haversine)
      .limit(20);

    await req.commitTransaction!();
    res.json({ deals: nearbyDeals });
  } catch (err) {
    next(err);
  }
});
```

Add necessary imports at top of file if not present:

```typescript
import { isNotNull } from "drizzle-orm";
```

- [ ] **Step 2: Verify types compile**

Run: `npx tsc --noEmit --project server/tsconfig.json`
Expected: No errors.

- [ ] **Step 3: Commit**

```
git add server/src/modules/deals/routes.ts
git commit -m "feat: add GET /deals/nearby endpoint with haversine distance"
```

---

### Task 4: Photo Feed Backend

**Files:**
- Create: `server/src/modules/files/feed-service.ts`
- Modify: `server/src/modules/files/routes.ts`

- [ ] **Step 1: Create feed-service.ts**

```typescript
// server/src/modules/files/feed-service.ts
import { eq, and, desc, gte, sql, isNotNull } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { files, deals } from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";

type TenantDb = NodePgDatabase<typeof schema>;

export interface PhotoFeedFilters {
  dealId?: string;
  uploadedBy?: string;
  subcategory?: string;
  dateFrom?: string; // ISO date string
  dateTo?: string;
  page?: number;
  limit?: number;
}

/**
 * Get a paginated photo feed across all deals the user has access to.
 */
export async function getPhotoFeed(
  tenantDb: TenantDb,
  userRole: string,
  userId: string,
  filters: PhotoFeedFilters
) {
  const page = filters.page ?? 1;
  const limit = filters.limit ?? 40;
  const offset = (page - 1) * limit;

  const conditions: ReturnType<typeof eq>[] = [
    eq(files.category, "photo"),
    eq(files.isActive, true),
  ];

  // RBAC: reps only see photos from their assigned deals
  if (userRole === "rep") {
    conditions.push(
      sql`${files.dealId} IN (SELECT id FROM deals WHERE assigned_rep_id = ${userId} AND is_active = TRUE)` as any
    );
  }

  if (filters.dealId) conditions.push(eq(files.dealId, filters.dealId));
  if (filters.uploadedBy) conditions.push(eq(files.uploadedBy, filters.uploadedBy));
  if (filters.subcategory) conditions.push(eq(files.subcategory, filters.subcategory));
  if (filters.dateFrom) {
    conditions.push(gte(sql`COALESCE(${files.takenAt}, ${files.createdAt})`, new Date(filters.dateFrom)));
  }
  if (filters.dateTo) {
    const endDate = new Date(filters.dateTo);
    endDate.setDate(endDate.getDate() + 1); // Include the full day
    conditions.push(sql`COALESCE(${files.takenAt}, ${files.createdAt}) < ${endDate}` as any);
  }

  // Exclude superseded versions
  conditions.push(
    sql`NOT EXISTS (SELECT 1 FROM files f2 WHERE f2.parent_file_id = files.id AND f2.is_active = true)` as any
  );

  const where = and(...conditions);

  const sortExpr = desc(sql`COALESCE(${files.takenAt}, ${files.createdAt})`);

  const [countResult, photoRows] = await Promise.all([
    tenantDb.select({ count: sql<number>`count(*)` }).from(files).where(where),
    tenantDb
      .select({
        id: files.id,
        displayName: files.displayName,
        mimeType: files.mimeType,
        subcategory: files.subcategory,
        dealId: files.dealId,
        externalUrl: files.externalUrl,
        externalThumbnailUrl: files.externalThumbnailUrl,
        r2Key: files.r2Key,
        takenAt: files.takenAt,
        createdAt: files.createdAt,
        geoLat: files.geoLat,
        geoLng: files.geoLng,
        uploadedBy: files.uploadedBy,
      })
      .from(files)
      .where(where)
      .orderBy(sortExpr)
      .limit(limit)
      .offset(offset),
  ]);

  const total = Number(countResult[0]?.count ?? 0);

  return {
    photos: photoRows,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

/**
 * Count new photos since a given timestamp (for polling badge).
 */
export async function getNewPhotoCount(
  tenantDb: TenantDb,
  userRole: string,
  userId: string,
  since: Date
): Promise<number> {
  const conditions: ReturnType<typeof eq>[] = [
    eq(files.category, "photo"),
    eq(files.isActive, true),
    gte(files.createdAt, since),
  ];

  if (userRole === "rep") {
    conditions.push(
      sql`${files.dealId} IN (SELECT id FROM deals WHERE assigned_rep_id = ${userId} AND is_active = TRUE)` as any
    );
  }

  const [result] = await tenantDb
    .select({ count: sql<number>`count(*)` })
    .from(files)
    .where(and(...conditions));

  return Number(result?.count ?? 0);
}
```

- [ ] **Step 2: Add feed routes to files/routes.ts**

Add import at top:

```typescript
import { getPhotoFeed, getNewPhotoCount } from "./feed-service.js";
```

Add before the dev-mode routes section:

```typescript
// GET /api/files/photos/feed — cross-project photo feed
router.get("/photos/feed", async (req, res, next) => {
  try {
    const filters = {
      dealId: req.query.dealId as string | undefined,
      uploadedBy: req.query.uploadedBy as string | undefined,
      subcategory: req.query.subcategory as string | undefined,
      dateFrom: req.query.dateFrom as string | undefined,
      dateTo: req.query.dateTo as string | undefined,
      page: req.query.page ? parseInt(req.query.page as string, 10) : undefined,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
    };

    const result = await getPhotoFeed(req.tenantDb!, req.user!.role, req.user!.id, filters);
    await req.commitTransaction!();
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/files/photos/feed/count — count new photos since timestamp (for polling)
router.get("/photos/feed/count", async (req, res, next) => {
  try {
    const since = req.query.since as string;
    if (!since) {
      throw new AppError(400, "since query parameter (ISO timestamp) is required.");
    }

    const count = await getNewPhotoCount(req.tenantDb!, req.user!.role, req.user!.id, new Date(since));
    await req.commitTransaction!();
    res.json({ count });
  } catch (err) {
    next(err);
  }
});
```

- [ ] **Step 3: Verify types compile**

Run: `npx tsc --noEmit --project server/tsconfig.json`
Expected: No errors.

- [ ] **Step 4: Commit**

```
git add server/src/modules/files/feed-service.ts server/src/modules/files/routes.ts
git commit -m "feat: add photo feed + count endpoints for cross-project photo browsing"
```

---

### Task 5: Client Hooks

**Files:**
- Create: `client/src/hooks/use-nearby-deals.ts`
- Create: `client/src/hooks/use-photo-feed.ts`

- [ ] **Step 1: Create use-nearby-deals.ts**

```typescript
// client/src/hooks/use-nearby-deals.ts
import { useState, useEffect, useCallback } from "react";
import { api } from "@/lib/api";

export interface NearbyDeal {
  id: string;
  dealNumber: string;
  name: string;
  propertyCity: string | null;
  distance: number; // miles
}

interface GpsPosition {
  lat: number;
  lng: number;
}

export function useNearbyDeals() {
  const [deals, setDeals] = useState<NearbyDeal[]>([]);
  const [gps, setGps] = useState<GpsPosition | null>(null);
  const [gpsError, setGpsError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Request GPS on mount
  useEffect(() => {
    if (!navigator.geolocation) {
      setGpsError("Geolocation not supported");
      setLoading(false);
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setGps({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setGpsError(null);
      },
      (err) => {
        setGpsError(err.message);
        setLoading(false);
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }, []);

  // Fetch nearby deals when GPS is available
  useEffect(() => {
    if (!gps) return;

    (async () => {
      setLoading(true);
      try {
        const data = await api<{ deals: NearbyDeal[] }>(
          `/deals/nearby?lat=${gps.lat}&lng=${gps.lng}`
        );
        setDeals(data.deals);
      } catch (err) {
        console.error("Failed to fetch nearby deals:", err);
      } finally {
        setLoading(false);
      }
    })();
  }, [gps]);

  // Auto-selected deal: nearest within 200m (~0.124 miles)
  const autoSelectedDeal = deals.length > 0 && deals[0].distance < 0.124
    ? deals[0]
    : null;

  return { deals, autoSelectedDeal, gps, gpsError, loading };
}
```

- [ ] **Step 2: Create use-photo-feed.ts**

```typescript
// client/src/hooks/use-photo-feed.ts
import { useState, useEffect, useCallback, useRef } from "react";
import { api } from "@/lib/api";

export interface FeedPhoto {
  id: string;
  displayName: string;
  mimeType: string;
  subcategory: string | null;
  dealId: string | null;
  externalUrl: string | null;
  externalThumbnailUrl: string | null;
  r2Key: string;
  takenAt: string | null;
  createdAt: string;
  geoLat: string | null;
  geoLng: string | null;
  uploadedBy: string;
}

export interface FeedFilters {
  dealId?: string;
  uploadedBy?: string;
  subcategory?: string;
  dateFrom?: string;
  dateTo?: string;
}

export function usePhotoFeed(filters: FeedFilters = {}) {
  const [photos, setPhotos] = useState<FeedPhoto[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [newCount, setNewCount] = useState(0);
  const lastFetchedAt = useRef<string>(new Date().toISOString());

  const fetchFeed = useCallback(async (pageNum: number = 1) => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set("page", String(pageNum));
      params.set("limit", "40");
      if (filters.dealId) params.set("dealId", filters.dealId);
      if (filters.uploadedBy) params.set("uploadedBy", filters.uploadedBy);
      if (filters.subcategory) params.set("subcategory", filters.subcategory);
      if (filters.dateFrom) params.set("dateFrom", filters.dateFrom);
      if (filters.dateTo) params.set("dateTo", filters.dateTo);

      const data = await api<{
        photos: FeedPhoto[];
        pagination: { page: number; limit: number; total: number; totalPages: number };
      }>(`/files/photos/feed?${params}`);

      setPhotos(data.photos);
      setPage(data.pagination.page);
      setTotalPages(data.pagination.totalPages);
      setTotal(data.pagination.total);
      lastFetchedAt.current = new Date().toISOString();
      setNewCount(0);
    } catch (err) {
      console.error("Failed to fetch photo feed:", err);
    } finally {
      setLoading(false);
    }
  }, [filters.dealId, filters.uploadedBy, filters.subcategory, filters.dateFrom, filters.dateTo]);

  // Initial fetch
  useEffect(() => {
    fetchFeed(1);
  }, [fetchFeed]);

  // Poll for new photo count every 30s
  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const data = await api<{ count: number }>(
          `/files/photos/feed/count?since=${encodeURIComponent(lastFetchedAt.current)}`
        );
        setNewCount(data.count);
      } catch {
        // Ignore polling errors
      }
    }, 30_000);

    return () => clearInterval(interval);
  }, []);

  const loadNewPhotos = () => fetchFeed(1);
  const goToPage = (p: number) => fetchFeed(p);

  return { photos, page, totalPages, total, loading, newCount, loadNewPhotos, goToPage };
}
```

- [ ] **Step 3: Verify client types compile**

Run: `npx tsc --noEmit --project client/tsconfig.json`
Expected: No errors.

- [ ] **Step 4: Commit**

```
git add client/src/hooks/use-nearby-deals.ts client/src/hooks/use-photo-feed.ts
git commit -m "feat: add useNearbyDeals and usePhotoFeed hooks"
```

---

### Task 6: Photo Capture Page

**Files:**
- Create: `client/src/pages/photos/photo-capture-page.tsx`
- Modify: `client/src/App.tsx`

- [ ] **Step 1: Create photo-capture-page.tsx**

Full-screen mobile-first camera page with GPS auto-detect, project picker, subcategory tags, photo preview, and R2 upload. Uses `useNearbyDeals` hook for GPS-sorted deal list. Uses existing `uploadFile` from `use-files.ts` for the presigned URL upload flow.

The page:
- Has NO AppShell chrome (no sidebar/topbar)
- Shows a "Back to App" link at top-left
- Bottom bar with Camera/Recent/Back tabs
- Project picker sorted by distance (auto-selects nearest)
- Subcategory quick-tags: Progress, Site Visit, Damage, Safety, Delivery, Other
- Camera input via `<input type="file" accept="image/*" capture="environment">`
- Photo preview after capture with optional note
- Upload progress indicator
- Success toast, resets for next photo

- [ ] **Step 2: Add route OUTSIDE AppShell in App.tsx**

In `client/src/App.tsx`, add the import:

```typescript
import { PhotoCapturePage } from "@/pages/photos/photo-capture-page";
```

Add the route BEFORE the `<Route element={<AppShell />}>` block but still inside `<Routes>` within `<AuthGate>`:

```tsx
<Route path="/photos/capture" element={<PhotoCapturePage />} />
<Route element={<AppShell />}>
  ... existing routes ...
</Route>
```

- [ ] **Step 3: Verify client types compile**

Run: `npx tsc --noEmit --project client/tsconfig.json`
Expected: No errors.

- [ ] **Step 4: Commit**

```
git add client/src/pages/photos/photo-capture-page.tsx client/src/App.tsx
git commit -m "feat: add mobile photo capture page with GPS auto-detect"
```

---

### Task 7: Photo Feed Page

**Files:**
- Create: `client/src/pages/photos/photo-feed-page.tsx`
- Create: `client/src/components/photos/photo-lightbox.tsx`
- Modify: `client/src/App.tsx`

- [ ] **Step 1: Create photo-lightbox.tsx**

Read-only lightbox component:
- Full-res image (loaded on demand via presigned URL or external URL)
- Metadata: date, project, uploader, subcategory
- Static map image if geo data exists (use OpenStreetMap static tile URL)
- Download button
- Prev/next navigation via callback props
- Close button (X) and click-outside-to-close
- Keyboard navigation: Escape to close, Left/Right for prev/next

- [ ] **Step 2: Create photo-feed-page.tsx**

Photo feed page inside AppShell:
- Sticky filter bar at top: project dropdown, date range, uploader, subcategory
- Responsive CSS columns grid (2 mobile, 3-4 tablet, 5-6 desktop) using `columns` CSS property
- Each photo card: thumbnail (lazy-loaded with `loading="lazy"`), project name, time ago, uploader, subcategory pill
- Thumbnails: use `externalThumbnailUrl` if available, otherwise request presigned download URL for the R2 key
- New photos badge: "X new photos — click to load" at top when `newCount > 0`
- Click card to open lightbox
- Pagination at bottom
- Uses `usePhotoFeed` hook

- [ ] **Step 3: Add feed route inside AppShell in App.tsx**

Add import:

```typescript
import { PhotoFeedPage } from "@/pages/photos/photo-feed-page";
```

Add route inside the `<Route element={<AppShell />}>` block:

```tsx
<Route path="/photos/feed" element={<PhotoFeedPage />} />
```

- [ ] **Step 4: Verify client types compile**

Run: `npx tsc --noEmit --project client/tsconfig.json`
Expected: No errors.

- [ ] **Step 5: Commit**

```
git add client/src/pages/photos/photo-feed-page.tsx client/src/components/photos/photo-lightbox.tsx client/src/App.tsx
git commit -m "feat: add photo feed page with masonry grid, filters, and lightbox"
```

---

### Task 8: Sidebar Navigation + Final Wiring

**Files:**
- Modify: `client/src/components/layout/sidebar.tsx`
- Modify: `client/src/components/layout/mobile-nav.tsx`

- [ ] **Step 1: Add Photos section to sidebar**

Add a "Photos" section with two links:
- Camera icon + "Capture" → `/photos/capture`
- Image icon + "Feed" → `/photos/feed`

Place in the sidebar after the existing Files link.

- [ ] **Step 2: Add to mobile nav**

Add a Camera icon to the mobile bottom navigation that links to `/photos/capture`.

- [ ] **Step 3: Full type check**

Run both:
```
npx tsc --noEmit --project client/tsconfig.json
npx tsc --noEmit --project server/tsconfig.json
```
Expected: Both pass with zero errors.

- [ ] **Step 4: Commit**

```
git add client/src/components/layout/sidebar.tsx client/src/components/layout/mobile-nav.tsx
git commit -m "feat: add photo capture and feed links to sidebar and mobile nav"
```

---

### Task 9: Geocode Backfill Script

**Files:**
- Create: `server/src/scripts/geocode-backfill.ts`

- [ ] **Step 1: Create backfill script**

Script that:
1. Queries all deals across tenant schemas that have `propertyAddress` + `propertyCity` + `propertyState` but NULL `propertyLat`
2. Geocodes each address via Census Bureau geocoder
3. Updates the deal record with lat/lng
4. Rate-limited: 1 request per second
5. Logs progress and results

```typescript
// server/src/scripts/geocode-backfill.ts
import pg from "pg";
import dotenv from "dotenv";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { geocodeAddress } from "../modules/deals/geocode.js";

dotenv.config({
  path: join(dirname(fileURLToPath(import.meta.url)), "../../../.env"),
});

async function backfill() {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    // Find all tenant schemas
    const { rows: schemas } = await client.query(
      "SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'office_%'"
    );

    let total = 0;
    let geocoded = 0;
    let failed = 0;

    for (const { schema_name } of schemas) {
      const { rows: dealsToGeocode } = await client.query(`
        SELECT id, property_address, property_city, property_state, property_zip
        FROM ${schema_name}.deals
        WHERE property_address IS NOT NULL
          AND property_city IS NOT NULL
          AND property_state IS NOT NULL
          AND property_lat IS NULL
          AND is_active = TRUE
      `);

      console.log(`[${schema_name}] ${dealsToGeocode.length} deals to geocode`);
      total += dealsToGeocode.length;

      for (const deal of dealsToGeocode) {
        const result = await geocodeAddress(
          deal.property_address,
          deal.property_city,
          deal.property_state,
          deal.property_zip
        );

        if (result) {
          await client.query(
            `UPDATE ${schema_name}.deals SET property_lat = $1, property_lng = $2 WHERE id = $3`,
            [result.lat, result.lng, deal.id]
          );
          geocoded++;
          console.log(`  Geocoded: ${deal.property_address}, ${deal.property_city} → ${result.lat}, ${result.lng}`);
        } else {
          failed++;
          console.log(`  No match: ${deal.property_address}, ${deal.property_city}`);
        }

        // Rate limit: 1 req/sec
        await new Promise((r) => setTimeout(r, 1000));
      }
    }

    console.log(`\nDone. Total: ${total}, Geocoded: ${geocoded}, No match: ${failed}`);
  } finally {
    await client.end();
  }
}

backfill();
```

- [ ] **Step 2: Commit**

```
git add server/src/scripts/geocode-backfill.ts
git commit -m "feat: add geocode backfill script for existing deal addresses"
```

---

## Execution Order

Tasks 1-4 (backend) can be done first, then Tasks 5-7 (frontend) in order, Task 8 (wiring), Task 9 (backfill script).

Tasks 1, 2, 3, 4 are independent of each other and can be parallelized.
Tasks 5 depends on 3 (nearby endpoint) and 4 (feed endpoint).
Task 6 depends on 5 (hooks).
Task 7 depends on 5 (hooks).
Task 8 depends on 6 and 7.
Task 9 depends on 2 (geocode service).
