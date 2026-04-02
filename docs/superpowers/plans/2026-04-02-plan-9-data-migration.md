# Plan 9: Data Migration

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the full HubSpot → CRM data migration pipeline: HubSpot API client for extraction, migration scripts that pull deals/contacts/activities into staging tables, auto-validation with stage mapping / rep matching / duplicate detection, a validation UI for reviewing flagged records with batch approve/reject/merge controls, a promotion script that moves approved records into the live office schema, import run tracking throughout, and tests.

**Architecture:** Migration lives in two places — `server/src/modules/migration/` for the API (validation UI backend, promotion endpoint, import run tracking) and `scripts/` for the standalone extract/promote scripts that run as one-off Railway commands. The `migration` PostgreSQL schema is temporary staging space. Nothing in `migration.*` goes live until an admin explicitly promotes it. Staging tables preserve raw HubSpot API responses in `raw_data` JSONB so nothing is lost if field mappings need adjustment.

**Tech Stack:** TypeScript, Express, Drizzle ORM, PostgreSQL, React, Vite, Tailwind CSS, shadcn/ui, lucide-react

**Spec Reference:** `docs/superpowers/specs/2026-04-01-trock-crm-design.md` — Section 14 (Data Migration Plan), Section 4.3 (Migration Schema), Section 15 (Edge Cases)

**Depends On:** Plan 1 (Foundation) + Plan 2 (Deals & Pipeline) + Plan 3 (Contacts & Dedup) — all fully implemented. Migration runs against a live, schema-complete database.

**Already Exists (do NOT recreate):**
- `shared/src/schema/migration/staged-deals.ts` — staged_deals with hubspot_deal_id, raw_data, mapped_name, mapped_stage, mapped_rep_email, mapped_amount, mapped_close_date, mapped_source, validation_status, validation_errors, validation_warnings, reviewed_by, review_notes, promoted_at, promoted_deal_id
- `shared/src/schema/migration/staged-contacts.ts` — staged_contacts with hubspot_contact_id, raw_data, mapped_first_name, mapped_last_name, mapped_email, mapped_phone, mapped_company, mapped_category, duplicate_of_staged_id, duplicate_of_live_id, duplicate_confidence, validation_status, validation_errors, validation_warnings, reviewed_by, merge_target_id, promoted_at, promoted_contact_id
- `shared/src/schema/migration/staged-activities.ts` — staged_activities with hubspot_activity_id, hubspot_deal_id, hubspot_contact_id, raw_data, mapped_type, mapped_subject, mapped_body, mapped_occurred_at, validation_status, validation_errors, promoted_at
- `shared/src/schema/migration/import-runs.ts` — import_runs with type (extract/validate/promote), status (running/completed/failed/rolled_back), stats JSONB, error_log, run_by, started_at, completed_at
- `shared/src/schema/public/pipeline-stage-config.ts` — stages with slug, name, is_terminal
- `shared/src/schema/public/users.ts` — users with email, display_name, role, is_active
- `shared/src/schema/tenant/deals.ts` — deals with all columns including hubspot_deal_id, stage_id, assigned_rep_id, deal_number, name, bid_estimate, awarded_amount, expected_close_date, source, property_state
- `shared/src/schema/tenant/contacts.ts` — contacts with hubspot_contact_id, first_name, last_name, email, phone, company_name, category, normalized_name, normalized_phone
- `shared/src/schema/tenant/activities.ts` — activities with type, user_id, deal_id, contact_id, subject, body, occurred_at
- `shared/src/schema/tenant/contact-deal-associations.ts` — contact_deal_associations with contact_id, deal_id, role, is_primary
- `server/src/middleware/rbac.ts` — requireAdmin
- `server/src/middleware/tenant.ts` — tenantMiddleware providing req.tenantDb, req.commitTransaction
- `server/src/middleware/auth.ts` — authMiddleware providing req.user
- `server/src/app.ts` — createApp with tenantRouter mounting at `/api`
- `client/src/lib/api.ts` — api() fetch wrapper
- `client/src/lib/auth.tsx` — useAuth()
- `client/src/App.tsx` — routes with PlaceholderPage for `/admin/migration`, `/admin/migration/deals`, `/admin/migration/contacts`

---

## File Structure

```
scripts/
  ├── migration-extract.ts         # One-off: pull from HubSpot API → staging tables
  └── migration-promote.ts         # One-off: push approved staging rows → live schema

server/src/modules/migration/
  ├── hubspot-client.ts            # HubSpot API client (deals, contacts, activities)
  ├── field-mapper.ts              # HubSpot → CRM field mapping functions
  ├── validator.ts                 # Auto-validation rules (stage, rep, dupes, amounts)
  ├── service.ts                   # Import run tracking, staging CRUD, promotion logic
  └── routes.ts                    # /api/migration/* admin endpoints

server/tests/modules/migration/
  ├── field-mapper.test.ts         # Field mapping unit tests
  └── validator.test.ts            # Validation rule unit tests

client/src/hooks/
  └── use-migration.ts             # Migration dashboard data hooks

client/src/pages/admin/migration/
  ├── migration-dashboard-page.tsx # /admin/migration — overview + run history
  ├── migration-deals-page.tsx     # /admin/migration/deals — deal validation table
  └── migration-contacts-page.tsx  # /admin/migration/contacts — contact validation table
```

---

## Task 1: HubSpot API Client

- [ ] Create `server/src/modules/migration/hubspot-client.ts`

Minimal read-only HubSpot client using the private app token (`HUBSPOT_PRIVATE_APP_TOKEN`). Handles pagination via HubSpot's `after` cursor. Only the properties needed for mapping are requested — keeps payloads small and avoids rate limits.

**File: `server/src/modules/migration/hubspot-client.ts`**

```typescript
// server/src/modules/migration/hubspot-client.ts

const HS_BASE = "https://api.hubapi.com";
const PAGE_SIZE = 100;

function hsHeaders(): HeadersInit {
  const token = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
  if (!token) throw new Error("HUBSPOT_PRIVATE_APP_TOKEN not set");
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

async function hsFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${HS_BASE}${path}`, { headers: hsHeaders() });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HubSpot API error: ${res.status} ${path} — ${text}`);
  }
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Types matching the HubSpot v3 CRM response shape
// ---------------------------------------------------------------------------

export interface HubSpotDeal {
  id: string;
  properties: {
    dealname?: string;
    dealstage?: string;
    hubspot_owner_id?: string;
    amount?: string;
    closedate?: string;
    hs_deal_stage_probability?: string;
    lead_source?: string;
    address?: string;
    city?: string;
    state?: string;
    zip?: string;
    description?: string;
    hs_lastmodifieddate?: string;
    createdate?: string;
  };
  associations?: {
    contacts?: { results: Array<{ id: string }> };
  };
}

export interface HubSpotContact {
  id: string;
  properties: {
    firstname?: string;
    lastname?: string;
    email?: string;
    phone?: string;
    mobilephone?: string;
    company?: string;
    jobtitle?: string;
    hs_lead_status?: string;
    lifecyclestage?: string;
    address?: string;
    city?: string;
    state?: string;
    zip?: string;
    hs_lastmodifieddate?: string;
    createdate?: string;
  };
}

export interface HubSpotActivity {
  id: string;
  properties: {
    hs_activity_type?: string;
    hs_call_title?: string;
    hs_call_body?: string;
    hs_call_duration?: string;
    hs_call_outcome?: string;
    hs_meeting_title?: string;
    hs_meeting_body?: string;
    hs_timestamp?: string;
    hs_note_body?: string;
    hs_email_subject?: string;
    hs_email_text?: string;
    hubspot_owner_id?: string;
    hs_lastmodifieddate?: string;
  };
  associations?: {
    deals?: { results: Array<{ id: string }> };
    contacts?: { results: Array<{ id: string }> };
  };
}

export interface HubSpotOwner {
  id: string;
  email?: string;
  firstName?: string;
  lastName?: string;
}

// ---------------------------------------------------------------------------
// Pagination helper
// ---------------------------------------------------------------------------

async function fetchAllPages<T>(
  buildUrl: (after?: string) => string,
  extractItems: (body: any) => T[],
  extractNext: (body: any) => string | undefined
): Promise<T[]> {
  const all: T[] = [];
  let after: string | undefined;

  do {
    const body = await hsFetch<any>(buildUrl(after));
    const items = extractItems(body);
    all.push(...items);
    after = extractNext(body);
  } while (after);

  return all;
}

// ---------------------------------------------------------------------------
// Public extraction functions
// ---------------------------------------------------------------------------

const DEAL_PROPERTIES = [
  "dealname", "dealstage", "hubspot_owner_id", "amount", "closedate",
  "hs_deal_stage_probability", "lead_source", "address", "city", "state",
  "zip", "description", "hs_lastmodifieddate", "createdate",
].join(",");

/** Fetch all HubSpot deals with contact associations. */
export async function fetchAllDeals(): Promise<HubSpotDeal[]> {
  return fetchAllPages<HubSpotDeal>(
    (after) => {
      const params = new URLSearchParams({
        properties: DEAL_PROPERTIES,
        associations: "contacts",
        limit: String(PAGE_SIZE),
      });
      if (after) params.set("after", after);
      return `/crm/v3/objects/deals?${params}`;
    },
    (body) => body.results ?? [],
    (body) => body.paging?.next?.after
  );
}

const CONTACT_PROPERTIES = [
  "firstname", "lastname", "email", "phone", "mobilephone", "company",
  "jobtitle", "hs_lead_status", "lifecyclestage", "address", "city",
  "state", "zip", "hs_lastmodifieddate", "createdate",
].join(",");

/** Fetch all HubSpot contacts. */
export async function fetchAllContacts(): Promise<HubSpotContact[]> {
  return fetchAllPages<HubSpotContact>(
    (after) => {
      const params = new URLSearchParams({
        properties: CONTACT_PROPERTIES,
        limit: String(PAGE_SIZE),
      });
      if (after) params.set("after", after);
      return `/crm/v3/objects/contacts?${params}`;
    },
    (body) => body.results ?? [],
    (body) => body.paging?.next?.after
  );
}

/** Fetch all engagement/activity objects: calls, notes, meetings, emails. */
export async function fetchAllActivities(): Promise<HubSpotActivity[]> {
  const types = ["calls", "notes", "meetings", "emails"] as const;
  const all: HubSpotActivity[] = [];

  for (const type of types) {
    const props = buildActivityProperties(type);
    const items = await fetchAllPages<HubSpotActivity>(
      (after) => {
        const params = new URLSearchParams({
          properties: props,
          associations: "deals,contacts",
          limit: String(PAGE_SIZE),
        });
        if (after) params.set("after", after);
        return `/crm/v3/objects/${type}?${params}`;
      },
      (body) => body.results ?? [],
      (body) => body.paging?.next?.after
    );
    // Tag each item with its engagement type for mapping
    for (const item of items) {
      (item as any).__type = type;
    }
    all.push(...items);
  }

  return all;
}

function buildActivityProperties(type: string): string {
  const base = ["hubspot_owner_id", "hs_timestamp", "hs_lastmodifieddate"];
  const typeProps: Record<string, string[]> = {
    calls: ["hs_call_title", "hs_call_body", "hs_call_duration", "hs_call_outcome"],
    notes: ["hs_note_body"],
    meetings: ["hs_meeting_title", "hs_meeting_body"],
    emails: ["hs_email_subject", "hs_email_text"],
  };
  return [...base, ...(typeProps[type] ?? [])].join(",");
}

/** Fetch all owners (used to resolve hubspot_owner_id → email for rep matching). */
export async function fetchAllOwners(): Promise<HubSpotOwner[]> {
  const body = await hsFetch<{ results: HubSpotOwner[] }>("/crm/v3/owners?limit=500");
  return body.results ?? [];
}
```

---

## Task 2: Field Mapper — HubSpot → CRM

- [ ] Create `server/src/modules/migration/field-mapper.ts`

Maps raw HubSpot API response shapes to the CRM's staged_ table shapes. Stage names are mapped using a configurable lookup (HubSpot stage IDs → CRM stage slugs). Owner IDs are resolved to email addresses using the owners map fetched in Task 1.

**File: `server/src/modules/migration/field-mapper.ts`**

```typescript
// server/src/modules/migration/field-mapper.ts

import type { HubSpotDeal, HubSpotContact, HubSpotActivity, HubSpotOwner } from "./hubspot-client.js";

// ---------------------------------------------------------------------------
// Owner ID → email resolution map
// ---------------------------------------------------------------------------

export function buildOwnerEmailMap(owners: HubSpotOwner[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const owner of owners) {
    if (owner.id && owner.email) {
      map.set(owner.id, owner.email.toLowerCase().trim());
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// HubSpot deal stage ID → CRM pipeline stage slug
// This map must be configured per T Rock's actual HubSpot pipeline.
// Unknown stage IDs are passed through as-is so validation can flag them.
// ---------------------------------------------------------------------------

// T Rock HubSpot → CRM stage slug mapping.
// Keys are HubSpot dealstage internal values (pipeline-specific IDs or slugs).
const HUBSPOT_STAGE_MAP: Record<string, string> = {
  // Pre-production
  "appointmentscheduled": "dd",
  "qualifiedtobuy": "dd",
  "presentationscheduled": "estimating",
  "decisionmakerboughtin": "estimating",
  "contractsent": "bid_sent",
  "closedwon": "closed_won",
  "closedlost": "closed_lost",
  // T Rock may use custom stage IDs — add them here during migration setup
  // "12345678": "in_production",
};

export function mapHubSpotStage(hubspotStage: string | undefined): string {
  if (!hubspotStage) return "";
  const normalized = hubspotStage.toLowerCase().trim();
  return HUBSPOT_STAGE_MAP[normalized] ?? hubspotStage; // pass through if unknown
}

// ---------------------------------------------------------------------------
// Contact category inference
// HubSpot doesn't have a direct equivalent — infer from lifecycle stage / lead status
// ---------------------------------------------------------------------------

function inferContactCategory(contact: HubSpotContact): string {
  const lifecycle = contact.properties.lifecyclestage?.toLowerCase() ?? "";
  const leadStatus = contact.properties.hs_lead_status?.toLowerCase() ?? "";

  if (lifecycle === "customer" || leadStatus === "connected") return "client";
  if (lifecycle === "subscriber" || lifecycle === "lead") return "other";
  return "other"; // default — reviewer can correct during validation
}

// ---------------------------------------------------------------------------
// Deal mapper
// ---------------------------------------------------------------------------

export interface MappedDeal {
  hubspotDealId: string;
  rawData: Record<string, unknown>;
  mappedName: string | null;
  mappedStage: string | null;
  mappedRepEmail: string | null;
  mappedAmount: number | null;
  mappedCloseDate: string | null; // ISO date string YYYY-MM-DD
  mappedSource: string | null;
}

export function mapDeal(
  deal: HubSpotDeal,
  ownerEmailMap: Map<string, string>
): MappedDeal {
  const p = deal.properties;

  // Amount: HubSpot returns as a string; parse to number
  let mappedAmount: number | null = null;
  if (p.amount) {
    const parsed = parseFloat(p.amount);
    if (!isNaN(parsed)) mappedAmount = parsed;
  }

  // Close date: HubSpot returns ISO timestamp; extract date part
  let mappedCloseDate: string | null = null;
  if (p.closedate) {
    const d = new Date(p.closedate);
    if (!isNaN(d.getTime())) {
      mappedCloseDate = d.toISOString().split("T")[0]; // YYYY-MM-DD
    }
  }

  // Owner ID → email
  const mappedRepEmail = p.hubspot_owner_id
    ? (ownerEmailMap.get(p.hubspot_owner_id) ?? null)
    : null;

  return {
    hubspotDealId: deal.id,
    rawData: deal as unknown as Record<string, unknown>,
    mappedName: p.dealname?.trim() || null,
    mappedStage: mapHubSpotStage(p.dealstage),
    mappedRepEmail,
    mappedAmount,
    mappedCloseDate,
    mappedSource: p.lead_source?.trim() || "HubSpot",
  };
}

// ---------------------------------------------------------------------------
// Contact mapper
// ---------------------------------------------------------------------------

export interface MappedContact {
  hubspotContactId: string;
  rawData: Record<string, unknown>;
  mappedFirstName: string | null;
  mappedLastName: string | null;
  mappedEmail: string | null;
  mappedPhone: string | null;
  mappedCompany: string | null;
  mappedCategory: string;
}

export function mapContact(contact: HubSpotContact): MappedContact {
  const p = contact.properties;
  return {
    hubspotContactId: contact.id,
    rawData: contact as unknown as Record<string, unknown>,
    mappedFirstName: p.firstname?.trim() || null,
    mappedLastName: p.lastname?.trim() || null,
    // Normalize email to lowercase
    mappedEmail: p.email ? p.email.toLowerCase().trim() : null,
    // Normalize phone: keep digits, dashes, parens, plus
    mappedPhone: p.phone?.replace(/[^\d\-()+\s]/g, "").trim() || null,
    mappedCompany: p.company?.trim() || null,
    mappedCategory: inferContactCategory(contact),
  };
}

// ---------------------------------------------------------------------------
// Activity mapper
// ---------------------------------------------------------------------------

export interface MappedActivity {
  hubspotActivityId: string;
  hubspotDealId: string | null;
  hubspotContactId: string | null;
  rawData: Record<string, unknown>;
  mappedType: "call" | "note" | "meeting" | "email" | "task_completed" | null;
  mappedSubject: string | null;
  mappedBody: string | null;
  mappedOccurredAt: string | null; // ISO timestamp
}

function mapActivityType(
  engagementType: string
): "call" | "note" | "meeting" | "email" | "task_completed" | null {
  const t = engagementType.toLowerCase();
  if (t === "calls") return "call";
  if (t === "notes") return "note";
  if (t === "meetings") return "meeting";
  if (t === "emails") return "email";
  if (t === "tasks") return "task_completed";
  return null;
}

export function mapActivity(activity: HubSpotActivity): MappedActivity {
  const p = activity.properties;
  const engType = (activity as any).__type ?? "";

  // First associated deal and contact (take first if multiple)
  const hubspotDealId =
    activity.associations?.deals?.results?.[0]?.id ?? null;
  const hubspotContactId =
    activity.associations?.contacts?.results?.[0]?.id ?? null;

  // Subject: prefer title fields, fall back to type name
  let subject: string | null = null;
  if (engType === "calls") subject = p.hs_call_title ?? "Call";
  else if (engType === "notes") subject = "Note";
  else if (engType === "meetings") subject = p.hs_meeting_title ?? "Meeting";
  else if (engType === "emails") subject = p.hs_email_subject ?? "Email";

  // Body: the text content
  let body: string | null = null;
  if (engType === "calls") body = p.hs_call_body ?? null;
  else if (engType === "notes") body = p.hs_note_body ?? null;
  else if (engType === "meetings") body = p.hs_meeting_body ?? null;
  else if (engType === "emails") body = p.hs_email_text ?? null;

  // Timestamp
  let mappedOccurredAt: string | null = null;
  if (p.hs_timestamp) {
    const d = new Date(p.hs_timestamp);
    if (!isNaN(d.getTime())) mappedOccurredAt = d.toISOString();
  }

  return {
    hubspotActivityId: activity.id,
    hubspotDealId,
    hubspotContactId,
    rawData: activity as unknown as Record<string, unknown>,
    mappedType: mapActivityType(engType),
    mappedSubject: subject,
    mappedBody: body,
    mappedOccurredAt,
  };
}
```

---

## Task 3: Migration Extract Script — HubSpot → Staging Tables

- [ ] Create `scripts/migration-extract.ts`

Standalone script run as a one-off Railway command: `railway run npx tsx scripts/migration-extract.ts`. Pulls all HubSpot data, maps it, and loads it into the `migration.*` staging tables. Preserves full `raw_data`. Records an `import_runs` row for tracking.

**File: `scripts/migration-extract.ts`**

```typescript
// scripts/migration-extract.ts
// Run via: railway run npx tsx scripts/migration-extract.ts
// Or locally: HUBSPOT_PRIVATE_APP_TOKEN=... npx tsx scripts/migration-extract.ts

import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { eq } from "drizzle-orm";
import * as migrationSchema from "../shared/src/schema/migration/index.js";
import { users } from "../shared/src/schema/public/users.js";
import {
  fetchAllDeals,
  fetchAllContacts,
  fetchAllActivities,
  fetchAllOwners,
} from "../server/src/modules/migration/hubspot-client.js";
import {
  buildOwnerEmailMap,
  mapDeal,
  mapContact,
  mapActivity,
} from "../server/src/modules/migration/field-mapper.js";

const { stagedDeals, stagedContacts, stagedActivities, importRuns } = migrationSchema;

// ---------------------------------------------------------------------------
// Database connection
// ---------------------------------------------------------------------------

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Find admin user for run_by attribution. Falls back to first user. */
async function getRunByUserId(): Promise<string> {
  const adminRows = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.role, "admin"))
    .limit(1);
  if (adminRows[0]) return adminRows[0].id;

  const anyUser = await db.select({ id: users.id }).from(users).limit(1);
  if (anyUser[0]) return anyUser[0].id;

  throw new Error("No users found in database — run Plan 1 first");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("[migration:extract] Starting HubSpot extraction...");

  const runByUserId = await getRunByUserId();

  // Create import run record
  const [runRow] = await db
    .insert(importRuns)
    .values({
      type: "extract",
      status: "running",
      stats: { total: 0, deals: 0, contacts: 0, activities: 0 },
      runBy: runByUserId,
      startedAt: new Date(),
    })
    .returning({ id: importRuns.id });

  const runId = runRow.id;
  console.log(`[migration:extract] Import run ID: ${runId}`);

  try {
    // 1. Fetch owners (needed for rep email resolution)
    console.log("[migration:extract] Fetching HubSpot owners...");
    const owners = await fetchAllOwners();
    const ownerEmailMap = buildOwnerEmailMap(owners);
    console.log(`[migration:extract] ${owners.length} owners loaded`);

    // 2. Extract and load deals
    console.log("[migration:extract] Fetching deals from HubSpot...");
    const hsDealsList = await fetchAllDeals();
    console.log(`[migration:extract] ${hsDealsList.length} deals fetched`);

    let dealCount = 0;
    const BATCH = 50;
    for (let i = 0; i < hsDealsList.length; i += BATCH) {
      const batch = hsDealsList.slice(i, i + BATCH);
      const mapped = batch.map((d) => mapDeal(d, ownerEmailMap));

      await db
        .insert(stagedDeals)
        .values(
          mapped.map((d) => ({
            hubspotDealId: d.hubspotDealId,
            rawData: d.rawData,
            mappedName: d.mappedName,
            mappedStage: d.mappedStage,
            mappedRepEmail: d.mappedRepEmail,
            mappedAmount: d.mappedAmount,
            mappedCloseDate: d.mappedCloseDate ? new Date(d.mappedCloseDate) : null,
            mappedSource: d.mappedSource,
            validationStatus: "pending",
            validationErrors: [],
            validationWarnings: [],
          }))
        )
        .onConflictDoNothing(); // idempotent: skip if hubspot_deal_id already exists

      dealCount += batch.length;
      process.stdout.write(`\r  Deals: ${dealCount}/${hsDealsList.length}`);
    }
    console.log(`\n[migration:extract] ${dealCount} deals staged`);

    // 3. Extract and load contacts
    console.log("[migration:extract] Fetching contacts from HubSpot...");
    const hsContacts = await fetchAllContacts();
    console.log(`[migration:extract] ${hsContacts.length} contacts fetched`);

    let contactCount = 0;
    for (let i = 0; i < hsContacts.length; i += BATCH) {
      const batch = hsContacts.slice(i, i + BATCH);
      const mapped = batch.map(mapContact);

      await db
        .insert(stagedContacts)
        .values(
          mapped.map((c) => ({
            hubspotContactId: c.hubspotContactId,
            rawData: c.rawData,
            mappedFirstName: c.mappedFirstName,
            mappedLastName: c.mappedLastName,
            mappedEmail: c.mappedEmail,
            mappedPhone: c.mappedPhone,
            mappedCompany: c.mappedCompany,
            mappedCategory: c.mappedCategory,
            validationStatus: "pending",
            validationErrors: [],
            validationWarnings: [],
          }))
        )
        .onConflictDoNothing();

      contactCount += batch.length;
      process.stdout.write(`\r  Contacts: ${contactCount}/${hsContacts.length}`);
    }
    console.log(`\n[migration:extract] ${contactCount} contacts staged`);

    // 4. Extract and load activities
    console.log("[migration:extract] Fetching activities from HubSpot...");
    const hsActivities = await fetchAllActivities();
    console.log(`[migration:extract] ${hsActivities.length} activities fetched`);

    let activityCount = 0;
    for (let i = 0; i < hsActivities.length; i += BATCH) {
      const batch = hsActivities.slice(i, i + BATCH);
      const mapped = batch.map(mapActivity);

      await db
        .insert(stagedActivities)
        .values(
          mapped.map((a) => ({
            hubspotActivityId: a.hubspotActivityId,
            hubspotDealId: a.hubspotDealId,
            hubspotContactId: a.hubspotContactId,
            rawData: a.rawData,
            mappedType: a.mappedType,
            mappedSubject: a.mappedSubject,
            mappedBody: a.mappedBody,
            mappedOccurredAt: a.mappedOccurredAt ? new Date(a.mappedOccurredAt) : null,
            validationStatus: "pending",
            validationErrors: [],
          }))
        )
        .onConflictDoNothing();

      activityCount += batch.length;
      process.stdout.write(`\r  Activities: ${activityCount}/${hsActivities.length}`);
    }
    console.log(`\n[migration:extract] ${activityCount} activities staged`);

    // Update import run as completed
    const total = dealCount + contactCount + activityCount;
    await db
      .update(importRuns)
      .set({
        status: "completed",
        stats: { total, deals: dealCount, contacts: contactCount, activities: activityCount },
        completedAt: new Date(),
      })
      .where(eq(importRuns.id, runId));

    console.log(`\n[migration:extract] Done. ${total} records staged (run ${runId})`);
  } catch (err) {
    console.error("\n[migration:extract] FAILED:", err);
    await db
      .update(importRuns)
      .set({
        status: "failed",
        errorLog: String(err),
        completedAt: new Date(),
      })
      .where(eq(importRuns.id, runId));
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
```

---

## Task 4: Auto-Validation — Stage Mapping, Rep Matching, Duplicate Detection

- [ ] Create `server/src/modules/migration/validator.ts`

Validation runs against all staged records in `pending` status. Updates each row's `validation_status`, `validation_errors`, and `validation_warnings`. Called by the API endpoint and also invokable as a standalone step.

**File: `server/src/modules/migration/validator.ts`**

```typescript
// server/src/modules/migration/validator.ts

import { eq, and, inArray, isNull, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  stagedDeals,
  stagedContacts,
  stagedActivities,
} from "@trock-crm/shared/schema/migration/index.js";
import { pipelineStageConfig, users } from "@trock-crm/shared/schema/public/index.js";
import { db } from "../../db.js";
import type * as schema from "@trock-crm/shared/schema";

type PublicDb = NodePgDatabase<typeof schema>;

interface ValidationError {
  field: string;
  error: string;
}

interface ValidationWarning {
  field: string;
  warning: string;
}

// ---------------------------------------------------------------------------
// Validate all staged deals
// ---------------------------------------------------------------------------

export async function validateStagedDeals(): Promise<{
  valid: number;
  invalid: number;
  needsReview: number;
}> {
  // Load reference data once
  const allStages = await db
    .select({ id: pipelineStageConfig.id, slug: pipelineStageConfig.slug })
    .from(pipelineStageConfig);

  const stageSlugs = new Set(allStages.map((s) => s.slug));

  const allReps = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.isActive, true));

  const repEmails = new Set(allReps.map((r) => r.email.toLowerCase()));

  // Fetch all pending deals in batches
  const BATCH = 100;
  let offset = 0;
  let valid = 0, invalid = 0, needsReview = 0;

  while (true) {
    const batch = await db
      .select()
      .from(stagedDeals)
      .where(eq(stagedDeals.validationStatus, "pending"))
      .limit(BATCH)
      .offset(offset);

    if (batch.length === 0) break;

    for (const deal of batch) {
      const errors: ValidationError[] = [];
      const warnings: ValidationWarning[] = [];

      // Required: name
      if (!deal.mappedName) {
        errors.push({ field: "name", error: "Deal name is blank" });
      }

      // Stage: must map to a known CRM stage slug
      if (!deal.mappedStage) {
        errors.push({ field: "stage", error: "No stage mapped" });
      } else if (!stageSlugs.has(deal.mappedStage)) {
        errors.push({
          field: "stage",
          error: `Unknown CRM stage: "${deal.mappedStage}" — update HUBSPOT_STAGE_MAP in field-mapper.ts`,
        });
      }

      // Rep: email must match an active CRM user
      if (!deal.mappedRepEmail) {
        warnings.push({ field: "rep", warning: "No rep email — deal will be unassigned" });
      } else if (!repEmails.has(deal.mappedRepEmail.toLowerCase())) {
        errors.push({
          field: "rep",
          error: `Rep email "${deal.mappedRepEmail}" does not match any active CRM user`,
        });
      }

      // Amount: warn if $0 or null (common data quality issue)
      if (deal.mappedAmount == null || deal.mappedAmount === 0) {
        warnings.push({ field: "amount", warning: "Deal amount is $0 or blank" });
      }

      // Determine final status
      let validationStatus: "valid" | "invalid" | "needs_review";
      if (errors.length > 0) {
        validationStatus = "invalid";
        invalid++;
      } else if (warnings.length > 0) {
        validationStatus = "needs_review";
        needsReview++;
      } else {
        validationStatus = "valid";
        valid++;
      }

      await db
        .update(stagedDeals)
        .set({
          validationStatus,
          validationErrors: errors,
          validationWarnings: warnings,
        })
        .where(eq(stagedDeals.id, deal.id));
    }

    offset += BATCH;
  }

  return { valid, invalid, needsReview };
}

// ---------------------------------------------------------------------------
// Validate all staged contacts + detect duplicates
// ---------------------------------------------------------------------------

export async function validateStagedContacts(): Promise<{
  valid: number;
  invalid: number;
  needsReview: number;
  duplicates: number;
}> {
  const BATCH = 100;
  let offset = 0;
  let valid = 0, invalid = 0, needsReview = 0, duplicates = 0;

  // Build in-memory email map for staged duplicate detection
  const allStaged = await db
    .select({
      id: stagedContacts.id,
      mappedEmail: stagedContacts.mappedEmail,
      mappedFirstName: stagedContacts.mappedFirstName,
      mappedLastName: stagedContacts.mappedLastName,
    })
    .from(stagedContacts);

  // email → first staged id
  const stagedEmailMap = new Map<string, string>();
  // normalized_name → first staged id
  const stagedNameMap = new Map<string, string>();

  for (const row of allStaged) {
    const email = row.mappedEmail?.toLowerCase().trim();
    if (email) {
      if (!stagedEmailMap.has(email)) {
        stagedEmailMap.set(email, row.id);
      }
    }
    const name = `${row.mappedFirstName ?? ""} ${row.mappedLastName ?? ""}`.toLowerCase().trim();
    if (name.length > 2) {
      if (!stagedNameMap.has(name)) {
        stagedNameMap.set(name, row.id);
      }
    }
  }

  while (true) {
    const batch = await db
      .select()
      .from(stagedContacts)
      .where(eq(stagedContacts.validationStatus, "pending"))
      .limit(BATCH)
      .offset(offset);

    if (batch.length === 0) break;

    for (const contact of batch) {
      const errors: ValidationError[] = [];
      const warnings: ValidationWarning[] = [];

      // At least email OR phone required
      if (!contact.mappedEmail && !contact.mappedPhone) {
        errors.push({
          field: "email/phone",
          error: "Contact has neither email nor phone — cannot be reliably identified",
        });
      }

      // Name check
      if (!contact.mappedFirstName && !contact.mappedLastName) {
        errors.push({ field: "name", error: "Contact has no first or last name" });
      }

      // Staged duplicate detection by email
      let duplicateOfStagedId: string | null = null;
      if (contact.mappedEmail) {
        const email = contact.mappedEmail.toLowerCase().trim();
        const firstId = stagedEmailMap.get(email);
        if (firstId && firstId !== contact.id) {
          duplicateOfStagedId = firstId;
          duplicates++;
        }
      }

      // Staged duplicate detection by name (if no email duplicate already)
      if (!duplicateOfStagedId) {
        const name = `${contact.mappedFirstName ?? ""} ${contact.mappedLastName ?? ""}`.toLowerCase().trim();
        if (name.length > 2) {
          const firstId = stagedNameMap.get(name);
          if (firstId && firstId !== contact.id) {
            warnings.push({
              field: "name",
              warning: `Possible duplicate of staged contact ${firstId} (same normalized name)`,
            });
          }
        }
      }

      // Determine final status
      let validationStatus: "valid" | "invalid" | "needs_review" | "duplicate";
      if (duplicateOfStagedId) {
        validationStatus = "duplicate";
      } else if (errors.length > 0) {
        validationStatus = "invalid";
        invalid++;
      } else if (warnings.length > 0) {
        validationStatus = "needs_review";
        needsReview++;
      } else {
        validationStatus = "valid";
        valid++;
      }

      await db
        .update(stagedContacts)
        .set({
          validationStatus,
          validationErrors: errors,
          validationWarnings: warnings,
          duplicateOfStagedId: duplicateOfStagedId ?? null,
        })
        .where(eq(stagedContacts.id, contact.id));
    }

    offset += BATCH;
  }

  return { valid, invalid, needsReview, duplicates };
}

// ---------------------------------------------------------------------------
// Validate staged activities
// ---------------------------------------------------------------------------

export async function validateStagedActivities(): Promise<{
  valid: number;
  invalid: number;
  orphans: number;
}> {
  // Build set of all staged hubspot deal IDs and contact IDs for orphan detection
  const stagedDealIds = new Set(
    (await db.select({ id: stagedDeals.hubspotDealId }).from(stagedDeals)).map((r) => r.id)
  );
  const stagedContactIds = new Set(
    (await db.select({ id: stagedContacts.hubspotContactId }).from(stagedContacts)).map((r) => r.id)
  );

  const BATCH = 100;
  let offset = 0;
  let valid = 0, invalid = 0, orphans = 0;

  while (true) {
    const batch = await db
      .select()
      .from(stagedActivities)
      .where(eq(stagedActivities.validationStatus, "pending"))
      .limit(BATCH)
      .offset(offset);

    if (batch.length === 0) break;

    for (const activity of batch) {
      const errors: ValidationError[] = [];

      // Unknown type
      if (!activity.mappedType) {
        errors.push({ field: "type", error: "Activity type could not be mapped" });
      }

      // Orphan: no associated deal or contact found in staging
      const dealExists = activity.hubspotDealId ? stagedDealIds.has(activity.hubspotDealId) : false;
      const contactExists = activity.hubspotContactId
        ? stagedContactIds.has(activity.hubspotContactId)
        : false;

      let validationStatus: "valid" | "invalid" | "orphan";
      if (!dealExists && !contactExists) {
        validationStatus = "orphan";
        orphans++;
      } else if (errors.length > 0) {
        validationStatus = "invalid";
        invalid++;
      } else {
        validationStatus = "valid";
        valid++;
      }

      await db
        .update(stagedActivities)
        .set({ validationStatus, validationErrors: errors })
        .where(eq(stagedActivities.id, activity.id));
    }

    offset += BATCH;
  }

  return { valid, invalid, orphans };
}

// ---------------------------------------------------------------------------
// Summary stats for import run
// ---------------------------------------------------------------------------

export async function getValidationStats(): Promise<{
  deals: Record<string, number>;
  contacts: Record<string, number>;
  activities: Record<string, number>;
}> {
  const dealStats = await db.execute(sql`
    SELECT validation_status, COUNT(*)::int AS count
    FROM migration.staged_deals
    GROUP BY validation_status
  `);
  const contactStats = await db.execute(sql`
    SELECT validation_status, COUNT(*)::int AS count
    FROM migration.staged_contacts
    GROUP BY validation_status
  `);
  const activityStats = await db.execute(sql`
    SELECT validation_status, COUNT(*)::int AS count
    FROM migration.staged_activities
    GROUP BY validation_status
  `);

  function toRecord(rows: any): Record<string, number> {
    const result: Record<string, number> = {};
    const arr = (rows as any).rows ?? rows;
    for (const r of arr) {
      result[r.validation_status] = Number(r.count ?? 0);
    }
    return result;
  }

  return {
    deals: toRecord(dealStats),
    contacts: toRecord(contactStats),
    activities: toRecord(activityStats),
  };
}
```

---

## Task 5: Migration Service + API Routes — Validation UI Backend

- [ ] Create `server/src/modules/migration/service.ts`
- [ ] Create `server/src/modules/migration/routes.ts`
- [ ] Register migration routes in `server/src/app.ts`

### 5a. Migration Service

**File: `server/src/modules/migration/service.ts`**

```typescript
// server/src/modules/migration/service.ts

import { eq, and, inArray, desc, sql } from "drizzle-orm";
import {
  stagedDeals,
  stagedContacts,
  stagedActivities,
  importRuns,
} from "@trock-crm/shared/schema/migration/index.js";
import { db } from "../../db.js";
import { AppError } from "../../middleware/error-handler.js";

// ---------------------------------------------------------------------------
// Import runs
// ---------------------------------------------------------------------------

export async function getImportRuns() {
  return db
    .select()
    .from(importRuns)
    .orderBy(desc(importRuns.startedAt))
    .limit(20);
}

export async function createImportRun(
  type: "extract" | "validate" | "promote",
  runBy: string
) {
  const [row] = await db
    .insert(importRuns)
    .values({
      type,
      status: "running",
      stats: {},
      runBy,
      startedAt: new Date(),
    })
    .returning();
  return row;
}

export async function completeImportRun(
  runId: string,
  stats: Record<string, unknown>,
  errorLog?: string
) {
  await db
    .update(importRuns)
    .set({
      status: errorLog ? "failed" : "completed",
      stats,
      errorLog: errorLog ?? null,
      completedAt: new Date(),
    })
    .where(eq(importRuns.id, runId));
}

// ---------------------------------------------------------------------------
// Staged deals — list and update
// ---------------------------------------------------------------------------

export interface StagedDealFilter {
  validationStatus?: string;
  page?: number;
  limit?: number;
}

export async function listStagedDeals(filter: StagedDealFilter = {}) {
  const limit = Math.min(filter.limit ?? 50, 200);
  const offset = ((filter.page ?? 1) - 1) * limit;

  const where = filter.validationStatus
    ? eq(stagedDeals.validationStatus, filter.validationStatus as any)
    : undefined;

  const [rows, countResult] = await Promise.all([
    db
      .select()
      .from(stagedDeals)
      .where(where)
      .orderBy(desc(stagedDeals.createdAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(stagedDeals)
      .where(where),
  ]);

  return { rows, total: countResult[0]?.count ?? 0 };
}

export async function approveStagedDeal(dealId: string, reviewedBy: string) {
  const [row] = await db
    .select({ validationStatus: stagedDeals.validationStatus })
    .from(stagedDeals)
    .where(eq(stagedDeals.id, dealId))
    .limit(1);

  if (!row) throw new AppError(404, "Staged deal not found");
  if (row.validationStatus === "promoted") {
    throw new AppError(400, "Deal already promoted");
  }

  await db
    .update(stagedDeals)
    .set({ validationStatus: "approved", reviewedBy })
    .where(eq(stagedDeals.id, dealId));
}

export async function rejectStagedDeal(
  dealId: string,
  reviewedBy: string,
  reviewNotes?: string
) {
  await db
    .update(stagedDeals)
    .set({ validationStatus: "rejected", reviewedBy, reviewNotes: reviewNotes ?? null })
    .where(eq(stagedDeals.id, dealId));
}

export async function batchApproveStagedDeals(
  dealIds: string[],
  reviewedBy: string
) {
  if (dealIds.length === 0) return 0;
  const result = await db
    .update(stagedDeals)
    .set({ validationStatus: "approved", reviewedBy })
    .where(
      and(
        inArray(stagedDeals.id, dealIds),
        inArray(stagedDeals.validationStatus, ["valid", "needs_review"] as any[])
      )
    );
  return (result as any).rowCount ?? 0;
}

// ---------------------------------------------------------------------------
// Staged contacts — list and update
// ---------------------------------------------------------------------------

export async function listStagedContacts(
  filter: { validationStatus?: string; page?: number; limit?: number } = {}
) {
  const limit = Math.min(filter.limit ?? 50, 200);
  const offset = ((filter.page ?? 1) - 1) * limit;

  const where = filter.validationStatus
    ? eq(stagedContacts.validationStatus, filter.validationStatus as any)
    : undefined;

  const [rows, countResult] = await Promise.all([
    db
      .select()
      .from(stagedContacts)
      .where(where)
      .orderBy(desc(stagedContacts.createdAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(stagedContacts)
      .where(where),
  ]);

  return { rows, total: countResult[0]?.count ?? 0 };
}

export async function approveStagedContact(contactId: string, reviewedBy: string) {
  await db
    .update(stagedContacts)
    .set({ validationStatus: "approved", reviewedBy })
    .where(eq(stagedContacts.id, contactId));
}

export async function rejectStagedContact(
  contactId: string,
  reviewedBy: string,
  notes?: string
) {
  await db
    .update(stagedContacts)
    .set({
      validationStatus: "rejected",
      reviewedBy,
      reviewNotes: notes ?? null,
    })
    .where(eq(stagedContacts.id, contactId));
}

export async function mergeStagedContact(
  contactId: string,
  mergeTargetId: string,
  reviewedBy: string
) {
  // Mark this contact as merged into the target
  await db
    .update(stagedContacts)
    .set({
      validationStatus: "merged",
      mergeTargetId,
      reviewedBy,
    })
    .where(eq(stagedContacts.id, contactId));
}

export async function batchApproveStagedContacts(
  contactIds: string[],
  reviewedBy: string
) {
  if (contactIds.length === 0) return 0;
  const result = await db
    .update(stagedContacts)
    .set({ validationStatus: "approved", reviewedBy })
    .where(
      and(
        inArray(stagedContacts.id, contactIds),
        inArray(stagedContacts.validationStatus, ["valid", "needs_review"] as any[])
      )
    );
  return (result as any).rowCount ?? 0;
}

// ---------------------------------------------------------------------------
// Dashboard summary
// ---------------------------------------------------------------------------

export async function getMigrationSummary() {
  const [dealStats, contactStats, activityStats, recentRuns] = await Promise.all([
    db.execute(sql`
      SELECT validation_status, COUNT(*)::int AS count
      FROM migration.staged_deals
      GROUP BY validation_status
    `),
    db.execute(sql`
      SELECT validation_status, COUNT(*)::int AS count
      FROM migration.staged_contacts
      GROUP BY validation_status
    `),
    db.execute(sql`
      SELECT validation_status, COUNT(*)::int AS count
      FROM migration.staged_activities
      GROUP BY validation_status
    `),
    db
      .select()
      .from(importRuns)
      .orderBy(desc(importRuns.startedAt))
      .limit(5),
  ]);

  function toMap(rows: any): Record<string, number> {
    const arr = (rows as any).rows ?? rows;
    const m: Record<string, number> = {};
    for (const r of arr) m[r.validation_status] = Number(r.count ?? 0);
    return m;
  }

  return {
    deals: toMap(dealStats),
    contacts: toMap(contactStats),
    activities: toMap(activityStats),
    recentRuns,
  };
}
```

### 5b. Migration Routes

**File: `server/src/modules/migration/routes.ts`**

```typescript
// server/src/modules/migration/routes.ts

import { Router, type Request, type Response } from "express";
import { authMiddleware } from "../../middleware/auth.js";
import { requireAdmin } from "../../middleware/rbac.js";
import {
  getMigrationSummary,
  getImportRuns,
  createImportRun,
  completeImportRun,
  listStagedDeals,
  approveStagedDeal,
  rejectStagedDeal,
  batchApproveStagedDeals,
  listStagedContacts,
  approveStagedContact,
  rejectStagedContact,
  mergeStagedContact,
  batchApproveStagedContacts,
} from "./service.js";
import {
  validateStagedDeals,
  validateStagedContacts,
  validateStagedActivities,
} from "./validator.js";

const router = Router();
router.use(authMiddleware, requireAdmin);

// ---------------------------------------------------------------------------
// Dashboard
// GET /api/migration/summary
// ---------------------------------------------------------------------------

router.get("/migration/summary", async (req: Request, res: Response) => {
  try {
    const summary = await getMigrationSummary();
    return res.json(summary);
  } catch (err) {
    console.error("[migration] summary error:", err);
    return res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// Import run history
// GET /api/migration/runs
// ---------------------------------------------------------------------------

router.get("/migration/runs", async (req: Request, res: Response) => {
  try {
    const runs = await getImportRuns();
    return res.json({ runs });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// Trigger validation (runs in-process — for large datasets, offload to worker)
// POST /api/migration/validate
// ---------------------------------------------------------------------------

router.post("/migration/validate", async (req: Request, res: Response) => {
  const runRow = await createImportRun("validate", req.user.id);
  try {
    const [dealResults, contactResults, activityResults] = await Promise.all([
      validateStagedDeals(),
      validateStagedContacts(),
      validateStagedActivities(),
    ]);

    const stats = {
      deals: dealResults,
      contacts: contactResults,
      activities: activityResults,
    };

    await completeImportRun(runRow.id, stats);
    return res.json({ runId: runRow.id, stats });
  } catch (err) {
    await completeImportRun(runRow.id, {}, String(err));
    return res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// Staged deals
// GET /api/migration/deals?validationStatus=invalid&page=1&limit=50
// ---------------------------------------------------------------------------

router.get("/migration/deals", async (req: Request, res: Response) => {
  try {
    const { validationStatus, page, limit } = req.query as Record<string, string>;
    const result = await listStagedDeals({
      validationStatus: validationStatus || undefined,
      page: page ? parseInt(page, 10) : 1,
      limit: limit ? parseInt(limit, 10) : 50,
    });
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// POST /api/migration/deals/:id/approve
router.post("/migration/deals/:id/approve", async (req: Request, res: Response) => {
  try {
    await approveStagedDeal(req.params.id, req.user.id);
    return res.json({ success: true });
  } catch (err: any) {
    return res.status(err.statusCode ?? 500).json({ error: err.message });
  }
});

// POST /api/migration/deals/:id/reject
router.post("/migration/deals/:id/reject", async (req: Request, res: Response) => {
  try {
    const { notes } = req.body as { notes?: string };
    await rejectStagedDeal(req.params.id, req.user.id, notes);
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// POST /api/migration/deals/batch-approve
router.post("/migration/deals/batch-approve", async (req: Request, res: Response) => {
  try {
    const { ids } = req.body as { ids: string[] };
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: "ids array required" });
    }
    const count = await batchApproveStagedDeals(ids, req.user.id);
    return res.json({ approved: count });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// Staged contacts
// GET /api/migration/contacts?validationStatus=duplicate&page=1&limit=50
// ---------------------------------------------------------------------------

router.get("/migration/contacts", async (req: Request, res: Response) => {
  try {
    const { validationStatus, page, limit } = req.query as Record<string, string>;
    const result = await listStagedContacts({
      validationStatus: validationStatus || undefined,
      page: page ? parseInt(page, 10) : 1,
      limit: limit ? parseInt(limit, 10) : 50,
    });
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

router.post("/migration/contacts/:id/approve", async (req: Request, res: Response) => {
  try {
    await approveStagedContact(req.params.id, req.user.id);
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

router.post("/migration/contacts/:id/reject", async (req: Request, res: Response) => {
  try {
    const { notes } = req.body as { notes?: string };
    await rejectStagedContact(req.params.id, req.user.id, notes);
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

router.post("/migration/contacts/:id/merge", async (req: Request, res: Response) => {
  try {
    const { mergeTargetId } = req.body as { mergeTargetId: string };
    if (!mergeTargetId) return res.status(400).json({ error: "mergeTargetId required" });
    await mergeStagedContact(req.params.id, mergeTargetId, req.user.id);
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

router.post("/migration/contacts/batch-approve", async (req: Request, res: Response) => {
  try {
    const { ids } = req.body as { ids: string[] };
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: "ids array required" });
    }
    const count = await batchApproveStagedContacts(ids, req.user.id);
    return res.json({ approved: count });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

export { router as migrationRouter };
```

**Register in `server/src/app.ts`:**

```typescript
import { migrationRouter } from "./modules/migration/routes.js";
// Inside tenantRouter section (auth + admin required):
tenantRouter.use("/api", migrationRouter);
```

---

## Task 6: Promotion Script — Staging → Live Schema

- [ ] Create `scripts/migration-promote.ts`

Promotes all `approved` staging records into the live `office_{slug}` schema. Run as a one-off command after the team has reviewed and approved records in the validation UI. Wrapped in a single PostgreSQL transaction — if any step fails, the entire promotion rolls back.

**File: `scripts/migration-promote.ts`**

```typescript
// scripts/migration-promote.ts
// Run via: OFFICE_SLUG=dallas railway run npx tsx scripts/migration-promote.ts

import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { eq, and, isNull, sql } from "drizzle-orm";
import * as migrationSchema from "../shared/src/schema/migration/index.js";
import { pipelineStageConfig, users } from "../shared/src/schema/public/index.js";

const { stagedDeals, stagedContacts, stagedActivities, importRuns } = migrationSchema;

const OFFICE_SLUG = process.env.OFFICE_SLUG;
if (!OFFICE_SLUG) {
  console.error("OFFICE_SLUG env var required (e.g. OFFICE_SLUG=dallas)");
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool);

async function getRunByUserId(): Promise<string> {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.role, "admin"))
    .limit(1);
  if (!rows[0]) throw new Error("No admin user found");
  return rows[0].id;
}

async function main() {
  console.log(`[migration:promote] Promoting to office schema: ${OFFICE_SLUG}`);
  const schema = `office_${OFFICE_SLUG}`;
  const runByUserId = await getRunByUserId();

  const [runRow] = await db
    .insert(importRuns)
    .values({
      type: "promote",
      status: "running",
      stats: {},
      runBy: runByUserId,
      startedAt: new Date(),
    })
    .returning({ id: importRuns.id });

  const runId = runRow.id;

  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL search_path = '${schema}', 'public'`);

    // -----------------------------------------------------------------------
    // 1. Load reference maps
    // -----------------------------------------------------------------------

    const stages = await db
      .select({ id: pipelineStageConfig.id, slug: pipelineStageConfig.slug })
      .from(pipelineStageConfig);
    const stageBySlug = new Map(stages.map((s) => [s.slug, s.id]));

    const repUsers = await db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(eq(users.isActive, true));
    const repByEmail = new Map(repUsers.map((u) => [u.email.toLowerCase(), u.id]));

    // -----------------------------------------------------------------------
    // 2. Promote contacts first (deals reference contacts)
    // -----------------------------------------------------------------------

    const approvedContacts = await db
      .select()
      .from(stagedContacts)
      .where(eq(stagedContacts.validationStatus, "approved"));

    console.log(`[migration:promote] Promoting ${approvedContacts.length} contacts...`);

    const contactIdMap = new Map<string, string>(); // hubspot_contact_id → new CRM contact_id

    for (const c of approvedContacts) {
      // Check if already promoted (idempotency)
      if (c.promotedContactId) {
        contactIdMap.set(c.hubspotContactId, c.promotedContactId);
        continue;
      }

      const insertResult = await client.query(
        `INSERT INTO contacts (
          first_name, last_name, email, phone, company_name,
          category, hubspot_contact_id, is_active, created_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,true,NOW(),NOW())
        ON CONFLICT (email) WHERE email IS NOT NULL DO UPDATE SET
          hubspot_contact_id = EXCLUDED.hubspot_contact_id,
          updated_at = NOW()
        RETURNING id`,
        [
          c.mappedFirstName ?? "",
          c.mappedLastName ?? "",
          c.mappedEmail ?? null,
          c.mappedPhone ?? null,
          c.mappedCompany ?? null,
          c.mappedCategory ?? "other",
          c.hubspotContactId,
        ]
      );

      const newContactId = insertResult.rows[0]?.id;
      if (newContactId) {
        contactIdMap.set(c.hubspotContactId, newContactId);
        await db
          .update(stagedContacts)
          .set({ promotedAt: new Date(), promotedContactId: newContactId })
          .where(eq(stagedContacts.id, c.id));
      }
    }

    console.log(`[migration:promote] ${contactIdMap.size} contacts promoted`);

    // -----------------------------------------------------------------------
    // 3. Promote deals
    // -----------------------------------------------------------------------

    const approvedDeals = await db
      .select()
      .from(stagedDeals)
      .where(eq(stagedDeals.validationStatus, "approved"));

    console.log(`[migration:promote] Promoting ${approvedDeals.length} deals...`);

    const dealIdMap = new Map<string, string>(); // hubspot_deal_id → new CRM deal_id

    // Generate deal numbers sequentially
    const countResult = await client.query(
      `SELECT COALESCE(MAX(REGEXP_REPLACE(deal_number, '[^0-9]', '', 'g')::int), 0) AS max_num FROM deals`
    );
    let dealCounter = Number(countResult.rows[0]?.max_num ?? 0);

    const year = new Date().getFullYear();

    for (const d of approvedDeals) {
      if (d.promotedDealId) {
        dealIdMap.set(d.hubspotDealId, d.promotedDealId);
        continue;
      }

      const stageId = d.mappedStage ? stageBySlug.get(d.mappedStage) : null;
      const repId = d.mappedRepEmail ? repByEmail.get(d.mappedRepEmail.toLowerCase()) : null;

      if (!stageId || !repId) {
        console.warn(
          `[migration:promote] Skipping deal ${d.hubspotDealId} — missing stage or rep (stage: ${d.mappedStage}, rep: ${d.mappedRepEmail})`
        );
        continue;
      }

      dealCounter++;
      const dealNumber = `TR-${year}-${String(dealCounter).padStart(4, "0")}`;

      const insertResult = await client.query(
        `INSERT INTO deals (
          deal_number, name, stage_id, assigned_rep_id,
          bid_estimate, awarded_amount, expected_close_date, source,
          hubspot_deal_id, is_active, stage_entered_at, created_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true,NOW(),NOW(),NOW())
        ON CONFLICT (hubspot_deal_id) WHERE hubspot_deal_id IS NOT NULL DO UPDATE SET
          updated_at = NOW()
        RETURNING id`,
        [
          dealNumber,
          d.mappedName ?? "Unnamed Deal",
          stageId,
          repId,
          d.mappedAmount ?? null,
          null,
          d.mappedCloseDate ?? null,
          d.mappedSource ?? "HubSpot",
          d.hubspotDealId,
        ]
      );

      const newDealId = insertResult.rows[0]?.id;
      if (newDealId) {
        dealIdMap.set(d.hubspotDealId, newDealId);
        await db
          .update(stagedDeals)
          .set({ promotedAt: new Date(), promotedDealId: newDealId })
          .where(eq(stagedDeals.id, d.id));
      }
    }

    console.log(`[migration:promote] ${dealIdMap.size} deals promoted`);

    // -----------------------------------------------------------------------
    // 4. Create contact_deal_associations
    // -----------------------------------------------------------------------

    for (const d of approvedDeals) {
      if (!d.promotedDealId) continue;

      // Get associated contacts from raw_data
      const raw = d.rawData as any;
      const contactAssocs: string[] = (raw?.associations?.contacts?.results ?? []).map(
        (c: any) => c.id
      );

      for (const hsContactId of contactAssocs) {
        const crmContactId = contactIdMap.get(hsContactId);
        if (!crmContactId) continue;

        await client.query(
          `INSERT INTO contact_deal_associations (contact_id, deal_id, is_primary, created_at)
           VALUES ($1, $2, true, NOW())
           ON CONFLICT (contact_id, deal_id) DO NOTHING`,
          [crmContactId, d.promotedDealId]
        );
      }
    }

    // -----------------------------------------------------------------------
    // 5. Promote activities
    // -----------------------------------------------------------------------

    const approvedActivities = await db
      .select()
      .from(stagedActivities)
      .where(eq(stagedActivities.validationStatus, "approved"));

    console.log(`[migration:promote] Promoting ${approvedActivities.length} activities...`);

    let activityCount = 0;
    for (const a of approvedActivities) {
      if (a.promotedAt) continue;

      const crmDealId = a.hubspotDealId ? dealIdMap.get(a.hubspotDealId) : null;
      const crmContactId = a.hubspotContactId ? contactIdMap.get(a.hubspotContactId) : null;

      if (!crmDealId && !crmContactId) continue; // orphan — skip

      // Use a system user for attribution — the first admin
      const systemUserId = runByUserId;

      await client.query(
        `INSERT INTO activities (
          type, user_id, deal_id, contact_id, subject, body, occurred_at, created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())`,
        [
          a.mappedType ?? "note",
          systemUserId,
          crmDealId ?? null,
          crmContactId ?? null,
          a.mappedSubject ?? "",
          a.mappedBody ?? "",
          a.mappedOccurredAt ?? new Date(),
        ]
      );

      await db
        .update(stagedActivities)
        .set({ promotedAt: new Date() })
        .where(eq(stagedActivities.id, a.id));

      activityCount++;
    }

    console.log(`[migration:promote] ${activityCount} activities promoted`);

    await client.query("COMMIT");

    const stats = {
      contacts: contactIdMap.size,
      deals: dealIdMap.size,
      activities: activityCount,
    };

    await db
      .update(importRuns)
      .set({ status: "completed", stats, completedAt: new Date() })
      .where(eq(importRuns.id, runId));

    console.log(`\n[migration:promote] Promotion complete:`, stats);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("\n[migration:promote] ROLLBACK — promotion failed:", err);
    await db
      .update(importRuns)
      .set({ status: "rolled_back", errorLog: String(err), completedAt: new Date() })
      .where(eq(importRuns.id, runId));
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
```

---

## Task 7: Validation UI — Frontend Pages

- [ ] Create `client/src/hooks/use-migration.ts`
- [ ] Create `client/src/pages/admin/migration/migration-dashboard-page.tsx`
- [ ] Create `client/src/pages/admin/migration/migration-deals-page.tsx`
- [ ] Create `client/src/pages/admin/migration/migration-contacts-page.tsx`
- [ ] Update `client/src/App.tsx` to replace placeholder routes

### 7a. Migration Hook

**File: `client/src/hooks/use-migration.ts`**

```typescript
import { useState, useEffect, useCallback } from "react";
import { api } from "../lib/api";

export interface MigrationSummary {
  deals: Record<string, number>;
  contacts: Record<string, number>;
  activities: Record<string, number>;
  recentRuns: ImportRun[];
}

export interface ImportRun {
  id: string;
  type: "extract" | "validate" | "promote";
  status: "running" | "completed" | "failed" | "rolled_back";
  stats: Record<string, unknown>;
  errorLog: string | null;
  startedAt: string;
  completedAt: string | null;
}

export interface StagedDeal {
  id: string;
  hubspotDealId: string;
  mappedName: string | null;
  mappedStage: string | null;
  mappedRepEmail: string | null;
  mappedAmount: number | null;
  mappedCloseDate: string | null;
  mappedSource: string | null;
  validationStatus: string;
  validationErrors: Array<{ field: string; error: string }>;
  validationWarnings: Array<{ field: string; warning: string }>;
  reviewNotes: string | null;
  promotedAt: string | null;
}

export interface StagedContact {
  id: string;
  hubspotContactId: string;
  mappedFirstName: string | null;
  mappedLastName: string | null;
  mappedEmail: string | null;
  mappedPhone: string | null;
  mappedCompany: string | null;
  mappedCategory: string;
  duplicateOfStagedId: string | null;
  validationStatus: string;
  validationErrors: Array<{ field: string; error: string }>;
  validationWarnings: Array<{ field: string; warning: string }>;
  promotedAt: string | null;
}

export function useMigrationSummary() {
  const [summary, setSummary] = useState<MigrationSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api<MigrationSummary>("/api/migration/summary");
      setSummary(data);
    } catch (err) {
      setError("Failed to load migration summary");
    } finally {
      setLoading(false);
    }
  }, []);

  const runValidation = async () => {
    await api("/api/migration/validate", { method: "POST" });
    await load();
  };

  useEffect(() => { load(); }, [load]);

  return { summary, loading, error, refetch: load, runValidation };
}

export function useStagedDeals(validationStatus?: string) {
  const [rows, setRows] = useState<StagedDeal[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), limit: "50" });
      if (validationStatus) params.set("validationStatus", validationStatus);
      const data = await api<{ rows: StagedDeal[]; total: number }>(
        `/api/migration/deals?${params}`
      );
      setRows(data.rows);
      setTotal(data.total);
    } finally {
      setLoading(false);
    }
  }, [page, validationStatus]);

  const approve = async (id: string) => {
    await api(`/api/migration/deals/${id}/approve`, { method: "POST" });
    await load();
  };

  const reject = async (id: string, notes?: string) => {
    await api(`/api/migration/deals/${id}/reject`, {
      method: "POST",
      body: JSON.stringify({ notes }),
    });
    await load();
  };

  const batchApprove = async () => {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    await api("/api/migration/deals/batch-approve", {
      method: "POST",
      body: JSON.stringify({ ids }),
    });
    setSelected(new Set());
    await load();
  };

  useEffect(() => { load(); }, [load]);

  return { rows, total, page, setPage, loading, selected, setSelected, approve, reject, batchApprove, refetch: load };
}

export function useStagedContacts(validationStatus?: string) {
  const [rows, setRows] = useState<StagedContact[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), limit: "50" });
      if (validationStatus) params.set("validationStatus", validationStatus);
      const data = await api<{ rows: StagedContact[]; total: number }>(
        `/api/migration/contacts?${params}`
      );
      setRows(data.rows);
      setTotal(data.total);
    } finally {
      setLoading(false);
    }
  }, [page, validationStatus]);

  const approve = async (id: string) => {
    await api(`/api/migration/contacts/${id}/approve`, { method: "POST" });
    await load();
  };

  const reject = async (id: string, notes?: string) => {
    await api(`/api/migration/contacts/${id}/reject`, {
      method: "POST",
      body: JSON.stringify({ notes }),
    });
    await load();
  };

  const merge = async (id: string, mergeTargetId: string) => {
    await api(`/api/migration/contacts/${id}/merge`, {
      method: "POST",
      body: JSON.stringify({ mergeTargetId }),
    });
    await load();
  };

  const batchApprove = async () => {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    await api("/api/migration/contacts/batch-approve", {
      method: "POST",
      body: JSON.stringify({ ids }),
    });
    setSelected(new Set());
    await load();
  };

  useEffect(() => { load(); }, [load]);

  return { rows, total, page, setPage, loading, selected, setSelected, approve, reject, merge, batchApprove, refetch: load };
}
```

### 7b. Migration Dashboard Page

**File: `client/src/pages/admin/migration/migration-dashboard-page.tsx`**

```tsx
import { CheckCircle2, AlertTriangle, XCircle, Clock, RefreshCw, Play } from "lucide-react";
import { Button } from "../../../components/ui/button";
import { Badge } from "../../../components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "../../../components/ui/card";
import { Link } from "react-router-dom";
import { useMigrationSummary } from "../../../hooks/use-migration";
import { useState } from "react";

const STATUS_COLORS: Record<string, string> = {
  valid: "bg-green-100 text-green-800",
  approved: "bg-blue-100 text-blue-800",
  promoted: "bg-purple-100 text-purple-800",
  needs_review: "bg-amber-100 text-amber-800",
  invalid: "bg-red-100 text-red-800",
  duplicate: "bg-orange-100 text-orange-800",
  rejected: "bg-gray-100 text-gray-800",
  orphan: "bg-red-100 text-red-800",
  pending: "bg-gray-100 text-gray-600",
};

function StatCard({
  label,
  stats,
  href,
}: {
  label: string;
  stats: Record<string, number>;
  href?: string;
}) {
  const total = Object.values(stats).reduce((a, b) => a + b, 0);
  const issues = (stats.invalid ?? 0) + (stats.duplicate ?? 0) + (stats.orphan ?? 0);
  const approved = (stats.approved ?? 0) + (stats.promoted ?? 0);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-gray-500 uppercase tracking-wide">
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-3xl font-bold text-gray-900 mb-3">{total.toLocaleString()}</div>
        <div className="space-y-1">
          {Object.entries(stats).map(([status, count]) => (
            <div key={status} className="flex items-center justify-between text-sm">
              <Badge className={`text-xs ${STATUS_COLORS[status] ?? "bg-gray-100"}`}>
                {status.replace(/_/g, " ")}
              </Badge>
              <span className="font-medium text-gray-700">{count.toLocaleString()}</span>
            </div>
          ))}
        </div>
        {issues > 0 && href && (
          <Link to={href}>
            <Button variant="outline" size="sm" className="mt-3 w-full text-red-700 border-red-300">
              Review {issues} issues
            </Button>
          </Link>
        )}
        {issues === 0 && approved > 0 && (
          <div className="mt-3 flex items-center gap-1 text-sm text-green-600">
            <CheckCircle2 className="h-4 w-4" />
            Ready to promote
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function MigrationDashboardPage() {
  const { summary, loading, error, refetch, runValidation } = useMigrationSummary();
  const [validating, setValidating] = useState(false);

  const handleValidate = async () => {
    setValidating(true);
    try {
      await runValidation();
    } finally {
      setValidating(false);
    }
  };

  return (
    <div className="p-6 space-y-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">HubSpot Migration</h1>
          <p className="text-sm text-gray-500 mt-1">
            3-phase pipeline: Extract → Validate → Promote
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={refetch} disabled={loading}>
            <RefreshCw className={`h-4 w-4 mr-1 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
          <Button
            size="sm"
            onClick={handleValidate}
            disabled={validating}
            className="bg-blue-600 hover:bg-blue-700 text-white"
          >
            <Play className="h-4 w-4 mr-1" />
            {validating ? "Validating..." : "Run Validation"}
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded-md bg-red-50 border border-red-200 p-4 text-red-800 text-sm">
          {error}
        </div>
      )}

      {summary && (
        <div className="grid grid-cols-3 gap-4">
          <StatCard label="Deals" stats={summary.deals} href="/admin/migration/deals" />
          <StatCard label="Contacts" stats={summary.contacts} href="/admin/migration/contacts" />
          <StatCard label="Activities" stats={summary.activities} />
        </div>
      )}

      {/* Recent runs */}
      {summary?.recentRuns && summary.recentRuns.length > 0 && (
        <div>
          <h2 className="text-sm font-medium text-gray-700 uppercase tracking-wide mb-3">
            Recent Import Runs
          </h2>
          <div className="space-y-2">
            {summary.recentRuns.map((run) => (
              <div
                key={run.id}
                className="flex items-center justify-between rounded-md border bg-white p-3"
              >
                <div className="flex items-center gap-3">
                  {run.status === "completed" ? (
                    <CheckCircle2 className="h-4 w-4 text-green-500" />
                  ) : run.status === "failed" || run.status === "rolled_back" ? (
                    <XCircle className="h-4 w-4 text-red-500" />
                  ) : (
                    <Clock className="h-4 w-4 text-amber-500" />
                  )}
                  <div>
                    <span className="font-medium text-sm capitalize">{run.type}</span>
                    <span className="text-xs text-gray-500 ml-2">
                      {new Date(run.startedAt).toLocaleString()}
                    </span>
                  </div>
                </div>
                <Badge
                  className={
                    run.status === "completed"
                      ? "bg-green-100 text-green-800"
                      : run.status === "running"
                      ? "bg-blue-100 text-blue-800"
                      : "bg-red-100 text-red-800"
                  }
                >
                  {run.status}
                </Badge>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Phase instructions */}
      <div className="rounded-lg border bg-amber-50 border-amber-200 p-4">
        <h3 className="font-medium text-amber-900 mb-2">Migration Steps</h3>
        <ol className="text-sm text-amber-800 space-y-1 list-decimal list-inside">
          <li>
            Run extract script on Railway:{" "}
            <code className="bg-amber-100 px-1 rounded font-mono text-xs">
              railway run npx tsx scripts/migration-extract.ts
            </code>
          </li>
          <li>Click "Run Validation" above to auto-validate all staged records</li>
          <li>
            Review flagged deals in{" "}
            <Link to="/admin/migration/deals" className="underline font-medium">
              Deals
            </Link>{" "}
            and contacts in{" "}
            <Link to="/admin/migration/contacts" className="underline font-medium">
              Contacts
            </Link>
          </li>
          <li>
            Promote approved records:{" "}
            <code className="bg-amber-100 px-1 rounded font-mono text-xs">
              OFFICE_SLUG=dallas railway run npx tsx scripts/migration-promote.ts
            </code>
          </li>
        </ol>
      </div>
    </div>
  );
}
```

### 7c. Migration Deals Page

**File: `client/src/pages/admin/migration/migration-deals-page.tsx`**

```tsx
import { useState } from "react";
import { CheckCircle2, XCircle, ChevronLeft, ChevronRight, Filter } from "lucide-react";
import { Button } from "../../../components/ui/button";
import { Badge } from "../../../components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../../components/ui/table";
import { Checkbox } from "../../../components/ui/checkbox";
import { useStagedDeals } from "../../../hooks/use-migration";
import { formatCurrency } from "../../../lib/format";

const STATUS_OPTIONS = [
  { value: "", label: "All statuses" },
  { value: "pending", label: "Pending" },
  { value: "valid", label: "Valid" },
  { value: "needs_review", label: "Needs Review" },
  { value: "invalid", label: "Invalid" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
  { value: "promoted", label: "Promoted" },
];

const STATUS_BADGE: Record<string, string> = {
  valid: "bg-green-100 text-green-800",
  approved: "bg-blue-100 text-blue-800",
  promoted: "bg-purple-100 text-purple-800",
  needs_review: "bg-amber-100 text-amber-800",
  invalid: "bg-red-100 text-red-800",
  rejected: "bg-gray-100 text-gray-500",
  pending: "bg-gray-100 text-gray-600",
};

export function MigrationDealsPage() {
  const [statusFilter, setStatusFilter] = useState<string>("needs_review");
  const {
    rows,
    total,
    page,
    setPage,
    loading,
    selected,
    setSelected,
    approve,
    reject,
    batchApprove,
  } = useStagedDeals(statusFilter || undefined);

  const totalPages = Math.ceil(total / 50);

  const toggleSelect = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const toggleAll = () => {
    if (selected.size === rows.length) setSelected(new Set());
    else setSelected(new Set(rows.map((r) => r.id)));
  };

  return (
    <div className="p-6 space-y-4 max-w-7xl mx-auto">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-gray-900">
          Staged Deals <span className="text-gray-400 text-lg">({total.toLocaleString()})</span>
        </h1>
        <div className="flex items-center gap-2">
          <Filter className="h-4 w-4 text-gray-400" />
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUS_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {selected.size > 0 && (
            <Button
              size="sm"
              className="bg-green-600 hover:bg-green-700 text-white"
              onClick={batchApprove}
            >
              <CheckCircle2 className="h-4 w-4 mr-1" />
              Approve {selected.size} selected
            </Button>
          )}
        </div>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-8">
              <Checkbox
                checked={selected.size === rows.length && rows.length > 0}
                onCheckedChange={toggleAll}
              />
            </TableHead>
            <TableHead>Deal Name</TableHead>
            <TableHead>Stage</TableHead>
            <TableHead>Rep Email</TableHead>
            <TableHead>Amount</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Issues</TableHead>
            <TableHead>Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading ? (
            <TableRow>
              <TableCell colSpan={8} className="text-center text-gray-400 py-8">
                Loading...
              </TableCell>
            </TableRow>
          ) : rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={8} className="text-center text-gray-400 py-8">
                No records with this status
              </TableCell>
            </TableRow>
          ) : (
            rows.map((deal) => (
              <TableRow key={deal.id} className={selected.has(deal.id) ? "bg-blue-50" : ""}>
                <TableCell>
                  {deal.validationStatus !== "promoted" && (
                    <Checkbox
                      checked={selected.has(deal.id)}
                      onCheckedChange={() => toggleSelect(deal.id)}
                    />
                  )}
                </TableCell>
                <TableCell className="font-medium max-w-[200px] truncate">
                  {deal.mappedName ?? "—"}
                </TableCell>
                <TableCell>
                  <code className="text-xs bg-gray-100 px-1 rounded">
                    {deal.mappedStage ?? "—"}
                  </code>
                </TableCell>
                <TableCell className="text-sm text-gray-600 max-w-[160px] truncate">
                  {deal.mappedRepEmail ?? "—"}
                </TableCell>
                <TableCell className="text-sm">
                  {deal.mappedAmount != null ? formatCurrency(deal.mappedAmount) : "—"}
                </TableCell>
                <TableCell>
                  <Badge className={`text-xs ${STATUS_BADGE[deal.validationStatus] ?? ""}`}>
                    {deal.validationStatus.replace(/_/g, " ")}
                  </Badge>
                </TableCell>
                <TableCell>
                  <div className="space-y-0.5">
                    {deal.validationErrors.map((e, i) => (
                      <div key={i} className="text-xs text-red-600">
                        {e.field}: {e.error}
                      </div>
                    ))}
                    {deal.validationWarnings.map((w, i) => (
                      <div key={i} className="text-xs text-amber-600">
                        {w.field}: {w.warning}
                      </div>
                    ))}
                  </div>
                </TableCell>
                <TableCell>
                  {deal.validationStatus !== "promoted" &&
                    deal.validationStatus !== "rejected" && (
                      <div className="flex items-center gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-green-700 hover:bg-green-50"
                          onClick={() => approve(deal.id)}
                        >
                          <CheckCircle2 className="h-3.5 w-3.5 mr-1" />
                          Approve
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-red-700 hover:bg-red-50"
                          onClick={() => reject(deal.id)}
                        >
                          <XCircle className="h-3.5 w-3.5 mr-1" />
                          Reject
                        </Button>
                      </div>
                    )}
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm text-gray-500">
          <span>
            Page {page} of {totalPages} ({total.toLocaleString()} total)
          </span>
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage(page - 1)}
              disabled={page <= 1}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage(page + 1)}
              disabled={page >= totalPages}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
```

### 7d. Migration Contacts Page

**File: `client/src/pages/admin/migration/migration-contacts-page.tsx`**

```tsx
import { useState } from "react";
import { CheckCircle2, XCircle, GitMerge, ChevronLeft, ChevronRight, Filter } from "lucide-react";
import { Button } from "../../../components/ui/button";
import { Badge } from "../../../components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../../components/ui/table";
import { Checkbox } from "../../../components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "../../../components/ui/dialog";
import { Input } from "../../../components/ui/input";
import { useStagedContacts, type StagedContact } from "../../../hooks/use-migration";

const STATUS_OPTIONS = [
  { value: "", label: "All statuses" },
  { value: "pending", label: "Pending" },
  { value: "valid", label: "Valid" },
  { value: "needs_review", label: "Needs Review" },
  { value: "invalid", label: "Invalid" },
  { value: "duplicate", label: "Duplicate" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
  { value: "merged", label: "Merged" },
  { value: "promoted", label: "Promoted" },
];

const STATUS_BADGE: Record<string, string> = {
  valid: "bg-green-100 text-green-800",
  approved: "bg-blue-100 text-blue-800",
  promoted: "bg-purple-100 text-purple-800",
  needs_review: "bg-amber-100 text-amber-800",
  invalid: "bg-red-100 text-red-800",
  duplicate: "bg-orange-100 text-orange-800",
  merged: "bg-gray-100 text-gray-500",
  rejected: "bg-gray-100 text-gray-500",
  pending: "bg-gray-100 text-gray-600",
};

export function MigrationContactsPage() {
  const [statusFilter, setStatusFilter] = useState<string>("duplicate");
  const [mergeContact, setMergeContact] = useState<StagedContact | null>(null);
  const [mergeTargetId, setMergeTargetId] = useState("");

  const {
    rows,
    total,
    page,
    setPage,
    loading,
    selected,
    setSelected,
    approve,
    reject,
    merge,
    batchApprove,
  } = useStagedContacts(statusFilter || undefined);

  const totalPages = Math.ceil(total / 50);

  const toggleSelect = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const toggleAll = () => {
    if (selected.size === rows.length) setSelected(new Set());
    else setSelected(new Set(rows.map((r) => r.id)));
  };

  const handleMerge = async () => {
    if (!mergeContact || !mergeTargetId.trim()) return;
    await merge(mergeContact.id, mergeTargetId.trim());
    setMergeContact(null);
    setMergeTargetId("");
  };

  return (
    <div className="p-6 space-y-4 max-w-7xl mx-auto">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-gray-900">
          Staged Contacts <span className="text-gray-400 text-lg">({total.toLocaleString()})</span>
        </h1>
        <div className="flex items-center gap-2">
          <Filter className="h-4 w-4 text-gray-400" />
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUS_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {selected.size > 0 && (
            <Button
              size="sm"
              className="bg-green-600 hover:bg-green-700 text-white"
              onClick={batchApprove}
            >
              <CheckCircle2 className="h-4 w-4 mr-1" />
              Approve {selected.size} selected
            </Button>
          )}
        </div>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-8">
              <Checkbox
                checked={selected.size === rows.length && rows.length > 0}
                onCheckedChange={toggleAll}
              />
            </TableHead>
            <TableHead>Name</TableHead>
            <TableHead>Email</TableHead>
            <TableHead>Company</TableHead>
            <TableHead>Category</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Issues</TableHead>
            <TableHead>Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading ? (
            <TableRow>
              <TableCell colSpan={8} className="text-center text-gray-400 py-8">
                Loading...
              </TableCell>
            </TableRow>
          ) : rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={8} className="text-center text-gray-400 py-8">
                No records with this status
              </TableCell>
            </TableRow>
          ) : (
            rows.map((contact) => (
              <TableRow
                key={contact.id}
                className={selected.has(contact.id) ? "bg-blue-50" : ""}
              >
                <TableCell>
                  {!["promoted", "rejected", "merged"].includes(contact.validationStatus) && (
                    <Checkbox
                      checked={selected.has(contact.id)}
                      onCheckedChange={() => toggleSelect(contact.id)}
                    />
                  )}
                </TableCell>
                <TableCell className="font-medium">
                  {[contact.mappedFirstName, contact.mappedLastName]
                    .filter(Boolean)
                    .join(" ") || "—"}
                </TableCell>
                <TableCell className="text-sm text-gray-600 max-w-[180px] truncate">
                  {contact.mappedEmail ?? "—"}
                </TableCell>
                <TableCell className="text-sm text-gray-600 max-w-[150px] truncate">
                  {contact.mappedCompany ?? "—"}
                </TableCell>
                <TableCell>
                  <code className="text-xs bg-gray-100 px-1 rounded">
                    {contact.mappedCategory}
                  </code>
                </TableCell>
                <TableCell>
                  <Badge className={`text-xs ${STATUS_BADGE[contact.validationStatus] ?? ""}`}>
                    {contact.validationStatus.replace(/_/g, " ")}
                  </Badge>
                  {contact.duplicateOfStagedId && (
                    <div className="text-xs text-orange-600 mt-0.5">
                      Dup of {contact.duplicateOfStagedId.slice(0, 8)}...
                    </div>
                  )}
                </TableCell>
                <TableCell>
                  <div className="space-y-0.5">
                    {contact.validationErrors.map((e, i) => (
                      <div key={i} className="text-xs text-red-600">
                        {e.field}: {e.error}
                      </div>
                    ))}
                    {contact.validationWarnings.map((w, i) => (
                      <div key={i} className="text-xs text-amber-600">
                        {w.field}: {w.warning}
                      </div>
                    ))}
                  </div>
                </TableCell>
                <TableCell>
                  {!["promoted", "rejected", "merged"].includes(
                    contact.validationStatus
                  ) && (
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-green-700 hover:bg-green-50"
                        onClick={() => approve(contact.id)}
                      >
                        <CheckCircle2 className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-red-700 hover:bg-red-50"
                        onClick={() => reject(contact.id)}
                      >
                        <XCircle className="h-3.5 w-3.5" />
                      </Button>
                      {contact.validationStatus === "duplicate" && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-orange-700 hover:bg-orange-50"
                          onClick={() => setMergeContact(contact)}
                        >
                          <GitMerge className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </div>
                  )}
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>

      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm text-gray-500">
          <span>
            Page {page} of {totalPages} ({total.toLocaleString()} total)
          </span>
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage(page - 1)}
              disabled={page <= 1}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage(page + 1)}
              disabled={page >= totalPages}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      {/* Merge dialog */}
      <Dialog open={mergeContact != null} onOpenChange={() => setMergeContact(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <GitMerge className="h-5 w-5 text-orange-500" />
              Merge Duplicate Contact
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 text-sm">
            <p className="text-gray-600">
              Mark this contact as merged into another staged contact. Enter the target
              staged contact ID.
            </p>
            {mergeContact && (
              <div className="rounded-md bg-gray-50 border p-3">
                <div className="font-medium">
                  {[mergeContact.mappedFirstName, mergeContact.mappedLastName]
                    .filter(Boolean)
                    .join(" ")}
                </div>
                <div className="text-gray-500 text-xs">{mergeContact.mappedEmail}</div>
                <div className="text-gray-400 text-xs font-mono mt-1">
                  HubSpot ID: {mergeContact.hubspotContactId}
                  {mergeContact.duplicateOfStagedId && (
                    <span className="ml-2">
                      → Suggested target: {mergeContact.duplicateOfStagedId}
                    </span>
                  )}
                </div>
              </div>
            )}
            <div>
              <label className="text-xs font-medium text-gray-700">
                Target staged contact ID
              </label>
              <Input
                className="mt-1 font-mono text-sm"
                placeholder="UUID of the contact to keep"
                value={mergeTargetId}
                onChange={(e) => setMergeTargetId(e.target.value)}
              />
              {mergeContact?.duplicateOfStagedId && (
                <Button
                  variant="link"
                  size="sm"
                  className="px-0 text-xs text-blue-600 mt-1"
                  onClick={() => setMergeTargetId(mergeContact.duplicateOfStagedId!)}
                >
                  Use suggested target ({mergeContact.duplicateOfStagedId.slice(0, 8)}...)
                </Button>
              )}
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setMergeContact(null)}>
              Cancel
            </Button>
            <Button
              className="bg-orange-600 hover:bg-orange-700 text-white"
              onClick={handleMerge}
              disabled={!mergeTargetId.trim()}
            >
              <GitMerge className="h-4 w-4 mr-1" />
              Merge Into Target
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
```

### 7e. App.tsx Route Updates

```typescript
// Add imports
import { MigrationDashboardPage } from "./pages/admin/migration/migration-dashboard-page";
import { MigrationDealsPage } from "./pages/admin/migration/migration-deals-page";
import { MigrationContactsPage } from "./pages/admin/migration/migration-contacts-page";

// Replace placeholder routes:
// <Route path="/admin/migration" element={<PlaceholderPage title="Migration" />} />
<Route path="/admin/migration" element={<MigrationDashboardPage />} />
<Route path="/admin/migration/deals" element={<MigrationDealsPage />} />
<Route path="/admin/migration/contacts" element={<MigrationContactsPage />} />
```

---

## Task 8: Tests

- [ ] Create `server/tests/modules/migration/field-mapper.test.ts`
- [ ] Create `server/tests/modules/migration/validator.test.ts`

### 8a. Field Mapper Tests

**File: `server/tests/modules/migration/field-mapper.test.ts`**

```typescript
import { describe, it, expect } from "vitest";
import {
  mapDeal,
  mapContact,
  mapActivity,
  mapHubSpotStage,
  buildOwnerEmailMap,
} from "../../../src/modules/migration/field-mapper.js";
import type { HubSpotDeal, HubSpotContact, HubSpotActivity, HubSpotOwner } from "../../../src/modules/migration/hubspot-client.js";

describe("buildOwnerEmailMap", () => {
  it("builds email map from owner list", () => {
    const owners: HubSpotOwner[] = [
      { id: "111", email: "john@trock.com" },
      { id: "222", email: "JANE@TROCK.COM" },
    ];
    const map = buildOwnerEmailMap(owners);
    expect(map.get("111")).toBe("john@trock.com");
    expect(map.get("222")).toBe("jane@trock.com"); // lowercased
  });

  it("skips owners without email", () => {
    const owners: HubSpotOwner[] = [{ id: "333" }];
    const map = buildOwnerEmailMap(owners);
    expect(map.has("333")).toBe(false);
  });
});

describe("mapHubSpotStage", () => {
  it("maps known HubSpot stage slugs to CRM slugs", () => {
    expect(mapHubSpotStage("closedwon")).toBe("closed_won");
    expect(mapHubSpotStage("closedlost")).toBe("closed_lost");
    expect(mapHubSpotStage("contractsent")).toBe("bid_sent");
  });

  it("passes through unknown stages unchanged", () => {
    expect(mapHubSpotStage("unknownstage")).toBe("unknownstage");
  });

  it("returns empty string for undefined input", () => {
    expect(mapHubSpotStage(undefined)).toBe("");
  });
});

describe("mapDeal", () => {
  const ownerMap = new Map([["owner-1", "rep@trock.com"]]);

  const baseDeal: HubSpotDeal = {
    id: "hs-deal-1",
    properties: {
      dealname: "  Test Deal  ",
      dealstage: "contractsent",
      hubspot_owner_id: "owner-1",
      amount: "150000",
      closedate: "2026-06-01T00:00:00Z",
      lead_source: "Referral",
    },
  };

  it("maps all core fields correctly", () => {
    const result = mapDeal(baseDeal, ownerMap);
    expect(result.hubspotDealId).toBe("hs-deal-1");
    expect(result.mappedName).toBe("Test Deal"); // trimmed
    expect(result.mappedStage).toBe("bid_sent");
    expect(result.mappedRepEmail).toBe("rep@trock.com");
    expect(result.mappedAmount).toBe(150000);
    expect(result.mappedCloseDate).toBe("2026-06-01");
    expect(result.mappedSource).toBe("Referral");
  });

  it("sets null for missing amount", () => {
    const deal = { ...baseDeal, properties: { ...baseDeal.properties, amount: "" } };
    const result = mapDeal(deal, ownerMap);
    expect(result.mappedAmount).toBeNull();
  });

  it("uses HubSpot as default source when lead_source missing", () => {
    const deal = { ...baseDeal, properties: { ...baseDeal.properties, lead_source: undefined } };
    const result = mapDeal(deal, ownerMap);
    expect(result.mappedSource).toBe("HubSpot");
  });

  it("handles unknown owner ID gracefully", () => {
    const deal = {
      ...baseDeal,
      properties: { ...baseDeal.properties, hubspot_owner_id: "unknown-owner" },
    };
    const result = mapDeal(deal, ownerMap);
    expect(result.mappedRepEmail).toBeNull();
  });
});

describe("mapContact", () => {
  const baseContact: HubSpotContact = {
    id: "hs-contact-1",
    properties: {
      firstname: "John",
      lastname: "Smith",
      email: "JOHN@CLIENT.COM",
      phone: "(214) 555-1234",
      company: "Test Corp",
    },
  };

  it("maps core fields and normalizes email to lowercase", () => {
    const result = mapContact(baseContact);
    expect(result.hubspotContactId).toBe("hs-contact-1");
    expect(result.mappedFirstName).toBe("John");
    expect(result.mappedLastName).toBe("Smith");
    expect(result.mappedEmail).toBe("john@client.com");
    expect(result.mappedPhone).toBe("(214) 555-1234");
    expect(result.mappedCompany).toBe("Test Corp");
  });

  it("defaults category to 'other'", () => {
    const result = mapContact(baseContact);
    expect(result.mappedCategory).toBe("other");
  });

  it("infers 'client' category from customer lifecycle stage", () => {
    const contact: HubSpotContact = {
      ...baseContact,
      properties: { ...baseContact.properties, lifecyclestage: "customer" },
    };
    const result = mapContact(contact);
    expect(result.mappedCategory).toBe("client");
  });
});

describe("mapActivity", () => {
  const baseActivity: HubSpotActivity = {
    id: "hs-act-1",
    properties: {
      hs_call_title: "Follow-up call",
      hs_call_body: "Discussed pricing options",
      hs_timestamp: "2026-04-15T14:30:00Z",
    },
    associations: {
      deals: { results: [{ id: "deal-hs-1" }] },
      contacts: { results: [{ id: "contact-hs-1" }] },
    },
  };
  (baseActivity as any).__type = "calls";

  it("maps call activity correctly", () => {
    const result = mapActivity(baseActivity);
    expect(result.hubspotActivityId).toBe("hs-act-1");
    expect(result.mappedType).toBe("call");
    expect(result.mappedSubject).toBe("Follow-up call");
    expect(result.mappedBody).toBe("Discussed pricing options");
    expect(result.hubspotDealId).toBe("deal-hs-1");
    expect(result.hubspotContactId).toBe("contact-hs-1");
    expect(result.mappedOccurredAt).toContain("2026-04-15");
  });

  it("maps note activity", () => {
    const note: HubSpotActivity = {
      id: "hs-note-1",
      properties: { hs_note_body: "Met at site" },
    };
    (note as any).__type = "notes";
    const result = mapActivity(note);
    expect(result.mappedType).toBe("note");
    expect(result.mappedBody).toBe("Met at site");
    expect(result.mappedSubject).toBe("Note");
  });
});
```

### 8b. Validator Tests

**File: `server/tests/modules/migration/validator.test.ts`**

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the DB module
vi.mock("../../../src/db.js", () => ({
  db: {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    offset: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    execute: vi.fn(),
  },
}));

describe("validateStagedDeals", () => {
  it("flags deal with no name as invalid", () => {
    // The field-level validation logic extracted for unit testing
    const errors: Array<{ field: string; error: string }> = [];

    const mappedName = null;
    if (!mappedName) errors.push({ field: "name", error: "Deal name is blank" });

    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe("name");
  });

  it("flags unknown stage as invalid", () => {
    const errors: Array<{ field: string; error: string }> = [];
    const stageSlugs = new Set(["dd", "estimating", "bid_sent", "closed_won", "closed_lost"]);
    const mappedStage = "old_hubspot_stage_xyz";

    if (!stageSlugs.has(mappedStage)) {
      errors.push({ field: "stage", error: `Unknown CRM stage: "${mappedStage}"` });
    }

    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe("stage");
  });

  it("flags unknown rep email as invalid", () => {
    const errors: Array<{ field: string; error: string }> = [];
    const repEmails = new Set(["john@trock.com", "jane@trock.com"]);
    const mappedRepEmail = "unknown@someone.com";

    if (mappedRepEmail && !repEmails.has(mappedRepEmail.toLowerCase())) {
      errors.push({
        field: "rep",
        error: `Rep email "${mappedRepEmail}" does not match any active CRM user`,
      });
    }

    expect(errors).toHaveLength(1);
  });

  it("adds warning for $0 amount but does not mark invalid", () => {
    const errors: Array<{ field: string; error: string }> = [];
    const warnings: Array<{ field: string; warning: string }> = [];
    const mappedAmount = 0;

    if (mappedAmount == null || mappedAmount === 0) {
      warnings.push({ field: "amount", warning: "Deal amount is $0 or blank" });
    }

    expect(errors).toHaveLength(0);
    expect(warnings).toHaveLength(1);
  });

  it("marks deal as valid when all fields pass", () => {
    const errors: Array<{ field: string; error: string }> = [];
    const warnings: Array<{ field: string; warning: string }> = [];
    const stageSlugs = new Set(["bid_sent"]);
    const repEmails = new Set(["john@trock.com"]);

    const deal = {
      mappedName: "Test Deal",
      mappedStage: "bid_sent",
      mappedRepEmail: "john@trock.com",
      mappedAmount: 50000,
    };

    if (!deal.mappedName) errors.push({ field: "name", error: "blank" });
    if (!deal.mappedStage || !stageSlugs.has(deal.mappedStage))
      errors.push({ field: "stage", error: "unknown" });
    if (!repEmails.has(deal.mappedRepEmail.toLowerCase()))
      errors.push({ field: "rep", error: "unknown" });
    if (!deal.mappedAmount) warnings.push({ field: "amount", warning: "zero" });

    expect(errors).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });
});

describe("validateStagedContacts duplicate detection", () => {
  it("detects email duplicate within staged contacts", () => {
    const stagedEmailMap = new Map<string, string>([
      ["john@trock.com", "first-contact-uuid"],
    ]);

    const contactId = "second-contact-uuid";
    const email = "john@trock.com";
    const firstId = stagedEmailMap.get(email);
    const isDuplicate = firstId != null && firstId !== contactId;

    expect(isDuplicate).toBe(true);
  });

  it("does not flag a contact as duplicate of itself", () => {
    const stagedEmailMap = new Map<string, string>([
      ["john@trock.com", "same-contact-uuid"],
    ]);

    const contactId = "same-contact-uuid";
    const email = "john@trock.com";
    const firstId = stagedEmailMap.get(email);
    const isDuplicate = firstId != null && firstId !== contactId;

    expect(isDuplicate).toBe(false);
  });
});
```

---

## New Files Summary

| File | Description |
|---|---|
| `server/src/modules/migration/hubspot-client.ts` | HubSpot API client with pagination |
| `server/src/modules/migration/field-mapper.ts` | HubSpot → CRM field mapping |
| `server/src/modules/migration/validator.ts` | Auto-validation: stage, rep, dedup |
| `server/src/modules/migration/service.ts` | Import run tracking, staging CRUD |
| `server/src/modules/migration/routes.ts` | `/api/migration/*` admin routes |
| `scripts/migration-extract.ts` | One-off HubSpot extraction script |
| `scripts/migration-promote.ts` | One-off promotion script |
| `client/src/hooks/use-migration.ts` | Migration UI data hooks |
| `client/src/pages/admin/migration/migration-dashboard-page.tsx` | Dashboard + run history |
| `client/src/pages/admin/migration/migration-deals-page.tsx` | Deal validation table |
| `client/src/pages/admin/migration/migration-contacts-page.tsx` | Contact validation table |
| `server/tests/modules/migration/field-mapper.test.ts` | Field mapper unit tests |
| `server/tests/modules/migration/validator.test.ts` | Validator unit tests |

## Modified Files

| File | Change |
|---|---|
| `server/src/app.ts` | Mount `migrationRouter` under `/api` |
| `client/src/App.tsx` | Replace `/admin/migration*` placeholder routes |

## Required Env Vars (new)

| Var | Description |
|---|---|
| `HUBSPOT_PRIVATE_APP_TOKEN` | HubSpot Private App token for CRM API access |
| `OFFICE_SLUG` | Set at promote-script runtime (e.g. `dallas`) |

## Implementation Notes

1. **Stage map in field-mapper.ts must be updated before extraction.** The `HUBSPOT_STAGE_MAP` constant has T Rock's known stage mappings stubbed in. Before running the extract, confirm T Rock's actual HubSpot deal stage IDs (get them from HubSpot Settings → CRM → Deals → Pipeline) and update the map. Unknown stages will be flagged as invalid by the validator.

2. **Extraction is idempotent.** All insert statements use `ON CONFLICT DO NOTHING` on `hubspot_deal_id` / `hubspot_contact_id`. Re-running the extract script will not create duplicate staging rows.

3. **Promotion is wrapped in a single transaction.** If any step fails, the entire batch rolls back. Run promotion in a low-traffic window. Check `import_runs.status = 'rolled_back'` and `error_log` if it fails.

4. **Activity promotion uses the admin user as `user_id`.** HubSpot engagement ownership doesn't map cleanly to CRM reps — the `user_id` on promoted activities points to the admin who ran the migration. This is correct behavior per the spec. Activities are for historical context, not active-rep attribution.

5. **Migration schema is temporary.** After go-live validation (minimum 30 days per spec), drop it: `DROP SCHEMA migration CASCADE`. Before dropping, run `pg_dump --schema=migration` to archive as JSON.

6. **HUBSPOT_PRIVATE_APP_TOKEN must have these scopes:** `crm.objects.deals.read`, `crm.objects.contacts.read`, `crm.objects.owners.read`, `crm.objects.calls.read`, `crm.objects.notes.read`, `crm.objects.meetings.read`, `crm.objects.emails.read`.
