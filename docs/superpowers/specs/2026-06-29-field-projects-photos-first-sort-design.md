# Field projects: photos-first sort (T-Rock Cam + field web)

**Date:** 2026-06-29
**Branch:** `feat/field-photos-first-sort`
**Status:** Approved (design)

## Problem

In the T-Rock Cam mobile app (and the field web app), the "All projects" list is the
crew's main way to find a job to view/add photos. Today the list is ordered by **recency**
— "most recent photo OR last touch, descending." A project that was recently *created,
updated, or had its stage changed* but has **zero photos** floats to the top, above projects
that actually have photos taken on them. Crews scroll past piles of empty projects to reach
the few with photos.

**Desired outcome:** projects that have photos appear at the top of the list.
**Business impact:** time-to-find-a-project; minutes add up across a crew, every day.

## Current behavior (grounding)

The field projects list is server-assembled and the clients render whatever order the API
returns (the mobile `partitionProjectSections` preserves source order; no client-side sort).

Two ordering steps exist today, both **recency-only**:

1. **Per-office SQL** — `listFieldProjects` in `server/src/modules/field/projects-service.ts:200`:
   ```sql
   ORDER BY COALESCE(photo_stats.last_photo_at, d.last_activity_at, d.updated_at, d.created_at) DESC NULLS LAST
   ```
2. **Cross-office merge** — inline in the `/api/field/projects` route handler
   (`server/src/modules/field/routes.ts:182-188`): flattens per-office results, stamps each
   row with its owning office, then `merged.sort((a, b) => (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? ""))`,
   then slices the page window.

`photoCount` is already computed per project (an index-backed `LEFT JOIN LATERAL` over the
`files` table) and already rendered on each row — so **no new data is needed**.

The mapped `lastActivityAt` field already equals the SQL recency expression
(`COALESCE(last_photo_at, last_activity_at, updated_at, created_at)`), so the merge step and
the SQL step sort on the same key — they stay consistent under pagination.

## Approach (chosen)

**Photos-first sort, server-side, no new UI.** Rank projects that have ≥1 photo above projects
with none; within each group, keep today's most-recent-first order. Applied in BOTH ordering
steps so the rule survives pagination.

Why server-side and not a client filter/sort: the list loads 50/page and the lists are **not**
wired for infinite scroll, so a client-side filter would only act on the already-loaded 50 — a
project with photos sitting deeper than the first window would never surface (Dallas alone has
~1,275 active projects). Ordering in the query pulls photo'd projects into the first window.

Why sort and not a "hide empties" filter: the stated goal is "see projects with photos at the
top," a sort delivers that with zero taps and removes nothing (empties still reachable by scroll
/ search). A filter toggle is a possible future follow-up, explicitly out of scope here.

### Scope

- **In scope:** the main "All projects" list — both the per-office SQL ORDER BY and the
  cross-office merge.
- **Out of scope (unchanged):** the **Nearby** list (distance-ranked — different purpose) and
  the **Starred** list (user-curated). The pain is the main list; touching the others is scope creep.
- **No client changes.** Mobile and field-web render API order as-is.

## Design

### 1. Per-office SQL ORDER BY (`projects-service.ts`)

Prepend a photos-first key to the existing recency order:

```sql
ORDER BY (COALESCE(photo_stats.photo_count, 0) > 0) DESC,
         COALESCE(photo_stats.last_photo_at, d.last_activity_at, d.updated_at, d.created_at) DESC NULLS LAST
```

`(photo_count > 0) DESC` puts `true` (has photos) before `false`; recency breaks ties within
each group exactly as before.

### 2. Extract the cross-office merge into a pure, tested function (`projects-service.ts`)

The main-list merge is currently inline in the route and **untested** (`routes.test.ts` mocks
`listFieldProjects`). The sibling merges (`mergeNearbyProjects`, `mergeFieldCaptureTargets`) are
extracted, exported pure functions with unit tests. Follow that established pattern:

```ts
/**
 * Merge per-office active-project results into ONE company-wide list, ordered PHOTOS-FIRST:
 * projects with ≥1 photo rank above projects with none; within a group, most-recent activity
 * first (cross-office-comparable ISO `lastActivityAt`, which already folds in the latest photo
 * time). Mirrors the per-office SQL ORDER BY so paginating the merged set stays consistent.
 * Ties break on id for a stable order. The caller applies the page/perPage slice.
 */
export function mergeFieldProjects(
  perOffice: Array<{ office: FieldOffice; projects: FieldProject[] }>,
): FieldProjectWithOffice[] {
  const stamped = perOffice.flatMap(({ office, projects }) =>
    projects.map((project) => ({ ...project, ...officeTag(office) })),
  );
  stamped.sort((left, right) => {
    const leftHasPhotos = left.photoCount > 0 ? 1 : 0;
    const rightHasPhotos = right.photoCount > 0 ? 1 : 0;
    if (leftHasPhotos !== rightHasPhotos) return rightHasPhotos - leftHasPhotos; // has-photos first
    const recencyDelta = (right.lastActivityAt ?? "").localeCompare(left.lastActivityAt ?? ""); // recent first, nulls last
    if (recencyDelta !== 0) return recencyDelta;
    return left.id.localeCompare(right.id); // stable
  });
  return stamped;
}
```

(`null` `lastActivityAt` sorts last with this formulation, matching the existing route behavior.)

### 3. Route wiring (`routes.ts`)

Replace the inline flatMap+sort with the extracted function; pagination slice unchanged:

```ts
const merged = mergeFieldProjects(
  results.map(({ office, value }) => ({ office, projects: value.projects })),
);
// ... res.json({ projects: merged.slice(offset, offset + perPage), total, ... })
```

Add `mergeFieldProjects` to the existing import from `./projects-service.js`.

## Testing

1. **Unit (pure fn)** — `mergeFieldProjects`: photos-first ordering across offices; recency
   desc within each group; null `lastActivityAt` last; stable id tiebreak; office stamping.
   Mirrors `nearby-projects-merge.test.ts`.
2. **Service SQL assertion** — extend `projects-service.test.ts`: the `listFieldProjects` rows
   query ORDER BY contains the `(... photo_count ... > 0) DESC` photos-first key ahead of the
   recency key (via `extractSqlText`).
3. **Runtime (PGlite) proof** — new `*.runtime.test.ts` mirroring `nearby-projects.runtime.test.ts`:
   insert deals with varying photo counts + activity dates into a real PG engine, call
   `listFieldProjects`, assert the returned order is all-with-photos (recent-first) then
   all-without (recent-first). This proves the SQL actually sorts, not just that the string is present.

## Risks / notes

- **Pagination consistency:** both ordering steps use the same photos-first + recency key, so the
  per-office fetch (`offset+perPage` deep) merges into a globally-consistent order before slicing.
- **No schema/migration changes**; `photoCount` already exists and is index-backed (`files_deal_idx`).
- **No client changes**; mobile/field-web inherit the new order automatically.
- **Reversibility:** pure ordering change; trivially revertable, no data writes.
