# Comprehensive Human-Readable Audit Logs Discovery

Date: 2026-05-14
Repo: `trockcrm`
Checkout used for discovery: `/Users/adnaaniqbal/projects/trockcrm`
Mode: read-only discovery only, no code changes

## Executive Summary

The current audit system is too primitive to become a customer/admin activity feed without a shared logging layer and broad coverage work.

The main problems are structural:

1. `audit_log` stores only `table_name`, `record_id`, `action`, optional `changed_by`, raw JSON `changes`, and raw JSON `full_row`.
2. The generic audit writer does not resolve actor labels, entity labels, impersonation, system-process identity, field display names, or privacy tiers.
3. The admin audit UI renders `record_id` as a truncated UUID and renders actor as either joined `display_name`, a truncated UUID, or the literal fallback `System`.
4. Most write surfaces do not call the generic audit writer at all.
5. Several workflows already write to parallel history systems (`activities`, `lead_stage_history`, `deal_stage_history`, `deal_history`, `photo_audit_log`) instead of one shared human-readable activity model.

This is not a small polish pass. Discovery found:

- `191` mutating Express route handlers across `25` route files
- `79` non-route server files with direct `.insert()`, `.update()`, or `.delete()` writes
- only `33` direct audit-call sites across generic audit, soft-delete audit, photo audit, and one raw `INSERT INTO audit_log`

This exceeds the prompt threshold for a single broad implementation pass. A phased rollout is warranted.

## Existing Audit Schema

### Generic audit table

Defined at [audit-log.ts](/Users/adnaaniqbal/projects/trockcrm/shared/src/schema/tenant/audit-log.ts:16).

Columns:

- `id bigserial primary key`
- `table_name varchar(100) not null`
- `record_id uuid not null`
- `action audit_action not null`
- `changed_by uuid null`
- `changes jsonb null`
- `full_row jsonb null`
- `ip_address inet null`
- `user_agent varchar(500) null`
- `created_at timestamptz not null default now()`

Indexes:

- `(table_name, record_id, created_at)` via `audit_record_idx`
- `(changed_by, created_at)` via `audit_user_idx`
- `(created_at)` via `audit_time_idx`

Limits of current schema:

- no actor label snapshot
- no actor type (`user` vs system process)
- no system process name
- no impersonation fields
- no entity type normalization beyond freeform `table_name`
- no entity display label snapshot
- no plain-English summary text
- no per-field display metadata
- no privacy/visibility metadata for customer-facing filtering

### Separate photo audit table

Defined at [files.ts](/Users/adnaaniqbal/projects/trockcrm/shared/src/schema/tenant/files.ts:90).

`photo_audit_log` is a separate subsystem with:

- `photo_id`
- `event_type`
- `user_id`
- `created_at`
- request metadata
- arbitrary `metadata`

This is already better than `audit_log` in one respect: the query layer joins to user and deal/file info. But it still does not snapshot stable human-readable labels at write time, and it only covers photo/file events.

### Parallel activity/history systems already in use

These are not the same thing as the generic audit log, but they already encode part of the desired user-facing history:

- `activities` via [activities/service.ts](/Users/adnaaniqbal/projects/trockcrm/server/src/modules/activities/service.ts:1)
- `lead_stage_history` via [leads/service.ts](/Users/adnaaniqbal/projects/trockcrm/server/src/modules/leads/service.ts:1613)
- `deal_stage_history` via [deals/stage-change.ts](/Users/adnaaniqbal/projects/trockcrm/server/src/modules/deals/stage-change.ts:354)
- `deal_history` via [deals/service.ts](/Users/adnaaniqbal/projects/trockcrm/server/src/modules/deals/service.ts:414)
- `directory_merge_audit` via [directoryDedup.ts](/Users/adnaaniqbal/projects/trockcrm/server/src/services/directoryDedup.ts:309)

Any implementation strategy needs to decide whether to:

- render one unified activity feed across these sources, or
- standardize future writes into one improved `audit_log` while leaving existing specialized tables intact

## How Audit Entries Are Written Today

### Generic helper

The shared generic writer is [audit-log.ts](/Users/adnaaniqbal/projects/trockcrm/server/src/lib/audit-log.ts:28).

It inserts exactly what the caller passes. It does not:

- infer actor from request context
- infer entity name
- enrich diffs
- filter internal-only fields
- tag system process names
- store human-readable summaries

### Soft delete helper

Soft deletes go through [soft-delete-audit.ts](/Users/adnaaniqbal/projects/trockcrm/server/src/lib/soft-delete-audit.ts:25).

This is generic but still minimal:

- `tableName = entityType`
- `recordId = entityId`
- `action = soft_delete`
- `changedBy = actorUserId`
- `changes = { deleted: { from: false, to: true } }`

### Photo audit helper

Photo/file audit events go through [audit-log-service.ts](/Users/adnaaniqbal/projects/trockcrm/server/src/modules/files/audit-log-service.ts:54).

This is a distinct path and is not reused for the generic audit table.

### Inline/raw audit writes

At least one route writes directly with raw SQL instead of the helper:

- [ai-copilot/routes.ts](/Users/adnaaniqbal/projects/trockcrm/server/src/modules/ai-copilot/routes.ts:107)

This confirms there is no enforced central API for audit logging.

## Why Entries Show Up As "System"

This is a combined write-path and render-path problem.

### Write-path root cause

`changed_by` is nullable in `audit_log`, and the writer accepts `changedBy: string | null`.

Evidence:

- schema allows null [audit-log.ts](/Users/adnaaniqbal/projects/trockcrm/shared/src/schema/tenant/audit-log.ts:23)
- helper accepts null [audit-log.ts](/Users/adnaaniqbal/projects/trockcrm/server/src/lib/audit-log.ts:11)

Several existing callers explicitly allow null actor IDs:

- deal creation uses `input.actorUserId ?? null` [deals/service.ts](/Users/adnaaniqbal/projects/trockcrm/server/src/modules/deals/service.ts:1149)
- AI copilot raw audit insert uses `${req.user?.id ?? null}` [ai-copilot/routes.ts](/Users/adnaaniqbal/projects/trockcrm/server/src/modules/ai-copilot/routes.ts:113)

There is no generic fallback to `req.user.id`, even though tenant middleware sets `app.current_user_id` in Postgres for the request transaction [tenant.ts](/Users/adnaaniqbal/projects/trockcrm/server/src/middleware/tenant.ts:88). The audit helper does not read that session value.

### Render-path root cause

The admin audit query only left-joins `audit_log.changed_by` to `public.users.display_name` [audit-service.ts](/Users/adnaaniqbal/projects/trockcrm/server/src/modules/admin/audit-service.ts:72).

The UI then renders:

- `changedByName`
- else truncated `changedBy`
- else `"System"`

Evidence: [audit-log-page.tsx](/Users/adnaaniqbal/projects/trockcrm/client/src/pages/admin/audit-log-page.tsx:127)

So `"System"` currently means only:

- `changed_by IS NULL`

It does not mean:

- which job wrote the change
- whether it was HubSpot Sync / Procore / Bid Board / migration / import / webhook
- whether the action was actually human-triggered but the caller forgot to pass actor

### Additional background-process root cause

Some background code today tries to fake human attribution instead of modeling a system actor properly. Example:

- Bid Board sync skips updates if there is no active admin/director user available "for audit history" [bid-board-sync/service.ts](/Users/adnaaniqbal/projects/trockcrm/server/src/modules/bid-board-sync/service.ts:508) and [bid-board-sync/service.ts](/Users/adnaaniqbal/projects/trockcrm/server/src/modules/bid-board-sync/service.ts:639)

That is a design smell. System processes should log as specific system actors, not depend on an arbitrary human surrogate.

## How Actor Resolution Works At Render Time

Current generic audit render pipeline:

1. Read rows from `audit_log`
2. Left join `changed_by -> public.users.id`
3. Return `changed_by_name`
4. UI displays `changedByName`, else truncated UUID, else `System`

Evidence:

- query/join: [audit-service.ts](/Users/adnaaniqbal/projects/trockcrm/server/src/modules/admin/audit-service.ts:72)
- UI fallback: [audit-log-page.tsx](/Users/adnaaniqbal/projects/trockcrm/client/src/pages/admin/audit-log-page.tsx:127)

There is no:

- denormalized actor label snapshot
- support for deleted/deactivated users remaining readable
- impersonation display
- system process labeling

## How Entity References Are Shown Today

Current generic audit render pipeline does not resolve entity names.

The admin page shows:

- `tableName` as code
- `recordId.slice(0, 8) + "..."` as the record identity
- raw `changes` or `fullRow` JSON in an expanded `<pre>`

Evidence:

- record UUID rendering: [audit-log-page.tsx](/Users/adnaaniqbal/projects/trockcrm/client/src/pages/admin/audit-log-page.tsx:130)
- raw JSON rendering: [audit-log-page.tsx](/Users/adnaaniqbal/projects/trockcrm/client/src/pages/admin/audit-log-page.tsx:148)

There is no UUID-to-entity lookup in the generic audit path.

The photo audit path is somewhat richer because it joins file and deal records at read time [audit-log-service.ts](/Users/adnaaniqbal/projects/trockcrm/server/src/modules/files/audit-log-service.ts:180), but that pattern is not generalized.

## Current UI Surface

Current generic audit UI exists only as:

- admin/director page at `/admin/audit`
- filters by table name, action, date range

Evidence:

- route query endpoint [admin/routes.ts](/Users/adnaaniqbal/projects/trockcrm/server/src/modules/admin/routes.ts:799)
- page component [audit-log-page.tsx](/Users/adnaaniqbal/projects/trockcrm/client/src/pages/admin/audit-log-page.tsx:1)

There is no existing:

- human-readable activity sentence rendering
- entity detail-page audit tab for deal/lead/property/contact/company
- admin “All Activity” feed with user/entity/date filters in the human-readable form requested
- customer-safe filtering layer for portal views

## Write Surface Inventory

## Inventory Method

Discovery used:

- `rg -t ts "\\.insert\\(|\\.update\\(|\\.delete\\(" server/src --files-with-matches`
- `rg -n "router\\.(post|put|patch|delete)\\(" server/src/modules --glob '!*test.ts'`
- targeted reads of core route and service modules

This inventory is grouped by file/module and current audit status:

- `ALREADY LOGGED`: writes audit entries today
- `MIXED`: some writes in the file are logged, many are not
- `NOT LOGGED`: writes data but no current generic/photo audit coverage found in that file

### Core CRM entity routes

- `server/src/modules/deals/routes.ts` — `MIXED`
  Routes: `50` mutating handlers.
  Currently logged:
  - admin override audit around scoping intake/resolved fields [deals/routes.ts](/Users/adnaaniqbal/projects/trockcrm/server/src/modules/deals/routes.ts:861)
  - soft delete [deals/routes.ts](/Users/adnaaniqbal/projects/trockcrm/server/src/modules/deals/routes.ts:1985)
  Not logged in this route file:
  - `POST /:id/trigger-rfp`
  - `POST /:id/rfp-retry`
  - `POST /`
  - `PATCH /:id`
  - `POST /:id/stage`
  - `POST /:id/team`
  - estimating CRUD
  - punch-list CRUD
  - timer CRUD
  - closeout writes

- `server/src/modules/deals/service.ts` — `MIXED`
  Currently logged:
  - deal create [deals/service.ts](/Users/adnaaniqbal/projects/trockcrm/server/src/modules/deals/service.ts:1145)
  - rep reassignment via `deal_history` tableName audit row [deals/service.ts](/Users/adnaaniqbal/projects/trockcrm/server/src/modules/deals/service.ts:1415)
  - proposal draft start [deals/service.ts](/Users/adnaaniqbal/projects/trockcrm/server/src/modules/deals/service.ts:1531)
  - contract signed date changes [deals/service.ts](/Users/adnaaniqbal/projects/trockcrm/server/src/modules/deals/service.ts:1950)
  Not logged in this file:
  - many deal updates
  - deal history writes themselves are not humanized into feed entries
  - job queue mutations

- `server/src/modules/deals/stage-change.ts` — `NOT LOGGED` to generic audit
  Writes:
  - `dealApprovals`
  - `deals`
  - `tasks`
  - `deal_stage_history`
  - multiple job queue records
  Current history is specialized stage history, not the requested human-readable audit feed.

- `server/src/modules/leads/routes.ts` — `MIXED`
  Routes: `7` mutating handlers.
  Currently logged:
  - soft delete only [leads/routes.ts](/Users/adnaaniqbal/projects/trockcrm/server/src/modules/leads/routes.ts:491)
  Not logged in this route file:
  - `PATCH /:id/scoping`
  - `POST /`
  - `POST /:id/stage-transition`
  - `PATCH /:id`
  - `POST /:id/convert`

- `server/src/modules/leads/service.ts` — `NOT LOGGED` to generic audit
  Writes:
  - lead create
  - lead update
  - `lead_stage_history`
  - `activities` note on stage change
  This means lead changes partially appear in the separate activity system, but not in the generic audit feed.

- `server/src/modules/leads/conversion-service.ts` — `NOT LOGGED`
  Writes converted lead state and related deal conversion effects.

- `server/src/modules/properties/routes.ts` — `MIXED`
  Routes: `3` mutating handlers.
  Currently logged:
  - soft delete [properties/routes.ts](/Users/adnaaniqbal/projects/trockcrm/server/src/modules/properties/routes.ts:76)
  Not logged:
  - property create
  - property update

- `server/src/modules/properties/service.ts` — `NOT LOGGED`
  Writes:
  - property create
  - property update
  - soft-delete state mutation

- `server/src/modules/companies/routes.ts` — `MIXED`
  Routes: `5` mutating handlers.
  Currently logged:
  - soft delete [companies/routes.ts](/Users/adnaaniqbal/projects/trockcrm/server/src/modules/companies/routes.ts:86)
  Not logged:
  - company create
  - company update
  - verification approve/reject

- `server/src/modules/companies/service.ts` — `NOT LOGGED`
  Writes create/update/delete state.

- `server/src/modules/companies/customer-status-service.ts` — `NOT LOGGED`
  Writes verification status changes.

- `server/src/modules/contacts/routes.ts` — `MIXED`
  Routes: `10` mutating handlers.
  Currently logged:
  - soft delete [contacts/routes.ts](/Users/adnaaniqbal/projects/trockcrm/server/src/modules/contacts/routes.ts:304)
  Not logged:
  - contact create
  - contact update
  - duplicate merge/dismiss
  - association create/update/delete
  - contact activity creation

- `server/src/modules/contacts/service.ts` — `NOT LOGGED`
  Writes contact create/update/delete state.

- `server/src/modules/contacts/association-service.ts` — `NOT LOGGED`
  Writes contact-deal associations and related primary-contact deal updates.

- `server/src/modules/contacts/merge-service.ts` — `NOT LOGGED`
  Bulk rewrites contacts, deals, emails, activities, files, tasks during merge.

- `server/src/modules/tasks/routes.ts` — `NOT LOGGED`
  Routes: `6` mutating handlers.
  Not logged:
  - manual task create
  - task patch
  - transition
  - complete
  - dismiss
  - snooze

- `server/src/modules/tasks/service.ts` — `NOT LOGGED`
  Writes task state plus side-effect queue rows.

- `server/src/modules/activities/routes.ts` — `NOT LOGGED` to audit
  Creates manual activities, but this is a separate business activity stream.

- `server/src/modules/activities/service.ts` — `NOT LOGGED` to audit
  Creates `activities` rows and updates `deals.lastActivityAt`.

### Files, photos, recordings, email

- `server/src/modules/files/routes.ts` — `MIXED`
  Routes: `8` mutating handlers.
  Currently logged:
  - admin override intake audits [files/routes.ts](/Users/adnaaniqbal/projects/trockcrm/server/src/modules/files/routes.ts:78)
  - photo events through `logPhotoEvent`
  - file soft delete [files/routes.ts](/Users/adnaaniqbal/projects/trockcrm/server/src/modules/files/routes.ts:863)
  Not logged in the requested generic human-readable sense:
  - many file metadata updates
  - new file version behavior
  - generic file uploads outside photo audit semantics

- `server/src/modules/files/service.ts` — `NOT LOGGED`
  Writes file rows and updates file metadata.

- `server/src/modules/files/upload-workflow.ts` — `ALREADY LOGGED` for photo audit only
  Logs uploaded photo events.

- `server/src/modules/files/audit-log-service.ts` — `ALREADY LOGGED` for photo audit only

- `server/src/modules/public-photo-tokens/service.ts` — `ALREADY LOGGED` for photo access events only

- `server/src/modules/call-recordings/routes.ts` — `MIXED`
  Currently logged:
  - soft delete only [call-recordings/routes.ts](/Users/adnaaniqbal/projects/trockcrm/server/src/modules/call-recordings/routes.ts:152)
  Not logged:
  - upload-url creation flow
  - confirm flow

- `server/src/modules/call-recordings/service.ts` — `NOT LOGGED`
  Writes recording rows and updates processing status.

- `server/src/modules/email/routes.ts` — `NOT LOGGED`
  Routes:
  - send
  - assign/reassign/detach thread
  - patch actions
  - associate email

- `server/src/modules/email/service.ts` — `NOT LOGGED`
  Writes emails, thread bindings, activities, associations.

### Deal-adjacent workflow modules

- `server/src/modules/deals/scoping-service.ts` — `MIXED`
  Currently logged:
  - admin override audit rows [deals/scoping-service.ts](/Users/adnaaniqbal/projects/trockcrm/server/src/modules/deals/scoping-service.ts:680) and [deals/scoping-service.ts](/Users/adnaaniqbal/projects/trockcrm/server/src/modules/deals/scoping-service.ts:940)
  Not logged:
  - normal scoping intake writes
  - task creation side effects
  - deal activation status changes

- `server/src/modules/deals/routing-service.ts` — `NOT LOGGED`
  Writes deal routing history and department handoffs.

- `server/src/modules/deals/rfp-enqueue.ts` — `NOT LOGGED`
  Enqueues RFP jobs.

- `server/src/modules/deals/estimate-service.ts` — `NOT LOGGED`
  Writes estimate sections/items.

- `server/src/modules/deals/punch-list-service.ts` — `NOT LOGGED`

- `server/src/modules/deals/team-service.ts` — `NOT LOGGED`

- `server/src/modules/deals/timer-service.ts` — `NOT LOGGED`

- `server/src/modules/deals/closeout-service.ts` — `NOT LOGGED`

- `server/src/modules/deals/lineage-resolver.ts` — `NOT LOGGED`
  Important constraint: do not touch lineage logic during implementation unless absolutely necessary. Discovery only here.

### Lead-adjacent workflow modules

- `server/src/modules/leads/scoping-service.ts` — `NOT LOGGED`

- `server/src/modules/leads/questionnaire-service.ts` — `NOT LOGGED`

- `server/src/modules/leads/qualification-service.ts` — `NOT LOGGED`

- `server/src/modules/leads/due-diligence-service.ts` — `NOT LOGGED`
  Writes approvals, lead verification state, notification recipient assignments.

- `server/src/modules/leads/public-due-diligence-routes.ts` — `NOT LOGGED`
  Public decision endpoint mutates approval state.

### Admin, permissions, ownership, directory merge

- `server/src/modules/admin/routes.ts` — `MIXED`
  Routes: `21` mutating handlers.
  Currently logged:
  - photo audit retry logging at [admin/routes.ts](/Users/adnaaniqbal/projects/trockcrm/server/src/modules/admin/routes.ts:919)
  Not logged:
  - office create/update
  - user updates
  - office access grants/revokes
  - ownership sync apply
  - directory merge queue actions
  - due diligence approve/reject
  - notification recipient assignment writes
  - cleanup reassign
  - pipeline edits/reorder
  - procore catalog sync trigger

- `server/src/modules/admin/users-service.ts` — `NOT LOGGED`
  Writes role/office/commission settings and office access, which are directly in scope for audit requirements.

- `server/src/modules/admin/offices-service.ts` — `NOT LOGGED`

- `server/src/modules/admin/pipeline-service.ts` — `NOT LOGGED`

- `server/src/services/directoryDedup.ts` — `NOT LOGGED` in generic audit
  Has its own `directory_merge_audit`, but not the requested shared human-readable activity feed.

- `server/src/modules/sales-review/routes.ts` and `server/src/modules/sales-review/ownership-sync-service.ts` — `NOT LOGGED`
  Reassign ownership and update deals.

### Integrations, automations, workers, and webhooks

- `server/src/modules/bid-board-sync/service.ts` — `NOT LOGGED` in shared audit feed
  Writes deal estimates and stage changes through `deal_history` / `deal_stage_history`.
  Important finding:
  - it currently requires a human `changedByUserId` and skips writes when no active admin/director exists [bid-board-sync/service.ts](/Users/adnaaniqbal/projects/trockcrm/server/src/modules/bid-board-sync/service.ts:508)
  This is incompatible with the desired `"Bid Board Polling"` style system actor model.

- `server/src/modules/procore/webhook-routes.ts` — `NOT LOGGED`
  Public webhook ingestion writes `procore_webhook_log` and enqueues jobs.

- `server/src/modules/procore/sync-service.ts` — `NOT LOGGED`
  Writes deal Procore linkage/sync state.

- `server/src/modules/procore/catalog-sync-service.ts` — `NOT LOGGED`

- `server/src/modules/procore/reconciliation-service.ts` — `NOT LOGGED`

- `server/src/modules/procore/routes.ts` — `NOT LOGGED`

- `server/src/modules/procore/synchub-routes.ts` — `NOT LOGGED`

- `server/src/modules/companycam/routes.ts` and `server/src/modules/companycam/service.ts` — `NOT LOGGED`
  Imports photos/files and links projects to deals.

- `server/src/modules/ai-copilot/routes.ts` — `MIXED`
  One raw audit row exists for manager-brief telemetry only [ai-copilot/routes.ts](/Users/adnaaniqbal/projects/trockcrm/server/src/modules/ai-copilot/routes.ts:107).
  The bulk of mutation endpoints are not integrated with the shared audit model.

- `server/src/modules/ai-copilot/service.ts`, `intervention-service.ts`, `task-suggestion-service.ts`, `intervention-manager-alerts-service.ts`, `intervention-policy-recommendation-seed-service.ts` — `NOT LOGGED`

- `server/src/modules/migration/routes.ts`, `migration/service.ts`, `migration/validator.ts` — `NOT LOGGED`

- `server/src/modules/projects/routes.ts` — `NOT LOGGED`

### Reporting, saved views, notifications, auth, and support systems

- `server/src/modules/reports/routes.ts` and `saved-reports-service.ts` — `NOT LOGGED`

- `server/src/modules/notifications/crud-routes.ts` and `notifications/service.ts` — `NOT LOGGED`

- `server/src/modules/auth/routes.ts`, `auth/service.ts`, `auth/local-auth-service.ts`, `email/graph-token-service.ts`, `procore/oauth-token-service.ts` — `NOT LOGGED`
  These include permission-sensitive and connection-state writes.

## Root Cause Analysis

## Why the current audit feed is unreadable

1. **The write contract is too low-level.**
   Callers write table name, UUID, optional user UUID, and raw JSON. That is enough for forensics, not enough for a human feed.

2. **There is no mandatory central writer.**
   Logging is opt-in and inconsistent. Some modules call `writeAuditLog`, some use photo audit, some use history tables, some do nothing, and one path writes raw SQL directly.

3. **Actor identity is not modeled.**
   There is only `changed_by uuid`. There is no distinction among:
   - authenticated user
   - system process
   - webhook source
   - impersonated action

4. **Entity identity is not modeled.**
   There is only `record_id uuid` plus freeform `table_name`. The UI never resolves or snapshots human-readable record labels.

5. **Diff presentation is not modeled.**
   `changes` is raw JSON with internal field names and unformatted values. There is no formatter registry for currency, dates, enums, null transitions, or redaction.

6. **Privacy is not modeled.**
   There is no field-level sensitivity metadata to support admin-only vs customer-safe rendering.

7. **The codebase already has multiple overlapping history systems.**
   `activities`, stage history tables, file/photo audit, and generic audit all exist separately. A unified activity feed needs an explicit architectural decision instead of more ad hoc writes.

## Proposed Schema/Model Changes

Recommendation for future implementation: keep the existing `audit_log` table but augment it for richer future entries.

Suggested additive columns for `audit_log`:

- `actor_type` — `user | system | impersonated_user`
- `actor_user_id` — existing `changed_by` can remain or be aliased
- `actor_label` — denormalized snapshot, for example `Adnaan Iqbal`
- `actor_process` — for system actors, for example `HubSpot Sync`, `Bid Board Polling`, `Procore Webhook`
- `impersonated_user_id`
- `impersonated_user_label`
- `entity_type` — normalized logical type: `deal`, `lead`, `property`, `contact`, `company`, `task`, `file`, `photo`, etc.
- `entity_label` — stable snapshot, for example `Tides at Timberglen (DFW-4-11426-AF)`
- `parent_entity_type` / `parent_entity_id` / `parent_entity_label` where useful for nested records like files/photos/tasks
- `summary_text` — pre-rendered plain-English sentence for fast list rendering
- `field_changes_enriched jsonb` — formatted diff payload with labels and display values
- `visibility_scope` — `internal`, `customer_safe`, `role_restricted`
- `sensitive_fields jsonb` or `sensitivity_flags jsonb`
- `metadata jsonb` — for origin/process details

If schema churn must be minimized, a subset would still unlock most value:

- `actor_label`
- `actor_process`
- `impersonated_user_id`
- `impersonated_user_label`
- `entity_type`
- `entity_label`
- `summary_text`
- `field_changes_enriched`
- `visibility_scope`

## Estimated Total Write Surfaces Requiring Coverage

At minimum:

- `191` mutating route handlers
- `79` non-route write-capable modules
- only `33` current audit-call sites

Practical implication:

- the shared logging helper can be built once
- but coverage work is broad and should be phased
- discovery strongly supports splitting implementation

## Scope Recommendation

Discovery found far more than `~40` write surfaces. This should be split.

Recommended implementation phases:

- **Phase 1**
  - shared audit logger + formatter + privacy model
  - admin all-activity feed foundation
  - core entity coverage: deals + leads
  - entity detail tabs for deals + leads
  - explicit system actor model for Bid Board / Procore / HubSpot style entries

- **Phase 2**
  - properties, companies, contacts, tasks, files/photos, email, recordings
  - admin permissions/office-access changes
  - merges and directory cleanup flows
  - broader integrations and ops tooling

- **Phase 3**
  - long-tail ops/migration/AI/reports/auth/support write surfaces
  - optional historical enrichment/backfill helper

## Strategy Recommendation For Step 2

Recommended strategy: **Strategy A**

Reason:

- the current `audit_log` table is limited but not unusable
- existing integrations already depend on it
- additive columns plus a new shared `logActivity(...)` helper let new entries become rich without rewriting history
- backfill can remain explicitly out of scope

I do **not** recommend Strategy C. There are too many existing specialized history systems and write paths to safely replace everything in one pass.

## Known Constraints For Implementation

- Do not touch `server/src/modules/deals/service.ts` lineage logic beyond strictly necessary audit wiring.
- Do not try to fix unrelated failing tests.
- Customer-facing filtering must be server-enforced, not just hidden in the client.
- Sensitive financial fields need role-aware masking/exclusion in the response model, not only in the renderer.
- Background/system actors need first-class support so integrations stop depending on surrogate human IDs.

