# T Rock Construction — Custom CRM Platform Design Spec

**Date:** 2026-04-01
**Author:** Adnaan Iqbal (BlueprintOps)
**Client:** T Rock Construction
**Status:** Phase 1 — Design Approved
**Budget:** $45,000 (one-time)
**Go-Live Target:** May 15, 2026

---

## 1. Project Overview

Custom CRM platform replacing HubSpot as T Rock Construction's primary sales and operations tool. Integrates natively with Procore (system of record) and Microsoft 365 (email/auth). Fully owned by T Rock with complete IP transfer. Architected for multi-office from day one.

The CRM becomes the deal lifecycle authority. SyncHub v3 (existing middleware) is scoped down to Bid Board automation only — feeding opportunities into the CRM rather than into HubSpot.

### What's In Scope (Phase 1)

1. Pipeline & deal management with stage gates
2. Reporting & dashboards (rep, director, company-wide)
3. Procore bi-directional integration
4. Email via Microsoft Graph API
5. Contact directory with deduplication
6. Photo & document management
7. Audit trail & data integrity
8. Automated alerts & task management
9. Multi-office / franchise architecture
10. HubSpot data migration with validation

### What's Explicitly Deferred (Phase 2)

- AI-powered business card scanning
- AI industry news feed / automatic lead generation
- Large loss monitoring
- AI data discrepancy detection
- Performance anomaly detection
- Relationship/influence mapping
- Phone call recording integration

---

## 2. Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React + Vite + TypeScript + Tailwind CSS + shadcn/ui |
| Backend API | Express + TypeScript |
| Worker | Express (separate entrypoint) + node-cron |
| ORM | Drizzle ORM |
| Database | PostgreSQL (Railway) |
| File Storage | Cloudflare R2 (presigned URL uploads) |
| Auth | Microsoft Entra ID (Azure AD) SSO + dev-mode user picker |
| Email | Microsoft Graph API |
| Integrations | Procore REST API + webhooks |
| Charts | Recharts |
| Notifications | Server-Sent Events (SSE) |
| Hosting | Railway (3 services: API, Worker, Frontend) |

### Stack Rationale

- **Drizzle over Prisma:** Same ORM as SyncHub (same client). Heavy reporting queries stay close to raw SQL. No context-switching between T Rock projects.
- **Separate Worker service:** Isolates cron jobs and on-demand tasks from API traffic. Natural home for Phase 2 AI inference workloads (Claude API calls) without re-architecture. ~$5-10/mo extra on Railway.
- **SSE over WebSockets:** CRM notifications are one-directional (server → client). SSE is simpler, auto-reconnects natively, works through Railway's proxy. Supports streaming for Phase 2 AI responses.
- **R2 over S3:** Zero egress fees. 100 GB of photos = $1.50/mo. Presigned URL uploads keep files off the Express server.

---

## 3. Architecture

### Pattern: Modular Monolith with Domain Events

Single Express server with feature modules communicating through an internal event bus (Node EventEmitter). Each module owns its routes, services, and validation logic. Modules never import from each other directly — they emit events and subscribe to events.

```
client/          → React frontend (Railway Service 3)
server/          → Express API (Railway Service 1)
  modules/
    auth/        → MS Entra SSO, sessions, RBAC
    deals/       → Pipeline, estimates, stage gates
    contacts/    → Directory, dedup, touchpoints
    email/       → Graph API send/receive, sync, matching
    procore/     → API client, stage mapping, webhooks
    photos/      → R2 presigned URLs, timeline, folders
    reports/     → Saved filters, locked reports, charts
    tasks/       → Daily list, reminders, alerts
    audit/       → PG trigger setup, history queries
    office/      → Schema management, tenant routing
    notifications/ → SSE endpoint, notification CRUD
    migration/   → HubSpot import, staging, validation UI
  events/        → Event bus, event type definitions
worker/          → Cron jobs + on-demand jobs (Railway Service 2)
  jobs/
    email-sync.ts       → MS Graph delta sync (every 5min)
    procore-sync.ts     → Procore poll (every 15min)
    daily-tasks.ts      → Generate task lists (daily 6am)
    stale-deals.ts      → Stale deal scan (daily 6am)
    activity-alerts.ts  → Activity drop detection (daily 7am)
    dedup-scan.ts       → Contact fuzzy dedup (weekly)
    audit-partition.ts  → Audit log partition check (weekly)
shared/          → Drizzle schemas, TypeScript types, enums
migrations/      → Drizzle migration files
```

### Domain Events

Events decouple modules. When a deal is won, the deals module doesn't call procore, email, tasks, and notifications directly — it emits `deal.won` and each module handles its piece.

| Event | Emitted By | Listeners |
|-------|-----------|-----------|
| `deal.stage.changed` | deals | email, procore, tasks, notifications |
| `deal.won` | deals | procore (create project), notifications, tasks |
| `deal.lost` | deals | notifications, reports |
| `contact.created` | contacts | dedup check, touchpoint alert |
| `email.received` | email | tasks (create follow-up), deals (log), contacts (touchpoint) |
| `email.sent` | email | activities (log), contacts (touchpoint) |
| `file.uploaded` | photos | auto-naming, EXIF extraction |
| `task.completed` | tasks | activities (log), deals (follow-up compliance) |
| `approval.requested` | deals | notifications (director alert) |
| `approval.resolved` | deals | notifications (rep alert), deals (stage advance) |

The event bus uses two channels:

- **In-process events (Node EventEmitter):** For side effects that run within the API server (e.g., `deal.stage.changed` → update deal record, log activity, send SSE notification). These are synchronous within the request lifecycle.
- **Cross-process events (PG LISTEN/NOTIFY):** For side effects that the Worker must handle (e.g., `deal.won` → create Procore project, `email.received` → create follow-up task). The API server calls `NOTIFY` on a PG channel, the Worker listens and processes. This is durable — if the Worker is restarting, events queue in PG until the listener reconnects.

For critical side effects (Procore project creation, email sync), the API also writes a job row to a `public.job_queue` table as an outbox pattern fallback. The Worker polls this table on startup to catch any events missed during downtime.

### Multi-Office Tenancy: Schema-Per-Office

Each office gets its own PostgreSQL schema (`office_dallas`, `office_houston`, etc.) with an identical set of tables. Global data (users, offices, pipeline config, saved reports, Procore sync state) lives in the `public` schema.

**Request Flow:**

Every API request runs inside a database transaction via middleware. This ensures `SET LOCAL` statements (search_path and current_user_id) are scoped to the request and cannot leak between concurrent requests sharing a connection pool.

1. Browser sends request with JWT + optional `X-Office-Id` header (for office switching)
2. Auth middleware validates JWT, extracts `{ userId, role, email }`. Office determined by: `X-Office-Id` header (validated against `user_office_access`) → fallback to JWT's default `officeId`
3. Transaction middleware opens a DB transaction on a dedicated connection
4. Office resolver looks up `office.slug` from resolved officeId → `"dallas"`
5. Schema setter runs `SET LOCAL search_path = 'office_dallas', 'public'`
6. Audit setter runs `SET LOCAL app.current_user_id = '{userId}'`
7. Route handler executes Drizzle query — PG resolves to the correct office schema automatically
8. PG triggers fire (audit log, change order totals, etc.)
9. Transaction commits
10. Event bus emits in-process events (SSE notifications, activity logging)
11. PG NOTIFY emits cross-process events for Worker (Procore sync, email tasks)

**Cross-Office Reporting:** Director/admin queries use `UNION ALL` across office schemas or a materialized reporting view refreshed by the worker.

**New Office Provisioning:**
1. Insert row into `public.offices`
2. Run migration runner against new schema (creates all tables, triggers, indexes)
3. Office is immediately available — no code changes, no redeploy

**Implications:**
- Migrations run per-schema — migration runner loops across all office schemas
- Drizzle queries don't need `office_id` filters — PG `search_path` handles isolation
- A missed filter can't leak data across offices — schema boundaries enforce isolation

---

## 4. Database Schema

### 4.1 Global Schema (`public`)

#### `public.offices`

| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | auto-generated |
| name | VARCHAR(255) NOT NULL | "Dallas", "Houston" |
| slug | VARCHAR(100) UNIQUE NOT NULL | Used for schema name: `office_{slug}` |
| address | TEXT | |
| phone | VARCHAR(20) | |
| is_active | BOOLEAN DEFAULT true | Soft delete |
| settings | JSONB DEFAULT '{}' | Per-office overrides (stale thresholds, notification prefs) |
| created_at | TIMESTAMPTZ NOT NULL DEFAULT NOW() | |
| updated_at | TIMESTAMPTZ NOT NULL DEFAULT NOW() | |

#### `public.users`

| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | auto-generated |
| email | VARCHAR(255) UNIQUE NOT NULL | MS Entra email |
| display_name | VARCHAR(255) NOT NULL | |
| azure_ad_id | VARCHAR(255) UNIQUE | From MS Entra token |
| avatar_url | TEXT | |
| role | ENUM('admin','director','rep') NOT NULL | |
| office_id | UUID FK → offices.id NOT NULL | Primary office |
| is_active | BOOLEAN DEFAULT true | |
| notification_prefs | JSONB DEFAULT '{}' | |
| created_at | TIMESTAMPTZ NOT NULL DEFAULT NOW() | |
| updated_at | TIMESTAMPTZ NOT NULL DEFAULT NOW() | |

#### `public.user_office_access`

Directors/admins who can access multiple offices.

| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| user_id | UUID FK → users.id NOT NULL | |
| office_id | UUID FK → offices.id NOT NULL | |
| role_override | ENUM('admin','director','rep') | NULL = use user's default role |
| UNIQUE(user_id, office_id) | | |

#### `public.pipeline_stage_config`

| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| name | VARCHAR(100) NOT NULL | "DD", "Estimating", "Bid Sent", "In Production", "Close Out", "Closed Won", "Closed Lost" |
| slug | VARCHAR(100) UNIQUE NOT NULL | |
| display_order | INTEGER NOT NULL | Used for forward/backward detection |
| is_active_pipeline | BOOLEAN DEFAULT true | false for DD (excluded from pipeline totals) |
| is_terminal | BOOLEAN DEFAULT false | true for Closed Won, Closed Lost |
| required_fields | JSONB DEFAULT '[]' | Field names required to enter this stage |
| required_documents | JSONB DEFAULT '[]' | Document types required |
| required_approvals | JSONB DEFAULT '[]' | Roles that must approve |
| stale_threshold_days | INTEGER | NULL = no stale alert for this stage |
| procore_stage_mapping | VARCHAR(100) | Maps to Procore project status |
| color | VARCHAR(7) | Hex color for UI badges |

#### `public.project_type_config`

Hierarchical project type / business line categories for deals. Locked dropdown values — users cannot create new types.

| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| name | VARCHAR(100) NOT NULL | |
| slug | VARCHAR(100) UNIQUE NOT NULL | |
| parent_id | UUID FK → project_type_config.id | NULL = top-level business line |
| display_order | INTEGER NOT NULL | |
| is_active | BOOLEAN DEFAULT true | |

**Predefined hierarchy:**
```
Multifamily (parent)
  ├── Traditional Multifamily
  ├── Student Housing
  └── Senior Living
Commercial (parent)
  ├── New Construction
  └── Land Development
Service (parent)
Restoration (parent)
```

Reports group by parent business line ("show me the pie chart of those buckets") and can drill into sub-types.

#### `public.region_config`

Geographic regions for deal filtering and reporting.

| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| name | VARCHAR(100) NOT NULL | "Texas", "East Coast", "Southeast", etc. |
| slug | VARCHAR(100) UNIQUE NOT NULL | |
| states | TEXT[] NOT NULL | States included: ["TX"], ["NY", "NJ", "CT", "PA"] |
| display_order | INTEGER NOT NULL | |
| is_active | BOOLEAN DEFAULT true | |

Deals reference `region_id` as a locked dropdown. Region auto-suggested from `property_state` but manually overridable.

#### `public.lost_deal_reasons`

| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| label | VARCHAR(255) NOT NULL | "Price", "Timing", "Went with competitor", etc. |
| is_active | BOOLEAN DEFAULT true | |
| display_order | INTEGER NOT NULL | |

#### `public.saved_reports`

| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| name | VARCHAR(255) NOT NULL | |
| entity | ENUM('deals','contacts','activities','tasks') NOT NULL | |
| config | JSONB NOT NULL | `{ filters: [], columns: [], sort: {}, chart_type: "" }` |
| is_locked | BOOLEAN DEFAULT false | true = company-wide preset, users can't edit |
| is_default | BOOLEAN DEFAULT false | Shows on dashboard by default |
| created_by | UUID FK → users.id | NULL for system presets |
| office_id | UUID FK → offices.id | NULL = available to all offices |
| visibility | ENUM('private','office','company') DEFAULT 'private' | |
| created_at | TIMESTAMPTZ NOT NULL DEFAULT NOW() | |
| updated_at | TIMESTAMPTZ NOT NULL DEFAULT NOW() | |

Report config is structured JSON — same shape scales to a visual query builder in the future.

#### `public.user_graph_tokens`

Per-user Microsoft Graph API token storage for email sync worker.

| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| user_id | UUID FK → users.id UNIQUE NOT NULL | One token set per user |
| access_token | TEXT NOT NULL | Encrypted at rest |
| refresh_token | TEXT NOT NULL | Encrypted at rest |
| token_expires_at | TIMESTAMPTZ NOT NULL | |
| scopes | TEXT[] NOT NULL | Granted Graph API scopes |
| subscription_id | VARCHAR(255) | MS Graph webhook subscription ID |
| subscription_expires_at | TIMESTAMPTZ | Webhook subscriptions expire after 3 days — worker renews |
| last_delta_link | TEXT | MS Graph delta sync cursor |
| status | ENUM('active','expired','revoked','reauth_needed') DEFAULT 'active' | |
| last_sync_at | TIMESTAMPTZ | |
| error_message | TEXT | Last sync error for diagnostics |
| created_at | TIMESTAMPTZ NOT NULL DEFAULT NOW() | |
| updated_at | TIMESTAMPTZ NOT NULL DEFAULT NOW() | |

Token lifecycle:
- Tokens acquired during OAuth flow and stored encrypted
- Worker refreshes access tokens automatically using refresh token before expiry
- If refresh fails (revoked consent, password change), status set to `reauth_needed` and notification sent to user
- Admin dashboard shows token health per user

#### `public.job_queue`

Outbox pattern for cross-process event durability. API writes jobs, Worker polls and processes.

| Column | Type | Notes |
|--------|------|-------|
| id | BIGSERIAL PK | |
| job_type | VARCHAR(100) NOT NULL | 'procore_create_project', 'email_sync', 'send_alert', etc. |
| payload | JSONB NOT NULL | Event-specific data |
| office_id | UUID FK → offices.id | |
| status | ENUM('pending','processing','completed','failed','dead') DEFAULT 'pending' | |
| attempts | INTEGER DEFAULT 0 | |
| max_attempts | INTEGER DEFAULT 3 | |
| last_error | TEXT | |
| run_after | TIMESTAMPTZ NOT NULL DEFAULT NOW() | For delayed/retry scheduling |
| created_at | TIMESTAMPTZ NOT NULL DEFAULT NOW() | |
| completed_at | TIMESTAMPTZ | |
| **INDEX ON (status, run_after) WHERE status = 'pending'** | | Worker poll query |

#### `public.procore_sync_state`

| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| entity_type | ENUM('project','bid','change_order','contact') NOT NULL | |
| procore_id | BIGINT NOT NULL | |
| crm_entity_type | VARCHAR(50) NOT NULL | 'deal', 'contact', 'change_order' |
| crm_entity_id | UUID NOT NULL | |
| office_id | UUID FK → offices.id NOT NULL | |
| sync_direction | ENUM('crm_to_procore','procore_to_crm','bidirectional') NOT NULL | |
| last_synced_at | TIMESTAMPTZ | |
| last_procore_updated_at | TIMESTAMPTZ | From Procore's updated_at |
| last_crm_updated_at | TIMESTAMPTZ | |
| sync_status | ENUM('synced','pending','conflict','error') DEFAULT 'synced' | |
| conflict_data | JSONB | `{ field: "status", crm: "In Production", procore: "Active" }` |
| error_message | TEXT | |
| created_at | TIMESTAMPTZ NOT NULL DEFAULT NOW() | |
| updated_at | TIMESTAMPTZ NOT NULL DEFAULT NOW() | |
| **UNIQUE(entity_type, procore_id, office_id)** | | Scoped per office to handle overlapping Procore IDs across offices |
| **INDEX ON (sync_status) WHERE sync_status != 'synced'** | | Quick find out-of-sync |

#### `public.procore_webhook_log`

| Column | Type | Notes |
|--------|------|-------|
| id | BIGSERIAL PK | |
| event_type | VARCHAR(100) NOT NULL | "projects.update", "change_orders.create" |
| resource_id | BIGINT NOT NULL | |
| payload | JSONB NOT NULL | |
| processed | BOOLEAN DEFAULT false | |
| processed_at | TIMESTAMPTZ | |
| error_message | TEXT | |
| received_at | TIMESTAMPTZ NOT NULL DEFAULT NOW() | |
| **INDEX ON (processed, received_at)** | | Unprocessed webhook queue |

---

### 4.2 Per-Office Schema (`office_{slug}`)

These tables are duplicated in every office schema. Migration runner creates them automatically when a new office is provisioned.

#### `office_{slug}.deals`

| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| deal_number | VARCHAR(50) UNIQUE NOT NULL | Auto-generated or manual |
| name | VARCHAR(500) NOT NULL | |
| stage_id | UUID FK → public.pipeline_stage_config.id NOT NULL | |
| assigned_rep_id | UUID FK → public.users.id NOT NULL | |
| primary_contact_id | UUID FK → contacts.id | |
| **Estimates** | | |
| dd_estimate | NUMERIC(14,2) | Due Diligence estimate |
| bid_estimate | NUMERIC(14,2) | Bid/proposal amount |
| awarded_amount | NUMERIC(14,2) | Contract awarded value |
| change_order_total | NUMERIC(14,2) DEFAULT 0 | Denormalized SUM from change_orders, updated by trigger |
| current_contract_value | NUMERIC(14,2) GENERATED ALWAYS AS (COALESCE(awarded_amount, 0) + change_order_total) STORED | |
| **Metadata** | | |
| description | TEXT | |
| property_address | TEXT | |
| property_city | VARCHAR(255) | |
| property_state | VARCHAR(2) | |
| property_zip | VARCHAR(10) | |
| project_type_id | UUID FK → public.project_type_config.id | Locked dropdown — "Multifamily > Student Housing", "Commercial > New Construction", etc. |
| region_id | UUID FK → public.region_config.id | Auto-suggested from property_state, manually overridable |
| source | VARCHAR(100) | "Bid Board", "Referral", "Cold Call", etc. |
| win_probability | INTEGER | 0-100, used for weighted pipeline forecasting |
| **Procore** | | |
| procore_project_id | BIGINT | Linked Procore project (NULL until won) |
| procore_bid_id | BIGINT | Linked Bid Board item |
| procore_last_synced_at | TIMESTAMPTZ | |
| **Lost Deal** | | |
| lost_reason_id | UUID FK → public.lost_deal_reasons.id | Required when stage = Closed Lost |
| lost_notes | TEXT | Required free-text when stage = Closed Lost |
| lost_competitor | VARCHAR(255) | Competitor who won the deal (optional) |
| lost_at | TIMESTAMPTZ | |
| **Lifecycle** | | |
| expected_close_date | DATE | |
| actual_close_date | DATE | |
| last_activity_at | TIMESTAMPTZ | Updated on any deal activity |
| stage_entered_at | TIMESTAMPTZ NOT NULL DEFAULT NOW() | Reset on stage change, used for stale alerts |
| is_active | BOOLEAN DEFAULT true | |
| created_at | TIMESTAMPTZ NOT NULL DEFAULT NOW() | |
| updated_at | TIMESTAMPTZ NOT NULL DEFAULT NOW() | |
| **Migration** | | |
| hubspot_deal_id | VARCHAR(50) | Preserved for traceability |

#### `office_{slug}.deal_stage_history`

Written by PG trigger on `deals.stage_id` change.

| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| deal_id | UUID FK → deals.id NOT NULL | |
| from_stage_id | UUID FK → public.pipeline_stage_config.id | NULL on first stage |
| to_stage_id | UUID FK → public.pipeline_stage_config.id NOT NULL | |
| changed_by | UUID FK → public.users.id NOT NULL | |
| is_backward_move | BOOLEAN DEFAULT false | |
| is_director_override | BOOLEAN DEFAULT false | |
| override_reason | TEXT | Required when is_director_override = true |
| duration_in_previous_stage | INTERVAL | Computed from deal.stage_entered_at |
| created_at | TIMESTAMPTZ NOT NULL DEFAULT NOW() | |

#### `office_{slug}.change_orders`

| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| deal_id | UUID FK → deals.id NOT NULL | |
| co_number | INTEGER NOT NULL | Sequential per deal |
| title | VARCHAR(500) NOT NULL | |
| amount | NUMERIC(14,2) NOT NULL | Positive = addition, negative = deduction |
| status | ENUM('pending','approved','rejected') DEFAULT 'pending' | |
| procore_co_id | BIGINT | Linked Procore change order |
| approved_at | TIMESTAMPTZ | |
| created_at | TIMESTAMPTZ NOT NULL DEFAULT NOW() | |
| updated_at | TIMESTAMPTZ NOT NULL DEFAULT NOW() | |
| **UNIQUE(deal_id, co_number)** | | |

PG trigger: On INSERT/UPDATE/DELETE of change_orders, recalculate `deals.change_order_total` = SUM of approved COs.

#### `office_{slug}.deal_approvals`

| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| deal_id | UUID FK → deals.id NOT NULL | |
| target_stage_id | UUID FK → public.pipeline_stage_config.id NOT NULL | |
| required_role | ENUM('admin','director') NOT NULL | Which role must approve |
| requested_by | UUID FK → public.users.id NOT NULL | |
| approved_by | UUID FK → public.users.id | Must have the `required_role` |
| status | ENUM('pending','approved','rejected') DEFAULT 'pending' | |
| notes | TEXT | |
| created_at | TIMESTAMPTZ NOT NULL DEFAULT NOW() | |
| resolved_at | TIMESTAMPTZ | |
| **UNIQUE(deal_id, target_stage_id, required_role)** | | One approval per role per stage transition |

#### `office_{slug}.contacts`

| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| first_name | VARCHAR(255) NOT NULL | |
| last_name | VARCHAR(255) NOT NULL | |
| email | VARCHAR(255) | UNIQUE within schema (partial: WHERE email IS NOT NULL). Hard-block on duplicate. |
| phone | VARCHAR(20) | |
| mobile | VARCHAR(20) | |
| company_name | VARCHAR(500) | |
| job_title | VARCHAR(255) | |
| category | ENUM('client','subcontractor','architect','property_manager','regional_manager','vendor','consultant','influencer','other') NOT NULL | |
| address | TEXT | |
| city | VARCHAR(255) | |
| state | VARCHAR(2) | |
| zip | VARCHAR(10) | |
| notes | TEXT | |
| **Touchpoints** | | |
| touchpoint_count | INTEGER DEFAULT 0 | Denormalized, updated by trigger on activities |
| last_contacted_at | TIMESTAMPTZ | |
| first_outreach_completed | BOOLEAN DEFAULT false | false triggers touchpoint alert |
| **External IDs** | | |
| procore_contact_id | BIGINT | |
| hubspot_contact_id | VARCHAR(50) | Migration traceability |
| **Dedup** | | |
| normalized_name | VARCHAR(510) GENERATED ALWAYS AS (LOWER(TRIM(first_name \|\| ' ' \|\| last_name))) STORED | |
| normalized_phone | VARCHAR(20) | Digits only, set by trigger |
| **Standard** | | |
| is_active | BOOLEAN DEFAULT true | |
| created_at | TIMESTAMPTZ NOT NULL DEFAULT NOW() | |
| updated_at | TIMESTAMPTZ NOT NULL DEFAULT NOW() | |
| **INDEX ON (normalized_name, company_name)** | | Fuzzy dedup scan |

#### `office_{slug}.contact_deal_associations`

Many-to-many: a contact can be on multiple deals, a deal has multiple contacts.

| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| contact_id | UUID FK → contacts.id NOT NULL | |
| deal_id | UUID FK → deals.id NOT NULL | |
| role | VARCHAR(100) | "Decision Maker", "Site Contact", "Estimator" |
| is_primary | BOOLEAN DEFAULT false | |
| created_at | TIMESTAMPTZ NOT NULL DEFAULT NOW() | |
| **UNIQUE(contact_id, deal_id)** | | |

#### `office_{slug}.duplicate_queue`

Populated by worker's background fuzzy dedup scan.

| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| contact_a_id | UUID FK → contacts.id NOT NULL | |
| contact_b_id | UUID FK → contacts.id NOT NULL | |
| match_type | ENUM('exact_email','fuzzy_name','fuzzy_phone','company_match') NOT NULL | |
| confidence_score | NUMERIC(3,2) | 0.00 to 1.00 |
| status | ENUM('pending','merged','dismissed') DEFAULT 'pending' | |
| resolved_by | UUID FK → public.users.id | |
| created_at | TIMESTAMPTZ NOT NULL DEFAULT NOW() | |
| resolved_at | TIMESTAMPTZ | |
| **UNIQUE(contact_a_id, contact_b_id)** | | |

#### `office_{slug}.emails`

Synced from MS Graph API (matched contacts only).

| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| graph_message_id | VARCHAR(500) UNIQUE NOT NULL | MS Graph message ID — dedup key |
| graph_conversation_id | VARCHAR(500) | Thread grouping |
| direction | ENUM('inbound','outbound') NOT NULL | |
| from_address | VARCHAR(255) NOT NULL | |
| to_addresses | TEXT[] NOT NULL | |
| cc_addresses | TEXT[] | |
| subject | VARCHAR(1000) | |
| body_preview | VARCHAR(500) | First 500 chars for list views |
| body_html | TEXT | |
| has_attachments | BOOLEAN DEFAULT false | |
| **Associations** | | |
| contact_id | UUID FK → contacts.id | Matched by email address |
| deal_id | UUID FK → deals.id | Auto-matched via contact's active deals |
| user_id | UUID FK → public.users.id NOT NULL | Rep whose mailbox this came from |
| sent_at | TIMESTAMPTZ NOT NULL | |
| synced_at | TIMESTAMPTZ NOT NULL DEFAULT NOW() | |

Email auto-association logic:
- Inbound emails matched to contacts by `from_address` → `contacts.email`
- If contact has **exactly 1 active deal** → auto-associate to that deal
- If contact has **multiple active deals** → leave `deal_id` NULL, create a task for the rep to manually associate ("Email from [contact] — assign to correct deal")
- If contact has **no active deals** → associate to contact only, no deal link
- Manual reassignment always available on any email record

#### `office_{slug}.activities`

Unified activity feed: calls, notes, meetings, emails, tasks completed.

| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| type | ENUM('call','note','meeting','email','task_completed') NOT NULL | |
| user_id | UUID FK → public.users.id NOT NULL | Who performed it |
| deal_id | UUID FK → deals.id | |
| contact_id | UUID FK → contacts.id | |
| email_id | UUID FK → emails.id | For type='email', links to full email record |
| subject | VARCHAR(500) | |
| body | TEXT | Call notes, meeting notes, etc. |
| outcome | VARCHAR(100) | For calls: "Connected", "Left Voicemail", "No Answer", "Scheduled Meeting" |
| duration_minutes | INTEGER | For calls/meetings |
| occurred_at | TIMESTAMPTZ NOT NULL DEFAULT NOW() | |
| created_at | TIMESTAMPTZ NOT NULL DEFAULT NOW() | |
| **INDEX ON (user_id, occurred_at DESC)** | | Rep activity feed |
| **INDEX ON (deal_id, occurred_at DESC)** | | Deal timeline |
| **INDEX ON (contact_id, occurred_at DESC)** | | Contact history |

#### `office_{slug}.files`

Unified table for photos, documents, contracts — with full-text search, tagging, and virtual folders.

| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| **Classification** | | |
| category | ENUM('photo','contract','rfp','estimate','change_order','proposal','permit','inspection','correspondence','insurance','warranty','closeout','other') NOT NULL | |
| subcategory | VARCHAR(100) | "Site Visit", "Progress", "Final Walkthrough", "Damage" |
| folder_path | VARCHAR(1000) | Virtual folder: "Photos/Site Visits/2026-04" |
| tags | TEXT[] DEFAULT '{}' | ["exterior", "roof", "before-photo", "client-approved"] |
| display_name | VARCHAR(500) NOT NULL | Human-readable, auto-generated or user-set |
| **Naming** | | |
| system_filename | VARCHAR(500) NOT NULL | `{DealNumber}_{Category}_{Date}_{Seq}.{ext}` |
| original_filename | VARCHAR(500) NOT NULL | What the user uploaded |
| **File Details** | | |
| mime_type | VARCHAR(100) NOT NULL | |
| file_size_bytes | BIGINT NOT NULL | |
| file_extension | VARCHAR(20) NOT NULL | ".pdf", ".jpg", ".xlsx" |
| r2_key | VARCHAR(1000) UNIQUE NOT NULL | Cloudflare R2 object key |
| r2_bucket | VARCHAR(100) NOT NULL | |
| **Associations** | | |
| deal_id | UUID FK → deals.id | |
| contact_id | UUID FK → contacts.id | |
| procore_project_id | BIGINT | For project-level files not tied to a deal |
| change_order_id | UUID FK → change_orders.id | For CO-specific docs |
| **Metadata** | | |
| description | TEXT | |
| notes | TEXT | Internal notes |
| version | INTEGER DEFAULT 1 | For revised documents |
| parent_file_id | UUID FK → files.id | Links revisions to original |
| taken_at | TIMESTAMPTZ | Photo EXIF timestamp |
| geo_lat | NUMERIC(10,7) | Photo GPS from EXIF |
| geo_lng | NUMERIC(10,7) | |
| **Search** | | |
| search_vector | TSVECTOR GENERATED ALWAYS AS (weighted: display_name A, description+tags B, notes C) STORED | |
| **Standard** | | |
| uploaded_by | UUID FK → public.users.id NOT NULL | |
| is_active | BOOLEAN DEFAULT true | |
| created_at | TIMESTAMPTZ NOT NULL DEFAULT NOW() | |
| updated_at | TIMESTAMPTZ NOT NULL DEFAULT NOW() | |
| **INDEX GIN ON (search_vector)** | | Full-text search |
| **INDEX GIN ON (tags)** | | Tag filtering |
| **INDEX ON (deal_id, category, created_at DESC)** | | Deal file browser |
| **INDEX ON (folder_path, display_name)** | | Folder navigation |
| **CHECK (deal_id IS NOT NULL OR contact_id IS NOT NULL OR procore_project_id IS NOT NULL OR change_order_id IS NOT NULL)** | | No orphan files |

**Auto-Naming Convention:**
- Pattern: `{DealNumber}_{Category}_{YYYY-MM-DD}_{Seq}.{ext}`
- Example: `TR-2026-0142_Photo_2026-04-15_001.jpg`
- R2 key: `office_dallas/deals/TR-2026-0142/photos/TR-2026-0142_Photo_2026-04-15_001.jpg`

**Virtual Folder Structure (per deal):**
```
Photos/ → Site Visits/ | Progress/ | Final Walkthrough/ | Damage/
Estimates/ → DD Estimate/ | Bid Estimate/ | Revisions/
Contracts/
RFPs/
Change Orders/
Permits & Inspections/
Correspondence/
Closeout/
```

#### `office_{slug}.tasks`

| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| title | VARCHAR(500) NOT NULL | |
| description | TEXT | |
| type | ENUM('follow_up','stale_deal','inbound_email','approval_request','touchpoint','manual','system') NOT NULL | |
| priority | ENUM('urgent','high','normal','low') DEFAULT 'normal' | |
| status | ENUM('pending','in_progress','completed','dismissed') DEFAULT 'pending' | |
| assigned_to | UUID FK → public.users.id NOT NULL | |
| created_by | UUID FK → public.users.id | NULL for system-generated tasks |
| deal_id | UUID FK → deals.id | |
| contact_id | UUID FK → contacts.id | |
| email_id | UUID FK → emails.id | For inbound_email type |
| due_date | DATE | |
| due_time | TIME | |
| remind_at | TIMESTAMPTZ | |
| completed_at | TIMESTAMPTZ | |
| is_overdue | BOOLEAN DEFAULT false | Updated by daily task generation job and on task status change |
| created_at | TIMESTAMPTZ NOT NULL DEFAULT NOW() | |
| updated_at | TIMESTAMPTZ NOT NULL DEFAULT NOW() | |
| **INDEX ON (assigned_to, status, due_date)** | | Daily task list query |
| **INDEX ON (assigned_to, status, priority)** | | Prioritized view |

#### `office_{slug}.notifications`

SSE-delivered, persisted for notification center.

| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| user_id | UUID FK → public.users.id NOT NULL | |
| type | ENUM('stale_deal','inbound_email','task_assigned','approval_needed','activity_drop','deal_won','deal_lost','stage_change','system') NOT NULL | |
| title | VARCHAR(500) NOT NULL | |
| body | TEXT | |
| link | VARCHAR(1000) | Deep link to relevant CRM page |
| is_read | BOOLEAN DEFAULT false | |
| read_at | TIMESTAMPTZ | |
| created_at | TIMESTAMPTZ NOT NULL DEFAULT NOW() | |
| **INDEX ON (user_id, is_read, created_at DESC)** | | Unread notifications query |

#### `office_{slug}.audit_log`

Append-only. Written by PG triggers. No UPDATE or DELETE grants.

| Column | Type | Notes |
|--------|------|-------|
| id | BIGSERIAL PK | Bigint for high volume |
| table_name | VARCHAR(100) NOT NULL | |
| record_id | UUID NOT NULL | |
| action | ENUM('insert','update','delete') NOT NULL | |
| changed_by | UUID | Set via `SET LOCAL app.current_user_id` |
| changes | JSONB NOT NULL | `{ "field": { "old": "X", "new": "Y" } }` for updates |
| full_row | JSONB | Full row snapshot on insert/delete |
| ip_address | INET | |
| user_agent | VARCHAR(500) | |
| created_at | TIMESTAMPTZ NOT NULL DEFAULT NOW() | |
| **INDEX ON (table_name, record_id, created_at DESC)** | | Record history |
| **INDEX ON (changed_by, created_at DESC)** | | User activity audit |
| **INDEX ON (created_at)** | | Time-based queries, partition candidate |

---

### 4.3 Migration Schema (`migration`)

Temporary schema for HubSpot data migration. Dropped after go-live validation.

#### `migration.staged_deals`

| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| hubspot_deal_id | VARCHAR(50) UNIQUE NOT NULL | |
| raw_data | JSONB NOT NULL | Full HubSpot API response preserved |
| mapped_name | VARCHAR(500) | |
| mapped_stage | VARCHAR(100) | |
| mapped_rep_email | VARCHAR(255) | |
| mapped_amount | NUMERIC(14,2) | |
| mapped_close_date | DATE | |
| mapped_source | VARCHAR(100) | |
| validation_status | ENUM('pending','valid','invalid','needs_review','approved','rejected') DEFAULT 'pending' | |
| validation_errors | JSONB DEFAULT '[]' | `[{ "field": "stage", "error": "Unknown stage: Negotiation" }]` |
| validation_warnings | JSONB DEFAULT '[]' | |
| reviewed_by | UUID FK → public.users.id | |
| review_notes | TEXT | |
| promoted_at | TIMESTAMPTZ | NULL until promoted to live |
| promoted_deal_id | UUID | FK to live deal after promotion |
| created_at | TIMESTAMPTZ NOT NULL DEFAULT NOW() | |

#### `migration.staged_contacts`

| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| hubspot_contact_id | VARCHAR(50) UNIQUE NOT NULL | |
| raw_data | JSONB NOT NULL | |
| mapped_first_name | VARCHAR(255) | |
| mapped_last_name | VARCHAR(255) | |
| mapped_email | VARCHAR(255) | |
| mapped_phone | VARCHAR(20) | |
| mapped_company | VARCHAR(500) | |
| mapped_category | VARCHAR(100) | |
| duplicate_of_staged_id | UUID FK → staged_contacts.id | Links to first occurrence |
| duplicate_of_live_id | UUID | If matches existing CRM contact |
| duplicate_confidence | NUMERIC(3,2) | |
| validation_status | ENUM('pending','valid','invalid','duplicate','needs_review','approved','rejected','merged') DEFAULT 'pending' | |
| validation_errors | JSONB DEFAULT '[]' | |
| validation_warnings | JSONB DEFAULT '[]' | |
| reviewed_by | UUID FK → public.users.id | |
| merge_target_id | UUID | Which contact to merge into |
| promoted_at | TIMESTAMPTZ | |
| promoted_contact_id | UUID | |
| created_at | TIMESTAMPTZ NOT NULL DEFAULT NOW() | |

#### `migration.staged_activities`

| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| hubspot_activity_id | VARCHAR(50) UNIQUE NOT NULL | |
| hubspot_deal_id | VARCHAR(50) | For association mapping |
| hubspot_contact_id | VARCHAR(50) | |
| raw_data | JSONB NOT NULL | |
| mapped_type | VARCHAR(50) | call, note, meeting, email, task_completed |
| mapped_subject | VARCHAR(500) | |
| mapped_body | TEXT | |
| mapped_occurred_at | TIMESTAMPTZ | |
| validation_status | ENUM('pending','valid','invalid','orphan','approved') DEFAULT 'pending' | |
| validation_errors | JSONB DEFAULT '[]' | |
| promoted_at | TIMESTAMPTZ | |
| created_at | TIMESTAMPTZ NOT NULL DEFAULT NOW() | |

#### `migration.import_runs`

| Column | Type | Notes |
|--------|------|-------|
| id | UUID PK | |
| type | ENUM('extract','validate','promote') NOT NULL | |
| status | ENUM('running','completed','failed','rolled_back') NOT NULL | |
| stats | JSONB NOT NULL | `{ total: 412, valid: 389, invalid: 8, needs_review: 15 }` |
| error_log | TEXT | |
| run_by | UUID FK → public.users.id NOT NULL | |
| started_at | TIMESTAMPTZ NOT NULL DEFAULT NOW() | |
| completed_at | TIMESTAMPTZ | |

**Migration Workflow:**
1. **Extract** — Pull from HubSpot API → staging tables (raw_data preserved)
2. **Validate** — Auto-checks (unknown stages, $0 amounts, missing reps, duplicate contacts) + team review via validation UI
3. **Promote** — Approved records inserted into live CRM schema. `promoted_*_id` links back for rollback traceability.

---

### 4.4 PostgreSQL Triggers

All triggers are installed per-office schema by the migration runner.

| Trigger | Table | Fires On | Action |
|---------|-------|----------|--------|
| audit_log_trigger | All audited tables | BEFORE INSERT/UPDATE/DELETE | Writes field-level changes to `audit_log`. Reads `app.current_user_id` for attribution. |
| updated_at_trigger | All tables with `updated_at` | BEFORE UPDATE | Sets `updated_at = NOW()` |
| change_order_total_trigger | change_orders | AFTER INSERT/UPDATE/DELETE | Recalculates `deals.change_order_total` = SUM(amount) WHERE status = 'approved' |
| stage_history_trigger | deals | AFTER UPDATE OF stage_id | Inserts row into `deal_stage_history`, computes `duration_in_previous_stage` |
| stage_entered_at_trigger | deals | BEFORE UPDATE OF stage_id | Resets `deals.stage_entered_at = NOW()` |
| touchpoint_trigger | activities | AFTER INSERT WHERE type IN ('call','email','meeting') | Increments `contacts.touchpoint_count`, updates `last_contacted_at`, sets `first_outreach_completed = true`. Only fires for outreach activities — notes and task completions do not count as touchpoints. |
| normalized_phone_trigger | contacts | BEFORE INSERT/UPDATE OF phone, mobile | Strips non-digit characters, stores in `normalized_phone` |

---

## 5. Authentication & Authorization

### Authentication Flow

1. User navigates to `/login`
2. Redirect to Microsoft Entra ID authorization endpoint
3. User authenticates with T Rock's Microsoft 365 credentials
4. Callback to `/auth/callback` with authorization code
5. Server exchanges code for access token + ID token
6. Server looks up user by `azure_ad_id` in `public.users`
7. Server issues JWT with claims: `{ userId, officeId, role, email }`
8. JWT stored in httpOnly secure cookie

**Dev Mode:** When `AZURE_CLIENT_ID` is not set, login page shows a user picker dropdown (same pattern as SkyGuard).

### Authorization (RBAC)

| Action | Admin | Director | Rep |
|--------|-------|----------|-----|
| View own deals | Yes | Yes | Yes |
| View all deals in office | Yes | Yes | No |
| View all offices | Yes | No | No |
| Create/edit deals | Yes | Yes | Yes |
| Advance deal stage | Yes | Yes | Yes (with gates) |
| Move deal backward | Yes | Yes | No |
| Override stage gates | Yes | Yes | No |
| View director dashboard | Yes | Yes | No |
| Manage users | Yes | No | No |
| Manage offices | Yes | No | No |
| Configure pipeline | Yes | No | No |
| Run migration | Yes | No | No |
| View audit log | Yes | Yes | No |
| Create locked reports | Yes | No | No |
| Switch offices | Yes | Yes (if granted) | No |

---

## 6. Stage Gate Validation

When a rep attempts to advance a deal to the next stage:

1. API looks up target stage's `required_fields`, `required_documents`, `required_approvals` from `pipeline_stage_config`
2. Checks each requirement against the deal record:
   - **Required fields:** Are all listed fields non-null on the deal?
   - **Required documents:** Does the deal have at least one file with each required category?
   - **Required approvals:** Is there an approved `deal_approval` record for this stage?
3. If any requirement is unmet:
   - **Rep:** Request blocked. UI shows checklist of missing items.
   - **Director:** Override available. Must provide reason (logged in `deal_stage_history.override_reason`).
4. **Backward moves:** API compares `display_order` of current vs. target stage. If target < current:
   - **Rep:** Blocked entirely.
   - **Director:** Allowed with logged reason.
5. **Terminal stages:**
   - **Closed Won:** Sets `actual_close_date = NOW()`, emits `deal.won`
   - **Closed Lost:** Requires `lost_reason_id` + `lost_notes` (enforced by UI modal and API validation, with PG CHECK as safety net). Sets `lost_at = NOW()`, emits `deal.lost`.

---

## 7. Procore Integration

### Source of Truth Boundaries

The CRM and Procore each own different domains:

| Domain | Authority | Direction |
|--------|-----------|-----------|
| Deal stage, pipeline position, estimates | CRM | CRM → Procore |
| Deal contacts, assigned rep, lost reason | CRM | CRM only (not synced) |
| Project status, schedule, budget | Procore | Procore → CRM (read) |
| Change orders (amounts, approval status) | Procore | Procore → CRM (read) |
| Project creation from won deals | CRM | CRM → Procore (write) |
| Bid Board opportunities | SyncHub | SyncHub → CRM (push) |
| Contact company/address/phone | CRM | CRM only |

When a field has a conflict, the authority system wins. `procore_sync_state.conflict_data` records the divergence for admin review but does not auto-overwrite.

### CRM as Deal Authority

The CRM replaces SyncHub's deal management functions. SyncHub continues handling Bid Board automation (Playwright-based Excel export polling) and feeds new opportunities into the CRM via a dedicated internal REST API endpoint (`POST /api/integrations/synchub/opportunities`). This is a one-way push from SyncHub to CRM — the CRM does not read from SyncHub's database.

### Sync Flows

| Direction | Trigger | Data |
|-----------|---------|------|
| Procore → CRM | Webhook + periodic poll | Project status changes, change orders, contact updates |
| CRM → Procore | Event bus: `deal.won` | Create Procore project from won deal |
| CRM → Procore | Event bus: `deal.stage.changed` | Update Procore project status (with stage mapping guardrails) |
| SyncHub → CRM | Internal API | New Bid Board opportunities |

### Stage Mapping Guardrails

The `pipeline_stage_config.procore_stage_mapping` field defines valid CRM-to-Procore stage translations. When syncing:

1. Look up the Procore stage mapping for the CRM stage
2. If mapping exists, update Procore project status
3. If no mapping, skip the Procore update (don't sync unmapped stages)
4. Log every sync attempt in `procore_sync_state`

This prevents the "Closed Won incident" — incorrect stage mappings are caught at the config level, not at runtime.

### Conflict Detection

`procore_sync_state` tracks `last_procore_updated_at` and `last_crm_updated_at`. If both timestamps are newer than `last_synced_at`, it's a conflict:

- `sync_status` set to `'conflict'`
- `conflict_data` stores the divergent values
- Surfaced in admin dashboard for manual resolution
- No automatic overwrites on conflicts

---

## 8. Email Integration (Microsoft Graph API)

### Outbound

1. User composes email in CRM, selects deal/contact association
2. API calls MS Graph `sendMail` endpoint using the rep's delegated permissions
3. Email record created in `emails` table with `direction = 'outbound'`
4. Event bus emits `email.sent` → activity logged, touchpoint updated

### Inbound Sync

1. Worker runs delta sync every 5 minutes via MS Graph `delta` endpoint
2. For each new email in a rep's inbox:
   - Match `from_address` against `contacts.email`
   - If match found: store email, associate to contact and most recent active deal
   - If no match: skip (selective sync — only CRM-relevant emails)
3. Event bus emits `email.received` → task created on rep's daily list

### Webhook Subscriptions

MS Graph webhooks notify the CRM of new inbound emails in near real-time. The worker's 5-minute delta sync serves as the reliability fallback — webhooks are best-effort, delta sync is guaranteed.

### Thread Grouping

`graph_conversation_id` groups emails into threads. UI shows full thread history on deal and contact records.

---

## 9. Contact Deduplication

### Pre-Creation (Real-Time)

1. User creates new contact
2. API checks for exact email match — if found, **hard block** (must use existing contact)
3. API checks for fuzzy matches (normalized name + company) — if found, **suggestions** shown (user decides)
4. Contact created if no hard block

### Background Scan (Weekly)

Worker runs fuzzy dedup scan across all contacts per office:

1. Compare `normalized_name` pairs using Levenshtein distance
2. Compare `normalized_phone` for digit-sequence matches
3. Compare `company_name` with case-insensitive normalization
4. Score each potential duplicate (0.00 to 1.00 confidence)
5. Insert into `duplicate_queue` for team review

### Merge Workflow

1. Admin/director selects two duplicate contacts from merge queue
2. Choose primary record (winner)
3. All associations (deals, emails, activities, files) transferred to winner
4. Loser soft-deleted (`is_active = false`)
5. Audit trail records the merge

---

## 10. Reporting & Dashboards

### Locked Company Reports (Preset)

Consistent across all users. Cannot be edited. Examples:

- Pipeline Summary (by stage, excluding DD)
- Pipeline Summary (with DD)
- Weighted Pipeline Forecast (deal value × win_probability, grouped by expected close month)
- Win/Loss Ratio by Rep (monthly)
- Activity Summary by Rep (weekly)
- Stale Deals Report
- Lost Deals by Reason (with competitor breakdown)
- Revenue by Project Type
- Lead Source ROI (deals won and pipeline value by source)

### Per-Rep Dashboard (`/`)

- My active deals (count + total value)
- My tasks today (overdue highlighted)
- My activity this week (calls, emails, tasks)
- My follow-up compliance rate
- My pipeline chart (deals by stage)

### Director Dashboard (`/director`)

- All reps: performance cards (active deals, pipeline value, win rate, activity score)
- Click to drill into any rep
- Pipeline by stage (bar chart)
- Win rate trend (line chart)
- Activity by rep (bar chart)
- MoM / QoQ / YoY toggle on all charts
- Stale deal watchlist
- Activity drop alerts
- DD vs. true pipeline value comparison

### Custom Reports (Saved Filter Presets)

Users create reports by:
1. Selecting entity (deals, contacts, activities, tasks)
2. Adding filters (date range, stage, rep, office, project type, etc.)
3. Choosing columns to display
4. Selecting chart type (table, bar, pie, line)
5. Saving with a name

Config stored as JSON in `saved_reports.config`:
```json
{
  "entity": "deals",
  "filters": [
    { "field": "stage_id", "op": "in", "value": ["uuid1", "uuid2"] },
    { "field": "created_at", "op": "gte", "value": "2026-01-01" }
  ],
  "columns": ["name", "stage", "assigned_rep", "awarded_amount", "days_in_stage"],
  "sort": { "field": "awarded_amount", "dir": "desc" },
  "chart_type": "bar"
}
```

This JSON shape is designed to scale to a visual drag-and-drop query builder in the future without schema changes.

---

## 11. Frontend Structure

### Layout

- **Desktop:** Collapsible sidebar (nav modules, office switcher, admin section), top bar (global search Cmd+K, notification bell with SSE badge, user avatar)
- **Mobile:** Hamburger menu → slide-out sidebar. Bottom nav: Dashboard, Pipeline, Tasks, Email, More. Minimum 44x44px touch targets.

### Default Date & Filter Behavior

All views default to sensible, current-focused ranges — never "since inception":

- **Dashboards:** Default to current calendar year. YTD metrics shown by default.
- **Pipeline views:** Show active deals only (non-terminal stages). DD separated by toggle.
- **Reports:** Default date range = current calendar year. User can change but saved preset overrides.
- **Deal lists:** Default to active deals sorted by last activity. No closed/lost deals shown unless filtered.
- **Activity views:** Default to last 30 days.
- Filter selections persist per-user per-view in localStorage. Unlike HubSpot, they don't reset on navigation.

### Route Map

**Rep Views:**
`/` (dashboard), `/pipeline` (kanban), `/deals` (list), `/deals/:id` (detail with tabs), `/deals/:id/files` (file browser), `/deals/new`, `/contacts` (directory), `/contacts/:id` (detail), `/email` (inbox), `/email/compose`, `/tasks` (daily list), `/projects` (Procore board), `/reports`

**Director Views:**
`/director` (all reps overview), `/director/rep/:id` (drill-down), `/director/approvals` (pending queue), `/director/pipeline` (full pipeline with DD separation), `/director/reports`

**Admin Views:**
`/admin/offices`, `/admin/users`, `/admin/pipeline` (stage config), `/admin/migration` (dashboard), `/admin/migration/deals`, `/admin/migration/contacts`, `/admin/procore` (sync status), `/admin/audit`

**Shared:**
`/notifications`, `/search`, `/settings`

### Key Components

- **Pipeline Kanban:** Drag-and-drop between stages with gate validation modals. Closed Won/Lost as separate section (not drag columns). DD vs. true pipeline toggle in column headers.
- **Deal Detail:** Tabbed (Overview/Files/Email/Timeline/History). Stage advancement button with gate checklist sidebar. Estimates card, contacts list, property info.
- **File Browser:** Virtual folder tree, drag-drop upload, tag editor, full-text search, version history. Auto-naming preview before upload.
- **Task List:** Sections (Overdue/Today/Upcoming/Completed). Auto-prioritized. Quick actions. Mobile swipe gestures.
- **Lost Deal Modal:** Auto-triggered on Closed Lost. Reason dropdown + competitor name + notes textarea. Cannot be dismissed without completing required fields.
- **Activity Logging Forms:** Quick-action forms accessible from deal detail and contact detail:
  - **Log Call:** Notes, duration, outcome dropdown (Connected / Left Voicemail / No Answer / Scheduled Meeting), associated deal/contact
  - **Log Note:** Free-text note, associated deal/contact
  - **Log Meeting:** Notes, duration, attendees, associated deal/contact
  - All three create an activity record and update touchpoint counters

---

## 12. Worker Jobs

| Job | Schedule | Action |
|-----|----------|--------|
| Email sync | Every 5 min | MS Graph delta query per rep, match to contacts, store emails |
| Procore sync | Every 15 min | Poll Procore for project/CO changes, update CRM records |
| Daily task generation | Daily 6am | Scan for overdue follow-ups, inbound emails, stale deals → create tasks |
| Stale deal scan | Daily 6am | Compare `stage_entered_at` against thresholds → create notifications |
| Activity drop detection | Daily 7am | Compare rep's last 7 days of activity against their 90-day rolling average. Flag if below 1 standard deviation. Alert sent to manager. |
| Contact dedup scan | Weekly | Fuzzy name/phone/company matching across all contacts per office |
| Audit log partition | Weekly | Check audit_log size, create new partitions as needed |

**On-Demand Jobs (triggered by API):**
- HubSpot migration extract
- Migration validation run
- Migration promotion
- Bulk data export

---

## 13. Deployment

### Railway Services

| Service | Root Directory | Port | Environment Variables |
|---------|---------------|------|----------------------|
| API | `server/` | 3001 | `DATABASE_URL`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TENANT_ID`, `PROCORE_CLIENT_ID`, `PROCORE_CLIENT_SECRET`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, `FRONTEND_URL`, `JWT_SECRET`, `RESEND_API_KEY`, `ENCRYPTION_KEY` |
| Worker | `worker/` | none (no HTTP) | Same DB + integration vars as API |
| Frontend | `client/` | 3000 | `VITE_API_URL` |

### Infrastructure Costs (T Rock pays)

| Service | Estimated Cost |
|---------|---------------|
| Railway hosting (3 services) | $20–$50/mo |
| Railway PostgreSQL | included |
| Cloudflare R2 (100 GB) | ~$1.50/mo |
| Transactional email — Resend ($0–$20/mo) | $0–$20/mo |
| **Total** | **$30–$85/mo** |

---

## 14. Data Migration Plan

### Phase 1: Extract
- Standalone script pulls from HubSpot API: deals, contacts, companies, activities, emails, notes
- Full API response preserved in `raw_data` JSONB
- Field mapping transforms to CRM schema shape
- Loaded into `migration` schema staging tables

**Entity mapping (HubSpot → CRM):**
- HubSpot Deals → `staged_deals` → `deals`
- HubSpot Contacts → `staged_contacts` → `contacts`
- HubSpot Companies → `staged_contacts.mapped_company` (no separate company entity — company name lives on the contact record)
- HubSpot Emails/Notes/Calls/Meetings → `staged_activities` (all mapped to the unified activity type system)
- HubSpot Deal-Contact Associations → `contact_deal_associations` (created during promotion phase)

### Phase 2: Validate
- Auto-validation checks:
  - Stage names map to CRM pipeline stages
  - Rep emails match CRM users
  - Deal amounts are non-zero
  - Contacts have at least email or phone
  - Duplicate contact detection (email + fuzzy name)
  - Orphan activities (reference deleted deals/contacts)
- Validation UI shows flagged records for team review
- Batch approve/reject/merge controls
- Stats tracked in `import_runs`

### Phase 3: Promote
- Approved records inserted into live `office_{slug}` schema
- `promoted_*_id` links preserved for rollback traceability
- Audit trail records the migration source

### Post-Go-Live
- Team validates live data during post-launch support week (May 15–22)
- Migration schema retained through stabilization period (minimum 30 days post-go-live)
- After stabilization confirmed, `DROP SCHEMA migration CASCADE` cleans up staging
- Raw HubSpot data archived as JSON export before schema drop (permanent backup)

---

## 15. Edge Cases & Guardrails

| Edge Case | How It's Handled |
|-----------|-----------------|
| DD deals counting toward pipeline totals | `pipeline_stage_config.is_active_pipeline = false` for DD. All pipeline queries filter on this flag. |
| Rep tries to move deal backward | API compares `display_order`. Blocks reps. Directors can override with logged reason. |
| Deal closed as lost without notes | API + PG CHECK require `lost_reason_id` AND `lost_notes`. UI modal cannot be dismissed without both. |
| Same email synced twice | `emails.graph_message_id` UNIQUE constraint. Dedup at database level. |
| Duplicate contact creation | Hard block on exact email match (partial unique index). Fuzzy suggestions on name/company. |
| Change order affects contract value | PG trigger recalculates `change_order_total`. Generated column `current_contract_value` is always correct. |
| Procore and CRM update same entity | `procore_sync_state` detects timestamp conflicts. Surfaced for manual resolution. No auto-overwrite. |
| Rep has no activity for days | Worker compares rolling baseline. Activity drop alert sent to all directors in the rep's office (users WHERE office_id = rep.office_id AND role IN ('director','admin')). |
| New contact has no outreach | `first_outreach_completed = false` keeps surfacing touchpoint alert until first activity logged. |
| HubSpot stage doesn't map to CRM | Validation auto-flags as error. Team manually maps or discards during migration review. |
| Procore webhooks sent twice | Application-level dedup: webhook handler checks `procore_webhook_log` for matching `event_type + resource_id` within a 60-second window before processing. Not a DB constraint — time-window logic handled in code. |
| File uploaded with no association | CHECK constraint requires at least one of deal_id, contact_id, procore_project_id, change_order_id. |
| Contact with multiple active deals receives email | Email left unassociated to deal. Task created for rep to manually assign to correct deal. |
| Closed deal needs to be reopened | Directors can move a Closed Won/Lost deal back to any active stage via backward move override. `lost_reason_id`, `lost_notes`, `lost_at`, `actual_close_date` cleared on reopen. Stage history records the reopen. |
| Merged contact has existing emails/tasks referencing it | Merge transfers all associations (emails, activities, tasks, files, deal associations) to the winner contact before soft-deleting the loser. FK references updated in a single transaction. |
| Document revised multiple times | `parent_file_id` + `version` chains revisions. UI shows latest by default, version history expandable. |
| Director needs to see all offices | `user_office_access` grants cross-office access. Cross-office queries use UNION ALL across schemas. |
| Migration data has bad records | 3-phase workflow: extract → validate → promote. Nothing goes live without team approval. |
| Schema drift between offices | Migration runner applies all migrations to all office schemas. New offices get full migration history on creation. |
| Audit log grows very large | BIGSERIAL PK, partitionable by `created_at`. Weekly partition check job on worker. |
| Em dash vs hyphen in Procore data | Normalize all string comparisons (learned from SyncHub Bid Board export issues). |

---

## 16. Security

- All API routes behind JWT authentication middleware
- httpOnly secure cookies for JWT storage (no localStorage)
- CSRF protection: `SameSite=Strict` cookie attribute + CORS origin whitelist (only `FRONTEND_URL`)
- Rate limiting: `express-rate-limit` — 100 req/min per user for API, 10 req/min for auth endpoints
- RBAC enforced at middleware level before route handlers
- Schema-per-office prevents data leakage between offices at DB level
- Presigned R2 URLs expire after 15 minutes, scoped to specific object keys (least-privilege)
- Audit log is append-only (no UPDATE/DELETE grants)
- `SET LOCAL app.current_user_id` scoped to transaction — can't leak between requests
- MS Graph API uses delegated permissions (user-scoped, not application-scoped)
- Graph/Procore tokens encrypted at rest in `user_graph_tokens` (AES-256-GCM via `ENCRYPTION_KEY` env var)
- Procore webhook signature verification: validate `X-Procore-Signature` header before processing
- Input validation on all API endpoints (dropdowns, required fields, max lengths)
- File upload MIME type validation — server verifies MIME matches extension, rejects mismatches
- No raw SQL interpolation — Drizzle parameterizes all queries

---

## 17. Testing Strategy

- **Unit tests:** Stage gate validation logic, email matching, dedup scoring, event handlers
- **Integration tests:** API routes with real PostgreSQL (test schema), Drizzle migrations
- **E2E tests:** Critical flows — deal creation → stage advancement → close, email send/receive, file upload
- **Migration tests:** Run extract/validate/promote against sample HubSpot data export
- **Manual testing:** 2-3 reps test live platform during Early May window

---

## 18. Timeline

| Milestone | Target Date |
|-----------|------------|
| SOW signed + deposit | This week (April 2026) |
| Database schema + migrations | April 7–11 |
| Auth + multi-office foundation | April 7–11 |
| Deal management + pipeline | April 14–18 |
| Contact directory + dedup | April 14–18 |
| Procore integration | April 21–25 |
| Email integration (MS Graph) | April 21–25 |
| Photo/file management | April 28 – May 2 |
| Tasks + notifications + alerts | April 28 – May 2 |
| Reporting + dashboards | May 5–9 |
| HubSpot migration + validation UI | May 5–9 |
| Sales team testing | May 5–12 |
| Data migration execution | May 8–12 |
| Go-live | May 15 |
| Post-launch support (3hr/day) | May 15–22 |
| HubSpot non-renewal | May 15 |

---

## 19. Transactional Email (System Alerts)

CRM-to-user email notifications (stale deal alerts, activity drop warnings, approval requests) are sent via **Resend** (transactional email provider). This is separate from the MS Graph integration which handles rep-to-client email.

- Stale deal alerts → email to rep + manager
- Activity drop alerts → email to manager
- Approval requests → email to director
- Task reminders → email to assigned rep
- Daily task digest → email to each rep (morning summary)

Resend is used because system alerts must send even if a rep's MS Graph token is expired or their mailbox is unavailable. Resend sends from a system address (e.g., `crm@trockconstruction.com`), not from individual rep mailboxes.

---

## 20. SyncHub v3 Integration Boundary

SyncHub v3 retains ownership of:
- Playwright-based Bid Board → Portfolio → Budget/Prime Contract automation pipeline
- Bid Board Excel export polling via `node-cron`
- All Playwright browser automation flows (Procore UI interactions)

The CRM does NOT inherit SyncHub's Playwright automation. Instead:
- SyncHub pushes new Bid Board opportunities to the CRM via `POST /api/integrations/synchub/opportunities`
- SyncHub notifies the CRM of Bid Board stage changes and assignment updates via the same endpoint
- The CRM handles deal lifecycle from that point forward (all API-based, no Playwright)
- SyncHub continues running independently on its existing Railway service

---

## 21. Supported File Types

The CRM accepts uploads in these formats:

| Category | Extensions |
|----------|-----------|
| Images | .jpg, .jpeg, .png, .gif, .webp, .heic |
| Documents | .pdf, .doc, .docx |
| Spreadsheets | .xls, .xlsx, .csv |
| Presentations | .ppt, .pptx |
| Other | .txt, .zip |

Maximum file size: 50 MB per upload. HEIC files (iPhone photos) are accepted as-is — no server-side conversion in Phase 1.

MIME type validation on upload prevents disguised file types. The `file_extension` column is extracted from the original filename, not trusted blindly — the server verifies the MIME type matches.

---

## 22. Documentation Deliverables

Delivered alongside the platform at go-live:

1. **User Guide** — step-by-step walkthrough for sales reps: logging in, managing deals, using the pipeline, uploading files, reading reports, managing tasks
2. **Admin Guide** — for T Rock's CRM admin: managing offices, users, roles, pipeline configuration, migration tools, Procore sync monitoring, audit log access
3. **Training Session** — live walkthrough with all CRM users (recorded for future onboarding)

Guides are delivered as in-app help pages (accessible from the Settings menu) and as downloadable PDFs.

### Post-Launch Support Infrastructure

- **Issue Ticketing System** — Already built and active. Sales team submits bugs and issues for immediate resolution.
- **Feature Request Portal** — Already built and active. Sales team submits feature ideas for prioritization.
- Both are external to the CRM (not built into the platform). Links accessible from the CRM's Settings/Help page.

---

## 23. Global Search

The CRM provides a unified search experience accessible via Cmd+K (desktop) or the search icon (mobile).

**Implementation:**
- Single API endpoint: `GET /api/search?q=<query>&types=deals,contacts,files`
- Searches across three entity types simultaneously using PG full-text search:
  - **Deals:** `deal_number`, `name`, `description`, `property_address` (weighted tsvector)
  - **Contacts:** `first_name || last_name`, `email`, `company_name`, `phone` (weighted tsvector)
  - **Files:** Existing `search_vector` (display_name, description, tags, notes)
- Results grouped by entity type, ranked by relevance score
- Each result includes: entity type badge, primary label, secondary label, deep link
- Recent searches stored in localStorage for quick access
- Search debounced at 300ms, minimum 2 characters

**Cross-office behavior:**
- Reps: search scoped to their office schema
- Directors/admins: search across accessible offices (parallel queries per schema, merged results)

---

## 24. Integration Retry & Idempotency

All external API calls (Procore, MS Graph, Resend) follow consistent retry and idempotency rules.

### Retry Policy

| Integration | Max Retries | Backoff | Circuit Breaker |
|-------------|------------|---------|-----------------|
| Procore API | 3 | Exponential (1s, 3s, 9s) | Open after 5 consecutive failures, half-open after 60s |
| MS Graph API | 3 | Exponential (1s, 3s, 9s) | Open after 5 consecutive failures, half-open after 60s |
| Resend (email) | 2 | Linear (5s, 10s) | None — email is best-effort |
| R2 (presigned URL gen) | 2 | Linear (1s, 2s) | None |

### Idempotency Rules

- **Procore project creation:** Check `deals.procore_project_id` before creating. If already set, skip. Prevents duplicate projects on retry.
- **Email sync:** `graph_message_id` UNIQUE constraint prevents duplicate email records regardless of how many times sync runs.
- **Webhook processing:** `procore_webhook_log` records every webhook. Handler checks for recent duplicate (same event_type + resource_id within 60s) before processing.
- **Job queue:** `job_queue` entries have `status` tracking. Worker sets `processing` before starting, `completed` on success. On crash, status remains `processing` — startup sweep resets stale `processing` jobs (older than 5 minutes) back to `pending`.
- **Notification dedup:** Notifications include a `type + entity_id + date` compound check to prevent duplicate alerts for the same event on the same day.
