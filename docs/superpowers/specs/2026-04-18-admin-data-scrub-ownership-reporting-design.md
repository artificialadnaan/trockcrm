# Admin Data Scrub And Ownership Reporting Design

## Goal

Add an admin-only operational reporting surface that answers:

- what data-quality backlog exists right now
- what ownership gaps exist right now
- who has been scrubbing or resolving those issues
- which queues need action next

This is not a new analytics lane. It is an admin control surface that sits next to audit log, merge queue, and intervention pages without duplicating them.

## Non-goals

- do not add a second generic issue queue
- do not move this into `/reports`
- do not duplicate contact merge functionality
- do not duplicate intervention-case workflow resolution
- do not add a custom report builder or saved-report path

## User Outcomes

Admins and directors should be able to open one page and quickly see:

- duplicate queue backlog and resolution velocity
- ownership gaps on core CRM entities
- recent scrub activity by user
- which cleanup buckets need attention first

From that page they should be able to link into the existing action surfaces:

- merge queue
- audit log
- users / offices admin pages

## Placement

- client route: `/admin/data-scrub`
- server routes: `/api/admin/data-scrub/*`
- server service module: `server/src/modules/admin/admin-reporting-service.ts`

Keep the feature in the admin module family, not the reports module family.

## Source Data

The page should aggregate from existing tenant/public sources:

- `audit_log`
- `duplicate_queue`
- `deals`
- `contacts`
- `companies`
- `properties`
- `users`
- `offices`
- `user_office_access`

## Core Concepts

### 1. Scrub backlog

Operational cleanup buckets that already exist or can be derived deterministically.

Initial buckets:

- `duplicate_contacts`
  - source: `duplicate_queue`
  - count only unresolved/open candidates
- `ownership_gaps`
  - source: live CRM rows
  - includes missing owner / missing region / missing canonical parent links

### 2. Ownership coverage

Roll up current coverage gaps across canonical entities.

Initial gap rules:

- deals missing region
- contacts missing company
- deals whose primary contact does not belong to the deal company

Do not include speculative or fuzzy gaps in phase 1.

### 3. Scrub provenance

Show which users are making cleanup changes and at what rate.

Initial provenance dimensions:

- actor user
- action count
- ownership edits on canonical relationship fields only
- most recent scrub action timestamp

Use a mixed provenance model:

- `duplicate_queue.resolved_by` / `duplicate_queue.resolved_at` for duplicate resolution activity
- `audit_log` for ownership/linkage edits on canonical CRM tables

### 4. Queue links, not duplicate workflows

The page should summarize and deep-link to existing operational pages.

Examples:

- duplicate backlog card links to merge queue
- recent scrub actions links to audit log with filters

## API Contract

### GET `/api/admin/data-scrub/overview`

Returns:

- `summary`
  - `openDuplicateContacts`
  - `resolvedDuplicateContacts7d`
  - `openOwnershipGaps`
  - `recentScrubActions7d`
- `backlogBuckets`
  - list of bucket rows with `bucketKey`, `label`, `count`, `linkPath`
- `ownershipCoverage`
  - list of gap rows with `gapKey`, `label`, `count`
- `scrubActivityByUser`
  - list of user rollups with `userId`, `userName`, `actionCount`, `ownershipEditCount`, `lastActionAt`

### GET `/api/admin/data-scrub/recent-actions`

Optional phase-1 route if the overview payload becomes too large.

Returns a paginated admin scrub action feed sourced from `audit_log`.

## Server Design

### New service

Create `server/src/modules/admin/admin-reporting-service.ts`.

It should expose:

- `getAdminDataScrubOverview(tenantDb, options)`
- `getRecentScrubActions(tenantDb, options)` if needed

### Query rules

- keep tenant-scoped data on `tenantDb`
- use existing public tables only for user/office display metadata
- do not call into `modules/reports/service.ts`
- do not re-implement merge logic or intervention logic

### Ownership gap rules

Use deterministic SQL counts and row lists only.

No AI inference in phase 1.

### Scrub provenance rules

Count only explicit cleanup-relevant audit activity.

Initial audited tables:

- `deals` when ownership/linkage fields change
- `contacts` when canonical company linkage fields change

Initial action scope:

- ownership/linkage field updates on canonical tables

Do not count generic CRUD edits as scrub work.

## Client Design

### Page

Create `client/src/pages/admin/admin-data-scrub-page.tsx`.

Layout:

1. title + short explanation
2. summary cards
3. backlog bucket table
4. ownership coverage table
5. scrub activity by user table
6. recent actions feed or link-out panel

### Hooks

Create `client/src/hooks/use-admin-data-scrub.ts`.

Provide:

- `useAdminDataScrubOverview`
- `useRecentScrubActions` if needed

### UX rules

- use admin page styling conventions, not reports-page analytics styling
- show deterministic labels and counts
- make bucket rows clickable to the existing admin pages
- show empty states, not blank tables
- keep actions explicit and link-based in phase 1

## Permissions

- route guard: `requireDirector`
  - in this codebase, that already covers `admin` and `director`
- reps should not see or access this page

## Redundancy Guardrails

- merge queue remains the place to resolve duplicate contacts
- intervention workspace remains the place to work disconnect cases
- reports page remains the place for business analytics
- audit log remains the raw change-history browser

This feature is the operational overview that ties those together.

## Phase 1 Scope

- admin overview route
- admin page
- summary cards
- backlog buckets
- ownership coverage table
- scrub activity by user
- deep links into existing admin surfaces

## Out Of Scope

- new merge workflow
- new intervention workflow
- saved reports
- CSV/PDF export in phase 1
- cross-office trend analytics
- automated remediation

## Success Criteria

- admin can see data scrub backlog counts without opening multiple pages
- admin can see ownership gap counts in one place
- admin can see which users are doing cleanup work
- each bucket links to the existing action surface instead of creating another queue
