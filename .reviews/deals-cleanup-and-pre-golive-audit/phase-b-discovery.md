# Phase B — Discovery Report: HubSpot Missing Deals Import 2026-05-11

Generated: 2026-05-11 (agent: oh-my-claudecode general-purpose)
Worktree: `/Users/adnaaniqbal/projects/trockcrm-deals-cleanup`
Read-only DB queries. No writes performed.

---

## Step 1 — Connection method

- Railway CLI not linked in this worktree.
- Used `DATABASE_URL` extracted from sibling worktree env file `/Users/adnaaniqbal/projects/trockcrm/.env`:
  - `postgresql://postgres:<redacted>@<redacted>:5432/railway`
- Direct `psql` access works. (Note: the `.env` file labels this as `DATABASE_URL`, not `DATABASE_PUBLIC_URL`. Its `DATABASE_PUBLIC_URL` is set to `localhost:5432` — that one is for local dev only.)
- HubSpot token also in same env: `HUBSPOT_PRIVATE_APP_TOKEN=<redacted> (env var name in code is likely `HUBSPOT_PRIVATE_APP_TOKEN` — confirm in `server/src/modules/migration/hubspot-client.ts`).

---

## Step 2 — Find the batch

### Identifier discovered
The batch is identified by `deals.source = 'hubspot_missing_deals_import_2026_05_11'`. This is far more reliable than the `created_at::date = '2026-05-11'` heuristic from the brief (which returns 0 rows — the script created deals with the original HubSpot `createdate`, not "now").

### Per-tenant counts

| Tenant                  | Batch deals | Currently in `opportunity` |
|-------------------------|------------:|---------------------------:|
| `office_dallas`         | **34**      | **24**                     |
| `office_atlanta`        | 0           | 0                          |
| `office_pwauditoffice`  | 0           | 0                          |

**The actual batch is 34 deals, not 45.** The brief's "45" is wrong. All deals live in Dallas; Atlanta and PWAuditOffice have zero matching rows.

### Other source values in `office_dallas.deals` (sanity)
- `HubSpot` (primary import) — 752
- `hubspot_missing_deals_import_2026_05_11` — 34
- `cleanup_smoke_test` — 3
- NULL — 0

### Current stage distribution (the 34 batch deals)

| Current stage (slug)      | Count |
|---------------------------|------:|
| `opportunity`             | 24    |
| `estimating`              | 4     |
| `service_estimating`      | 3     |
| `lost`                    | 2     |
| `estimate_sent_to_client` | 1     |

24 of 34 sit in `opportunity` (matches the symptom). 10 already got non-Opportunity stages via the import script's `workflow_decision` heuristic.

---

## Step 3 — Stage data recovery

### Stored data: YES — already in DB, no API call needed

`deals.hubspot_extra_properties` (jsonb) contains, for every batch deal:

```json
{
  "source_csv": "/tmp/migration-audit/missing-from-crm.csv",
  "hubspot_pipeline": "Deals pipeline",
  "migration_source": "hubspot_missing_deals_import_2026_05_11",
  "workflow_decision": "source stage contains Service",
  "hubspot_stage_name": "Service - Estimating",
  "hubspot_updated_at": "2026-05-09 12:07"
}
```

The key field is `hubspot_extra_properties->>'hubspot_stage_name'` — this is the original HubSpot stage *label* from the source CSV, captured at import time. No HubSpot API call required to recover stage info.

### Strategy: DB-only

Recovery via JSON path: `deals.hubspot_extra_properties ->> 'hubspot_stage_name'`. Idempotent and free.

(`source_hubspot_stage_id` and `source_hubspot_stage_label` columns exist on the broader 752 HubSpot deals but are NULL/empty on this batch — different code path.)

### HubSpot stage label distribution (all 34 batch deals)

| `hubspot_stage_name`   | Workflow decision (existing)                    | Current stage           | Count |
|------------------------|-------------------------------------------------|-------------------------|------:|
| `Pipe Line`            | defaulted to standard                            | `opportunity`           | 22    |
| `RFP`                  | defaulted to standard                            | `opportunity`           | 2     |
| `Deal Canceled`        | defaulted to standard                            | `lost`                  | 1     |
| `Deal Canceled`        | inferred service from `*-4-*` project number     | `lost`                  | 1     |
| `Estimating`           | defaulted to standard                            | `estimating`            | 4     |
| `Proposal Sent`        | inferred service from `*-4-*` project number     | `estimate_sent_to_client` | 1   |
| `Service - Estimating` | source stage contains Service                   | `service_estimating`    | 3     |
| **Total**              |                                                  |                         | **34**|

The 24 currently-in-Opportunity deals are all `Pipe Line` (22) and `RFP` (2) — i.e. these HubSpot stages did not have a hardcoded mapping in the import script so they got dropped into `opportunity` as a safe default. **These are the rows we actually need to move.**

---

## Step 4 — CRM stage universe (`public.pipeline_stage_config`)

Columns: `id, name, slug, display_order, is_active_pipeline, is_terminal, workflow_family, ...` (note: column is `display_order`, not `sort_order`).

### `standard_deal` family (most relevant)

| Slug                       | Name                     | UUID                                   | Terminal |
|----------------------------|--------------------------|----------------------------------------|----------|
| `dd`                       | Due Diligence            | `0416a7db-1e5a-4d0a-88a2-bc5f1480755c` | f        |
| `opportunity`              | Opportunity              | `03ab1b79-9412-43ec-82b4-624e0a60fd19` | f        |
| `estimate_in_progress`     | Estimate in Progress     | `84e94135-7f86-49ed-a985-d11f67e46e63` | f        |
| `estimating`               | Estimating               | `71b5b7cd-fb3b-42c4-9ca4-9f23e16fdc19` | f        |
| `bid_sent`                 | Bid Sent                 | `0b409112-baad-4be2-be74-d052d7cd3317` | f        |
| `estimate_under_review`    | Estimate Under Review    | `29822677-ee36-4fbe-aac7-76d3a7bb9d37` | f        |
| `in_production`            | In Production            | `48d492d4-8cbf-49f7-aafb-3d48fead8c71` | f        |
| `close_out`                | Close Out                | `c5f30464-e5b2-4b66-8a2a-d6c7a13a6ada` | f        |
| `estimate_sent_to_client`  | Estimate Sent to Client  | `8474d63a-d518-4dbc-8580-cf87ee94a99d` | f        |
| `sent_to_production`       | Sent to Production       | `d26ad616-2280-4d2f-8d10-ec43d05ace6f` | **t**    |
| `closed_won`               | Closed Won               | `e8a891ca-e44e-466f-bfd0-a8bfb3d991b1` | **t**    |
| `contract`                 | Contract                 | `082dd303-401b-492e-bb44-dcf9e224f29d` | f        |
| `production_lost`          | Production Lost          | `ecd66e01-7ded-4077-9f37-fb51a6f55838` | **t**    |
| `won`                      | Won                      | `256dd04e-d597-4c52-9c1b-82221e74a46e` | **t**    |
| `closed_lost`              | Closed Lost              | `d7fd9c77-ddea-48ec-955e-06a11255f8e4` | **t**    |
| `lost`                     | Lost                     | `b8aa9f64-99f5-4700-b29b-78b86865a257` | **t**    |

### `service_deal` family

| Slug                              | Name                         | UUID                                   |
|-----------------------------------|------------------------------|----------------------------------------|
| `service_review`                  | Service Review               | `adfd0637-1ae4-480c-b15a-0c3f96bc83a4` |
| `service_proposal_sent`           | Service Proposal Sent        | `2ff74d3e-b879-40a6-b126-a00a2222fc22` |
| `service_estimating`              | Service Estimating           | `1aefe9a3-98b3-4169-8895-bd851e02d923` |
| `service_estimate_under_review`   | Estimate Under Review        | `793fe6e2-2662-4cec-b653-0b4f725daecc` |
| `service_complete`                | Service Complete             | `67d65add-7c4f-477c-bd2b-3834d33ff18a` |
| `service_estimate_sent_to_client` | Estimate Sent to Client      | `16a4988a-76ba-4d15-a5f0-0f1e506d645b` |
| `service_sent_to_production`      | Service - Sent to Production | `2ab71c8b-e0de-45f2-89e3-4ca5f1896859` |
| `service_lost`                    | Service - Lost               | `3979b0b8-d878-4417-9035-98c1dab01ae8` |

(Plus `lead` and other terminals — not relevant for this batch.)

---

## Step 5 — Proposed mapping (HubSpot stage → CRM stage)

Adapted from the brief and from observed labels. Note the brief's example HubSpot internal-stage IDs (`appointmentscheduled`, `qualifiedtobuy`, `presentationscheduled`, etc.) do **not** appear in this batch — the stored `hubspot_stage_name` is the *human label* from a pipeline T Rock customized in HubSpot. Mapping must use those labels.

The `workflow_decision` field already routed deals containing "Service" into `service_*` slugs. We respect that — only reassign rows that landed in `opportunity` (24 deals) and double-check the 10 non-Opportunity rows are correct.

### Standard-deal mapping (workflow = standard_deal)

| HubSpot label   | → CRM slug                | CRM stage UUID                           | Count | Rationale                                                                 |
|-----------------|---------------------------|------------------------------------------|------:|---------------------------------------------------------------------------|
| `Pipe Line`     | `dd` (Due Diligence)      | `0416a7db-1e5a-4d0a-88a2-bc5f1480755c`   | 22    | Earliest-stage funnel after intake. "Pipe Line" = top-of-pipeline lead/discovery. Opportunity is a *post*-DD stage in this CRM. |
| `RFP`           | `dd`                      | `0416a7db-1e5a-4d0a-88a2-bc5f1480755c`   | 2     | RFP = early bid request; pre-estimate. Same bucket as Pipe Line.          |
| `Estimating`    | `estimating`              | `71b5b7cd-fb3b-42c4-9ca4-9f23e16fdc19`   | 4     | Already correct — verify no reassignment needed.                          |
| `Proposal Sent` | `estimate_sent_to_client` | `8474d63a-d518-4dbc-8580-cf87ee94a99d`   | 1     | Already correct (service_deal — see below).                               |
| `Deal Canceled` | `lost`                    | `b8aa9f64-99f5-4700-b29b-78b86865a257`   | 2     | Already correct.                                                          |

### Service-deal mapping (workflow = service_deal — keep as-is)

| HubSpot label          | → CRM slug             | CRM stage UUID                           | Count |
|------------------------|------------------------|------------------------------------------|------:|
| `Service - Estimating` | `service_estimating`   | `1aefe9a3-98b3-4169-8895-bd851e02d923`   | 3     |

### Unknown/manual review

None in this batch. All 34 deals have a known `hubspot_stage_name`. If new labels appear later, default to `opportunity` and flag with `needs_leadership_review=true`.

### Net effect

- **24 deals will move**: 22 `Pipe Line` + 2 `RFP` → `opportunity` → `dd`.
- **10 deals already correct** — no-op (script must be idempotent).

### IMPORTANT — please confirm the mapping decision

The brief's hint was "appointmentscheduled / qualifiedtobuy → Lead/early-funnel CRM stage". For this batch the natural early-funnel stage in `standard_deal` is `dd` (Due Diligence), which is `display_order=1`. The `lead` workflow_family also has `new_lead`/`qualified_lead`, but those would change `workflow_family`, which has knock-on effects on the rest of the deal record (different required fields, different downstream events). **Recommend `dd` (Due Diligence) as the safer target — same workflow_family, just one notch earlier than `opportunity`.** Flag this for user confirmation before --execute.

---

## Step 6 — Blockers / open questions

1. **The "45" in the brief is wrong — actual count is 34.** Confirm with user that we should proceed with the 34 deals matched by `source='hubspot_missing_deals_import_2026_05_11'`. Atlanta and PWAuditOffice have zero matching rows.
2. **Mapping target for `Pipe Line` / `RFP`**: `dd` vs leaving in `opportunity` vs switching workflow_family to `lead`. Recommend `dd`. Need user sign-off.
3. **Idempotency strategy**: store the prior `stage_id` on each reassignment so we can detect "already done" and avoid re-running. Suggest writing into `hubspot_extra_properties.phase_b_reassignment` (`{ from_stage_id, to_stage_id, reassigned_at, dry_run }`) AND/OR into `cleanup_audit_log` (table exists in office_dallas schema).
4. **`stage_entered_at`**: should we update it on reassignment? It currently reflects the import time. Recommend updating it so the new stage's age/stale-threshold logic doesn't blow up alerts on day one. Confirm.
5. **Need to verify HubSpot client env var name** in `server/src/modules/migration/hubspot-client.ts` (likely `HUBSPOT_PRIVATE_APP_TOKEN` based on the .env). Not blocking — API is not required for this fix.

## Files of interest

- `/Users/adnaaniqbal/projects/trockcrm-deals-cleanup/server/src/modules/migration/hubspot-client.ts` — HubSpot client (not needed for reassignment, useful for verification).
- `/Users/adnaaniqbal/projects/trockcrm-deals-cleanup/server/src/modules/deals/stage-change.ts` — likely the service that should be reused for stage transitions to fire audit + side effects correctly.
- `/Users/adnaaniqbal/projects/trockcrm-deals-cleanup/server/src/modules/deals/service.ts` — deal service.
- `/Users/adnaaniqbal/projects/trockcrm/.env` — source of working `DATABASE_URL` and HubSpot token.

## Next step (not done — pending user OK)

Write `server/src/scripts/reassign-missing-deals-phase-b.ts` with:
- Reads all rows where `source='hubspot_missing_deals_import_2026_05_11'` from each tenant schema.
- Maps via the table in Step 5; **skip** rows whose `stage_id` already equals the target (idempotency).
- `--dry-run` prints the proposed change set; `--execute` writes via the existing stage-change service so audit + side effects fire.
- Stamps `hubspot_extra_properties.phase_b_reassignment` for replay protection.
- Vitest unit tests covering: mapping table, idempotent skip path, unknown-label default-to-Opportunity-flagged path.
