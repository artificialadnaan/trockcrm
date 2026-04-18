# Admin Data Scrub And Ownership Reporting Plan

## Goal

Implement an admin-only control surface for data scrub backlog and ownership coverage without duplicating `/reports`, merge queue, or intervention workflow.

## Implementation Order

### 1. Server contract

Create `server/src/modules/admin/admin-reporting-service.ts` with:

- `getAdminDataScrubOverview(tenantDb)`

Return shape:

```ts
{
  summary: {
    openDuplicateContacts: number;
    resolvedDuplicateContacts7d: number;
    openOwnershipGaps: number;
    recentScrubActions7d: number;
  };
  backlogBuckets: Array<{
    bucketKey: "duplicate_contacts" | "ownership_gaps";
    label: string;
    count: number;
    linkPath: string;
  }>;
  ownershipCoverage: Array<{
    gapKey:
      | "deals_missing_region"
      | "contacts_missing_company"
      | "deals_primary_contact_company_mismatch";
    label: string;
    count: number;
  }>;
  scrubActivityByUser: Array<{
    userId: string | null;
    userName: string;
    actionCount: number;
    ownershipEditCount: number;
    lastActionAt: string | null;
  }>;
}
```

### 2. Server queries

Use deterministic, separate queries:

- duplicate backlog from `duplicate_queue`
- ownership gaps from `deals`, `contacts`, `properties`
- duplicate-resolution counts from `duplicate_queue`
- ownership-edit provenance from `audit_log` joined to `public.users`

Keep the office/user labels in public joins only where needed for display.

### 3. Admin routes

Extend `server/src/modules/admin/routes.ts`:

- `GET /admin/data-scrub/overview`

Use:

- `requireDirector`
- `tenantMiddleware`

### 4. Client hook

Create `client/src/hooks/use-admin-data-scrub.ts` with:

- `useAdminDataScrubOverview`

Pattern should match existing admin hooks:

- local loading/error/data state
- `api("/admin/data-scrub/overview")`
- refetch support

### 5. Client page

Create `client/src/pages/admin/admin-data-scrub-page.tsx`.

Sections:

- summary cards
- backlog bucket table
- ownership coverage table
- scrub activity by user table
- recent actions link-out panel

Deep links:

- duplicates -> `/admin/merge-queue`
- ownership gaps -> `/admin/audit`

### 6. Route registration

Extend `client/src/App.tsx` with the new admin page route.

### 7. Tests

Add focused server tests:

- `server/tests/modules/admin/admin-reporting-service.test.ts`
- `server/tests/modules/admin/admin-routes.test.ts`

Add focused client tests:

- `client/src/pages/admin/admin-data-scrub-page.test.tsx`
- or extend an existing admin-page test surface if there is a closer fit

## Query Details

### Duplicate bucket

Count unresolved duplicates only:

```sql
SELECT COUNT(*)::int
FROM duplicate_queue dq
WHERE dq.status = 'pending';
```

Adjust status set if the real unresolved values differ in schema.

Explicit velocity metric:

```sql
SELECT COUNT(*)::int
FROM duplicate_queue dq
WHERE dq.resolved_at >= (NOW() - INTERVAL '7 days');
```

### Ownership gaps

Run explicit counts:

```sql
SELECT COUNT(*)::int FROM deals WHERE region_id IS NULL;
SELECT COUNT(*)::int FROM contacts WHERE company_id IS NULL;
SELECT COUNT(*)::int
FROM deals d
LEFT JOIN contacts c ON c.id = d.primary_contact_id
WHERE d.primary_contact_id IS NOT NULL
  AND c.company_id IS DISTINCT FROM d.company_id;
```

### Scrub activity by user

Aggregate only explicit cleanup actions.

Duplicate resolution counts come from `duplicate_queue`, not `audit_log`.

Ownership-edit provenance comes from `audit_log`:

```sql
SELECT
  al.changed_by AS user_id,
  COALESCE(u.display_name, 'System') AS user_name,
  COUNT(*)::int AS action_count,
  COUNT(*) FILTER (
    WHERE al.table_name IN ('deals', 'contacts')
      AND EXISTS (
        SELECT 1
        FROM jsonb_object_keys(COALESCE(al.changes, '{}'::jsonb)) AS key(field_name)
        WHERE field_name IN ('assigned_rep_id', 'region_id', 'company_id', 'primary_contact_id', 'source_lead_id', 'property_id')
      )
  )::int AS ownership_edit_count,
  MAX(al.created_at) AS last_action_at
FROM audit_log al
LEFT JOIN public.users u ON u.id = al.changed_by
WHERE al.created_at >= (NOW() - INTERVAL '30 days')
  AND (
    al.table_name IN ('deals', 'contacts')
    AND EXISTS (
      SELECT 1
      FROM jsonb_object_keys(COALESCE(al.changes, '{}'::jsonb)) AS key(field_name)
      WHERE field_name IN ('assigned_rep_id', 'region_id', 'company_id', 'primary_contact_id', 'source_lead_id', 'property_id')
    )
  )
GROUP BY al.changed_by, u.display_name
ORDER BY action_count DESC, last_action_at DESC;
```

## Non-Redundancy Rules

- do not add a report entry to `/reports`
- do not add a second duplicate queue
- do not add resolution buttons that reimplement merge/intervention actions
- do not expose a generic export layer in phase 1

## Verification

Minimum verification before completion:

```bash
npx vitest run server/tests/modules/admin/admin-reporting-service.test.ts server/tests/modules/admin/admin-routes.test.ts
npx vitest run client/src/pages/admin/admin-data-scrub-page.test.tsx --config client/vite.config.ts
npm run typecheck
```

## Review Checklist

- feature remains admin-only
- no `/reports` duplication
- no new queue semantics introduced
- links route users into existing action surfaces
- summary counts and tables line up with server response contract
