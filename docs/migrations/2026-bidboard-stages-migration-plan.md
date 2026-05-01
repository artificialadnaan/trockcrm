# 2026 Bid Board Stages Migration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to implement this plan task-by-task. This document is a CRM-repo-only plan. SyncHub work is handled separately; CRM-to-SyncHub dependencies are documented as interface contracts.

**Goal:** Move CRM Bid Board mirrored deal stages to `estimating`, `service_estimating`, `estimate_under_review`, `estimate_sent_to_client`, `contract`, `won`, and `lost`, while keeping `opportunity` as the CRM-only RFP approval trigger.

**Architecture:** Update CRM in additive, independently deployable PRs: schema and dormant fields first, canonical stage contracts second, CRM event emission third, Bid Board ingestion compatibility fourth, then reporting/commission semantics and cutover cleanup. `contract_signed_at` becomes the precise handoff event timestamp; `won` becomes post-handoff revenue-recognition terminal state.

**Tech Stack:** TypeScript, Drizzle schema, PostgreSQL tenant migrations, public `pipeline_stage_config`, tenant `deals`, `job_queue` domain events, Vitest.

---

## A. Slug-Rename Proposal Table

| Current slug or label | New canonical slug | Status | Notes |
|---|---:|---|---|
| `opportunity` | `opportunity` | Active CRM-only | No slug change. Becomes the RFP approval trigger emission point. Not Bid Board mirrored. |
| `estimate_in_progress` | `estimating` | Rename active slug | Non-obvious. This is a real slug rename, not label-only, because the business locked canonical CRM slug `estimating`. Keep `estimate_in_progress` as an inactive historical alias and cutover input alias. |
| `estimating` legacy normal input | `estimating` | Promote to canonical | Existing legacy alias currently maps to `estimate_in_progress` in `shared/src/types/workflow.ts:211`; after migration it is canonical. |
| `service_estimating` | `service_estimating` | Keep active | Label changes from `Service - Estimating` to `Service Estimating`; accept dash/em-dash variants as input aliases during cutover. |
| `estimate_under_review` | `estimate_under_review` | Keep active | Shared across normal and service workflows. |
| `service_estimate_under_review` | `estimate_under_review` | Inactive alias | Keep as import/test alias only. Remove from active selectable workflow arrays. |
| `estimate_sent_to_client` | `estimate_sent_to_client` | Keep active | Shared across normal and service workflows. |
| `service_estimate_sent_to_client` | `estimate_sent_to_client` | Inactive alias | Keep as import/test alias only. Remove from active selectable workflow arrays. |
| `contract_signed` | `contract` | Historical/pseudo alias | Existing seed/reporting pseudo-stage. Do not keep selectable. Use `contract_signed_at` timestamp for signing. |
| `service_contract_signed` | `contract` | Historical/pseudo alias | Existing reporting pseudo-stage. Do not keep selectable. Use `contract_signed_at` timestamp for signing. |
| New `Contract` label | `contract` | New active Bid Board mirrored stage | Single stage covering pre-contract, negotiation, and signed-contract internally. Deal remains in `contract` after signature until Bid Board moves it to `won` or `lost`. |
| `sent_to_production` | `won` | Inactive historical alias after cutover | Active deals in this stage migrate to `won`; closed historical rows can retain old stage IDs/slugs for historical reporting. Not selectable for new transitions. |
| `service_sent_to_production` | `won` | Inactive historical alias after cutover | Same as above; terminal family-specific slug is removed from active set. |
| `closed_won` | `won` | Inactive historical alias | Preserve closed historical rows; map as input alias for imports/reports. |
| `production_lost` | `lost` | Inactive historical alias after cutover | Active deals migrate to `lost` if still active; closed/lost historical rows can retain old slug. Not selectable for new transitions. |
| `service_lost` | `lost` | Inactive historical alias after cutover | Same as above; terminal family-specific slug is removed from active set. |
| `closed_lost` | `lost` | Inactive historical alias | Preserve closed historical rows; map as input alias for imports/reports. |
| `Pipe Line`, `RFP`, `Internal Review`, `Proposal Sent`, `Follow-Up`, `Approval 30 Days`, `Approval 60-90 days`, `On Hold`, `Deal Canceled`, `Service - Production`, `Service - Won`, `Service - Lost` | See mapping | Input aliases only | Keep in HubSpot/import refresh mapping, but never expose as selectable CRM stages. Current input map is in `scripts/refresh-from-hubspot.ts:22-39`. |

## B. Schema Changes And Migrations

### Recommended Timestamp Placement

Put `contract_signed_at TIMESTAMPTZ` on the tenant `deals` table, next to the existing close/signing fields in `shared/src/schema/tenant/deals.ts:147-154`.

Reasoning:

- The trigger is a deal lifecycle fact, not stage-gate metadata. It must be queryable for handoff timing, reporting, audit, and idempotency without decoding stage-gate JSON.
- The existing signing field is already deal-level: `contractSignedDate: date("contract_signed_date")` in `shared/src/schema/tenant/deals.ts:152-153` and migration `0061` adds `contract_signed_date` to tenant `deals` (`migrations/0061_deal_contract_signed_date.sql:1-20`).
- A timestamp is required because the business trigger is a transition event, not just a date. Keep `contract_signed_date` temporarily as a compatibility/date-filter field and derive it from `contract_signed_at::date` during the migration window.

Add these tenant deal columns:

- `contract_signed_at TIMESTAMPTZ NULL`
- `rfp_approval_requested_at TIMESTAMPTZ NULL`
- `rfp_approval_request_event_id UUID NULL`
- Optional but recommended for audit/debugging: `rfp_approval_requested_by UUID NULL REFERENCES public.users(id)`

Do not put `contract_signed_at` inside stage-gate metadata. Stage gates describe requirements to enter a stage; signing is a lifecycle event inside the `contract` stage.

### Migration 0063: Add Dormant Columns And Event Idempotency Fields

Create `migrations/0063_contract_signed_at_and_rfp_opportunity_event.sql`:

- For each tenant schema with a `deals` table, add:
  - `contract_signed_at TIMESTAMPTZ`
  - `rfp_approval_requested_at TIMESTAMPTZ`
  - `rfp_approval_request_event_id UUID`
  - `rfp_approval_requested_by UUID REFERENCES public.users(id)`
- Backfill `contract_signed_at` from existing `contract_signed_date` where present:
  - `contract_signed_at = contract_signed_date::timestamptz`
  - Keep `contract_signed_date` populated for existing filters and UI during compatibility PRs.
- Add indexes:
  - `CREATE INDEX IF NOT EXISTS deals_contract_signed_at_idx ON <tenant>.deals(contract_signed_at)`
  - `CREATE INDEX IF NOT EXISTS deals_rfp_approval_requested_at_idx ON <tenant>.deals(rfp_approval_requested_at)`

No stage rows are changed in this PR.

### Migration 0064: Seed New Active Stages, Keep Old Aliases Inactive

Create `migrations/0064_bidboard_stage_v2_seed.sql`:

- Insert or update active stage rows in `public.pipeline_stage_config`:

| Name | Slug | Display order | Workflow family | Active | Terminal |
|---|---:|---:|---|---:|---:|
| Opportunity | `opportunity` | 2 | `standard_deal` | true | false |
| Estimating | `estimating` | 3 | `standard_deal` | true | false |
| Service Estimating | `service_estimating` | 3 | `service_deal` | true | false |
| Estimate Under Review | `estimate_under_review` | 4 | `standard_deal` | true | false |
| Estimate Sent to Client | `estimate_sent_to_client` | 5 | `standard_deal` | true | false |
| Contract | `contract` | 6 | `standard_deal` | true | false |
| Won | `won` | 7 | `standard_deal` | true | true |
| Lost | `lost` | 8 | `standard_deal` | true | true |

Notes:

- `pipeline_stage_config.slug` is globally unique (`shared/src/schema/public/pipeline-stage-config.ts:6-13`), so shared slugs like `estimate_under_review`, `estimate_sent_to_client`, `contract`, `won`, and `lost` cannot be duplicated once per family unless the uniqueness constraint is changed. Do not change that constraint in this migration.
- Because slugs are unique and workflows share common stages, use `standard_deal` as the canonical public row for shared stages. Route-specific behavior belongs in shared TypeScript contracts, not duplicated public rows.
- Keep `service_estimating` as `service_deal` because it is service-specific.
- Deactivate old active terminal rows by setting `is_active_pipeline = false` and preserving `is_terminal = true`:
  - `sent_to_production`
  - `service_sent_to_production`
  - `production_lost`
  - `service_lost`
  - `closed_won`
  - `closed_lost`
- Deactivate old active estimating alias row:
  - `estimate_in_progress`
- Do not delete old rows.

### Migration 0065: Active Deal Row Migration

Create `migrations/0065_bidboard_stage_v2_active_deal_backfill.sql`.

Rules:

- Active/non-terminal deals move directly to new slugs.
- Closed/lost historical rows with old terminal slugs remain on old inactive stage rows to preserve historical reporting.
- Old slugs are not selectable because their `pipeline_stage_config.is_active_pipeline` is false.

Recommended SQL shape per tenant:

```sql
WITH target AS (
  SELECT
    estimating.id AS estimating_id,
    contract.id AS contract_id,
    won.id AS won_id,
    lost.id AS lost_id
  FROM public.pipeline_stage_config estimating
  CROSS JOIN public.pipeline_stage_config contract
  CROSS JOIN public.pipeline_stage_config won
  CROSS JOIN public.pipeline_stage_config lost
  WHERE estimating.slug = 'estimating'
    AND contract.slug = 'contract'
    AND won.slug = 'won'
    AND lost.slug = 'lost'
)
UPDATE <tenant>.deals d
SET
  stage_id = CASE
    WHEN psc.slug = 'estimate_in_progress' THEN target.estimating_id
    WHEN psc.slug IN ('sent_to_production', 'service_sent_to_production') THEN target.won_id
    WHEN psc.slug IN ('production_lost', 'service_lost') THEN target.lost_id
    ELSE d.stage_id
  END,
  bid_board_stage_slug = CASE
    WHEN d.bid_board_stage_slug = 'estimate_in_progress' THEN 'estimating'
    WHEN d.bid_board_stage_slug IN ('sent_to_production', 'service_sent_to_production') THEN 'won'
    WHEN d.bid_board_stage_slug IN ('production_lost', 'service_lost') THEN 'lost'
    ELSE d.bid_board_stage_slug
  END,
  bid_board_stage_family = CASE
    WHEN d.bid_board_stage_slug = 'contract' THEN 'contract'
    WHEN d.bid_board_stage_slug = 'won' THEN 'terminal_won'
    WHEN d.bid_board_stage_slug = 'lost' THEN 'terminal_loss'
    ELSE d.bid_board_stage_family
  END,
  updated_at = NOW()
FROM public.pipeline_stage_config psc, target
WHERE d.stage_id = psc.id
  AND COALESCE(d.is_active, true) = true
  AND psc.slug IN (
    'estimate_in_progress',
    'sent_to_production',
    'service_sent_to_production',
    'production_lost',
    'service_lost'
  );
```

Before executing the migration in staging/production, capture row-count estimates:

```sql
SELECT psc.slug, COUNT(*)::int AS deal_count
FROM <tenant>.deals d
JOIN public.pipeline_stage_config psc ON psc.id = d.stage_id
WHERE COALESCE(d.is_active, true) = true
  AND psc.slug IN (
    'estimate_in_progress',
    'sent_to_production',
    'service_sent_to_production',
    'production_lost',
    'service_lost',
    'closed_won',
    'closed_lost'
  )
GROUP BY psc.slug
ORDER BY psc.slug;
```

Row-count estimate status: not queried in this planning turn; the plan includes the exact read-only query to run in staging before PR 3 deploy.

### Bid Board Mirror Metadata Updates

Update metadata behavior in code after migrations:

- `bidBoardStageSlug`: store only new canonical slugs for active mirrored deals: `estimating`, `service_estimating`, `estimate_under_review`, `estimate_sent_to_client`, `contract`, `won`, `lost`.
- `bidBoardStageFamily`: recommend controlled values:
  - `estimating` for `estimating`, `service_estimating`, `estimate_under_review`
  - `proposal` for `estimate_sent_to_client`
  - `contract` for `contract`
  - `terminal_won` for `won`
  - `terminal_loss` for `lost`
- `bidBoardStageStatus`: preserve incoming scraper status detail only when it adds substate; do not use it to encode old stage labels.
- `actualCloseDate`: stop setting it on contract signature. Reserve it for `won` entry if the app still needs a close date, or deprecate in favor of `contract_signed_at` plus `won` history depending on report requirements.

## C. PR Sequence

| PR | Title | Dependencies | Risk | Bid Board UI timing |
|---:|---|---|---|---|
| 1 | Add dormant contract/RFP event schema fields | None | Low | Can ship before Bid Board UI update |
| 2 | Add CRM stage-v2 canonical contracts behind compatibility aliases | PR 1 | Medium | Can ship before Bid Board UI update |
| 3 | Seed stage-v2 rows and migrate active CRM deals | PR 2 | High | Must coordinate with staged data verification; can deploy before UI label change if aliases are active and `ENABLE_CONTRACT_STAGE_SELECTION=false` |
| 4 | Emit idempotent Opportunity RFP approval event | PR 1, PR 2 | Medium | Can ship before Bid Board UI update |
| 5 | Move Procore handoff to contract_signed_at transition | PR 1, PR 2, PR 3 | High | Must ship before `ENABLE_CONTRACT_STAGE_SELECTION=true` |
| 6 | Update CRM Bid Board ingestion contract and mirror metadata | PR 2, PR 3 | High | Must coordinate with Bid Board label cutover |
| 7 | Update reporting, dashboard, commissions, and UI semantics | PR 3, PR 5 | Medium | Can ship before or with cutover if aliases remain |
| 8 | Cutover cleanup: disable old selections, harden aliases, final docs/tests | PRs 3-7 | Medium | Ships after Bid Board labels are confirmed live |

Contract selection gate recommendation:

- Use option A: add `ENABLE_CONTRACT_STAGE_SELECTION`.
- Reasoning: PR 3 needs to seed `contract` so API normalization, reports, and PR 5 handoff behavior can be tested against the real stage row. Hard-blocking PR 3 behind PR 5 would couple a high-risk data migration to handoff behavior and make rollback less precise. The safer deployment shape is to let PR 3 create the row while UI/API transition surfaces hide or reject selectable `contract` moves until PR 5 is live and smoke-tested.
- Required behavior while disabled: `Contract` may exist in `pipeline_stage_config`, but normal CRM stage-change UI and manual API transitions must not offer or accept it. Bid Board mirror ingestion may accept `contract` only after `ENABLE_BIDBOARD_STAGE_V2_NORMALIZATION=true`; operational signing handoff remains disabled until PR 5.

### PR 1: Add Dormant Contract/RFP Event Schema Fields

- **Scope:** Migrations and Drizzle schema only.
- **Files/subsystems:**
  - Create `migrations/0063_contract_signed_at_and_rfp_opportunity_event.sql`.
  - Modify `shared/src/schema/tenant/deals.ts:147-154` to add `contractSignedAt`, `rfpApprovalRequestedAt`, `rfpApprovalRequestEventId`, and `rfpApprovalRequestedBy`.
  - Update migration verification script `scripts/verify-batch-migrations.ts:56-65`.
- **Rollback:** Additive nullable columns. Rollback is to stop using the fields; no data loss required.
- **Tests:**
  - `npm run typecheck --workspace=shared`
  - Focused migration verification against staging/local tenant schema.
- **Deploy timing:** Can ship before Bid Board UI update.

### PR 2: Add CRM Stage-V2 Canonical Contracts Behind Compatibility Aliases

- **Scope:** Shared TypeScript stage contracts, client helpers, server helper logic. No active data migration yet.
- **Files/subsystems:**
  - `shared/src/types/workflow.ts:24-35`, `92-165`, `208-227`
  - `shared/src/types/sales-workflow.ts:32-60`
  - `shared/src/types/enums.ts:4-18`
  - `client/src/lib/pipeline-ownership.ts:14-15`, `108-124`, `152-158`
  - `server/src/modules/deals/workflow-backfill.ts:9-20`
  - `server/src/modules/procore/bidboard-mirror-service.ts:13-32`, `123-143`, `153-210`
- **Rollback:** Revert the shared/client/server helper changes. Since PR 3 has not migrated active data yet, rollback does not require data repair.
- **Tests:**
  - Update and run `client/src/lib/pipeline-ownership.test.ts`.
  - Update and run `client/src/lib/sales-workflow.test.ts`.
  - Update and run `server/tests/modules/procore/bidboard-mirror-service.test.ts`.
- **Deploy timing:** Can ship before Bid Board UI update because old labels remain accepted as aliases.

### PR 3: Seed Stage-V2 Rows And Migrate Active CRM Deals

- **Scope:** Public stage seed migration and tenant active-deal backfill.
- **Files/subsystems:**
  - Create `migrations/0064_bidboard_stage_v2_seed.sql`.
  - Create `migrations/0065_bidboard_stage_v2_active_deal_backfill.sql`.
  - Update any seed/test fixture assumptions in `scripts/seedTestUsersAndData.ts:92-98`, `215-222`.
- **Rollback:** Restore DB snapshot if the migration corrupts stage assignments. If issue is limited to active stage rows, run reverse mapping only for active rows changed by migration, using captured pre-cutover counts and audit snapshots.
- **Tests:**
  - Run staging pre-count query from section B.
  - Run staging post-count query confirming no active deals remain in old active-only slugs.
  - Verify old rows still exist but are inactive in `public.pipeline_stage_config`.
- **Deploy timing:** Can deploy before Bid Board UI label change only if PR 6 compatibility is also deployed before scraper input changes and `ENABLE_CONTRACT_STAGE_SELECTION=false`.

### PR 4: Emit Idempotent Opportunity RFP Approval Event

- **Scope:** CRM-side event emission only. SyncHub consumption is external.
- **Files/subsystems:**
  - `shared/src/types/events.ts:1-20` add `DEAL_OPPORTUNITY_ENTERED: "deal.opportunity.entered"`.
  - `server/src/modules/deals/stage-change.ts:347-370` emit the new job when target stage slug is `opportunity`.
  - `server/src/modules/deals/stage-change.ts:227-303` set `rfpApprovalRequestedAt`, `rfpApprovalRequestEventId`, and `rfpApprovalRequestedBy` atomically on first eligible Opportunity entry.
  - `server/src/modules/procore/synchub-routes.ts:353-368` must not emit RFP events from Bid Board mirror updates; only CRM-owned Opportunity entry should emit.
- **Rollback:** Keep fields but disable event insertion behind a feature flag such as `ENABLE_OPPORTUNITY_RFP_EVENT=false`.
- **Tests:**
  - Add stage-change tests proving first Opportunity entry emits exactly one event and sets suppression fields.
  - Add tests proving no event is emitted when `rfpApprovalRequestedAt` is already set.
  - Add tests proving Bid Board mirror updates do not emit Opportunity events.
- **Deploy timing:** Can ship before Bid Board UI update. SyncHub may ignore the event until its separate CLI work is deployed.

### PR 5: Move Procore Handoff To contract_signed_at Transition

- **Scope:** CRM detects contract signing while in `contract` and emits a handoff event/job. Existing `deal.won` no longer creates Procore projects.
- **Files/subsystems:**
  - `server/src/modules/deals/service.ts:1473-1538` replace date-only setter with timestamp-aware setter or add a new `setDealContractSignedAt`.
  - `server/src/modules/procore/event-handlers.ts:15-33` stop treating `deal.won` as project-create source.
  - `server/src/modules/procore/sync-service.ts:24-29` update comments and callers from won-deal to contract-signed handoff.
  - `worker/src/jobs/index.ts:217-270` keep task handoff behavior on `deal.won` only if those tasks are revenue-recognition tasks; move Procore project creation to a new `deal.contract.signed` or `deal.contract_signed` domain event.
- **Rollback:** Feature-flag the new handoff event. If disabled, temporarily restore `deal.won` handoff behavior while preserving `contract_signed_at` writes.
- **Tests:**
  - Contract signing in `contract` stage queues one Procore create-project job.
  - Contract signing outside `contract` is rejected or does not queue handoff.
  - Clearing/editing `contract_signed_at` does not re-fire handoff.
  - Existing Procore idempotency guard still skips if `procore_project_id` exists (`server/src/modules/procore/sync-service.ts:46-52`).
- **Deploy timing:** Must ship after PR 3 stage seed exists and before teams begin using `Contract` as the operational signing stage. Keep `ENABLE_CONTRACT_STAGE_SELECTION=false` until this PR is live and smoke-tested.

### PR 6: Update CRM Bid Board Ingestion Contract And Mirror Metadata

- **Scope:** CRM endpoint that receives SyncHub/Bid Board scraper payloads, plus mirror normalization.
- **Files/subsystems:**
  - `server/src/modules/procore/synchub-routes.ts:241-306`, `371-432`, `444-570`
  - `server/src/modules/procore/bidboard-mirror-service.ts:123-210`, `287-328`
  - Tests in `server/tests/modules/procore/bidboard-mirror-service.test.ts`.
- **Rollback:** Keep old labels accepted. Roll back only the active canonical mapping if new labels fail. Because PR 2 keeps aliases, old Bid Board labels can still ingest during rollback.
- **Tests:**
  - Accept new labels/slugs: `Estimating`, `Service Estimating`, `Estimate Under Review`, `Estimate Sent to Client`, `Contract`, `Won`, `Lost`.
  - Accept old labels/slugs during cutover: `Estimate in Progress`, `Service - Estimating`, `Service — Estimating`, `Sent to Production`, `Service - Sent to Production`, `Production Lost`, `Service - Lost`, `Closed Won`, `Closed Lost`.
  - Verify `won` sets terminal win fields and `lost` sets lost fields.
  - Verify `contract` does not set `actualCloseDate`, `lostAt`, or `contract_signed_at`.
- **Deploy timing:** Must coordinate with Bid Board label cutover. This PR should be live before SyncHub sends new labels.

### PR 7: Update Reporting, Dashboard, Commissions, And UI Semantics

- **Scope:** All CRM-facing report/UI semantics from old terminal slugs to `contract_signed_at`, `won`, and `lost`.
- **Files/subsystems:** See section D table.
- **Business gate:** PR 7 deployment requires written confirmation from business owner on commission timing semantics -- see Open Question 1. Do not block PRs 1-6 on this.
- **Rollback:** Roll back UI/report query changes. Data remains compatible because old aliases remain in DB and canonical fields stay additive.
- **Tests:**
  - Report-builder win rate counts `won` as won and `lost` as lost while preserving historical `closed_won` and old inactive terminal rows.
  - Contracts-signed dashboard uses `contract_signed_at` with date fallback during transition.
  - Commission earned filters move from display-order threshold to explicit `won`/legacy won or the booked commission table, depending on report row recommendation.
- **Deploy timing:** Can ship before or with cutover if compatibility aliases remain.

### PR 8: Cutover Cleanup: Disable Old Selections, Harden Aliases, Final Docs/Tests

- **Scope:** Remove old slugs from active arrays/dropdowns and document final interface contract.
- **Files/subsystems:**
  - UI dropdown/filter surfaces under `client/src/components/deals/` and `client/src/pages/deals/`.
  - Tests/fixtures under `client/src/lib/`, `server/tests/modules/deals/`, `server/tests/modules/procore/`.
  - Docs in `docs/migrations/`.
- **Rollback:** Re-enable old labels as active only if Bid Board cutover is rolled back. Keep inactive aliases in the database either way.
- **Tests:**
  - No old terminal slugs appear as selectable transitions.
  - Legacy records still render with historical labels.
  - New active board order is `Opportunity`, `Estimating` or `Service Estimating`, `Estimate Under Review`, `Estimate Sent to Client`, `Contract`, `Won`, `Lost`.
- **Deploy timing:** Ships after Bid Board labels are confirmed live and smoke tests pass.

## D. Reporting And Commission Audit Table

| Report/rule | Current key | File:line | Recommendation |
|---|---|---|---|
| Director/rep dashboard stage groups | `sent_to_production`, `service_sent_to_production`, `production_lost`, `service_lost`, `closed_won`, `closed_lost` | `server/src/modules/dashboard/service.ts:41-61` | Move active won/lost grouping to `won` and `lost`; keep old terminal aliases for historical rows only. |
| Dashboard legacy stage resolver | `closed_won` -> sent-to-production; `closed_lost` -> production-lost | `server/src/modules/dashboard/service.ts:124-147` | Map legacy won/lost to shared `won`/`lost` for active/dashboard semantics. |
| Contracts signed KPI/cards | `contract_signed_date` | `server/src/modules/dashboard/service.ts:1330-1344` | Move timing source to `contract_signed_at`; date grouping uses `contract_signed_at::date`, with compatibility fallback to `contract_signed_date`. This is handoff timing, not revenue recognition. |
| Pipeline summary analytics | terminal active pipeline rows from `pipeline_stage_config` | `server/src/modules/reports/service.ts:432-485` | No direct old slug hardcode here, but verify `Contract` is non-terminal and `won`/`lost` are terminal/inactive from active pipeline columns as intended. |
| Reports mirrored downstream lists | current old mirrored slugs and labels | `server/src/modules/reports/service.ts:31-73` | Replace active list with new mirrored slugs; keep old aliases in resolver for historical reporting. |
| Reports legacy resolver | old slugs resolve to sent-to-production/production-lost labels | `server/src/modules/reports/service.ts:88-99` | Resolve old won aliases to `Won`, old lost aliases to `Lost`; `estimate_in_progress` historical label should render `Estimating`. |
| Forecast milestone summary joins | `closed_won` milestone key | `server/src/modules/reports/service.ts:242-247`, `283-288`, `328-333` | Keep milestone key name `closed_won` for historical table compatibility, but capture it on `won` entry after migration. |
| Report builder date fields | `contract_signed_date` | `server/src/modules/reports/report-builder-service.ts:28`, `75` | Add `contract_signed_at` as timestamp/date field; keep `contract_signed_date` as compatibility option until UI is migrated. |
| Report builder win rate | won = sent-to-production/service/closed_won; denominator includes old lost slugs | `server/src/modules/reports/report-builder-service.ts:120-128` | Revenue-recognition report: use `won` as win numerator, `lost` as loss denominator; include old terminal aliases for historical rows. |
| Forecast milestone capture | won stage set includes old terminal slugs | `server/src/modules/reports/forecast-milestones-service.ts:7-28`, `281-320`, `350-357` | Capture `closed_won` milestone on `won` entry. Do not capture on `contract_signed_at`; that is handoff timing. |
| Commission earned monthly/deal report | display-order threshold based on `contract_signed`, sent-to-production, service variants | `server/src/modules/commissions/reporting-service.ts:165-225` | Revenue-recognition recommendation: earned commission should key off the booked commission table plus `won` entry if business wants commissions earned only at terminal win. If commissions are owed at signature, keep booked table but rename report copy to signed/booked, not earned. |
| Commission summary earned/potential | same display-order threshold | `server/src/modules/commissions/reporting-service.ts:253-294` | Remove display-order threshold; use explicit `won`/legacy won for earned revenue-recognition, or `deal_signed_commissions` for signed/booked pipeline. |
| Commission calculation | fires on `contract_signed_date` null-to-date | `server/src/modules/deals/service.ts:1473-1538`, `server/src/modules/commissions/service.ts:60-80`, `140-150` | Move input to `contract_signed_at`. Decide label: if commission is truly revenue-recognition, fire on `won`; if commission is booked at signing, keep on `contract_signed_at` but do not call it earned. Recommendation: create booked commission on `contract_signed_at`, recognize earned on `won` if separate accounting is needed. |
| Deal list contract signed filters | `contract_signed_date` | `server/src/modules/deals/service.ts:41-44`, `605-637` | Move handoff timing filters to `contract_signed_at::date`; keep date field compatibility during migration. |
| Pipeline terminal counts | sent-to-production/service vs production-lost/service-lost | `client/src/pages/pipeline/pipeline-page.tsx:39-47` | Use `won` and `lost`, include historical inactive terminal aliases only in terminal summary counts if historical rows are displayed. |
| Report builder default filter | sent-to-production/service/closed_won | `client/src/components/reports/report-builder.tsx:58` | Default win filter becomes `won` plus historical `closed_won`, `sent_to_production`, and `service_sent_to_production` only when the report includes historical rows. |
| Contracts signed UI | `contractSignedDate` | `client/src/pages/dashboard/contracts-signed-page.tsx:68`, `165` | Move to `contractSignedAt` display with date formatting fallback. |
| Rep commissions UI | `contractSignedDate`, fixture slugs `contract_signed`/`sent_to_production` | `client/src/pages/commissions/rep-commissions-page.tsx:69`, `345`; tests at `client/src/pages/commissions/rep-commissions-page.test.tsx:53-92` | Align copy to booked-at-signing versus earned-at-won. Replace active stage fixtures with `contract`/`won`; keep old values only as historical fixture coverage. |

## E. Opportunity To RFP Trigger Emission Design

Recommendation: emit a durable CRM domain event from the stage-change transaction: `deal.opportunity.entered`.

Why this mechanism:

- The existing CRM stage-change path already inserts durable `job_queue` domain events atomically with stage history (`server/src/modules/deals/stage-change.ts:340-370`).
- It supports more than one consumer. SyncHub can consume the event today; future CRM-native RFP approval can consume the same event without changing stage-change semantics.
- A database trigger would hide business logic and be harder to test; a direct outbound webhook would couple CRM to SyncHub too tightly.

Schema fields:

- `deals.rfp_approval_requested_at TIMESTAMPTZ`
- `deals.rfp_approval_request_event_id UUID`
- `deals.rfp_approval_requested_by UUID`

Emission rule:

- Fires when a deal stage transitions into canonical slug `opportunity`.
- Suppress if `rfp_approval_requested_at IS NOT NULL`.
- When firing, set `rfp_approval_requested_at = NOW()`, generate `rfp_approval_request_event_id`, set requested-by user, and insert `job_queue` row inside the same transaction.
- Do not fire from Bid Board mirror updates or import refreshes unless those paths intentionally call the same CRM stage-change service and pass a flag allowing RFP emission. Default import/scraper behavior should suppress.

Event:

```json
{
  "eventName": "deal.opportunity.entered",
  "eventId": "uuid",
  "idempotencyKey": "deal:{dealId}:rfp_approval:lifetime",
  "dealId": "uuid",
  "dealNumber": "string|null",
  "dealName": "string",
  "officeId": "uuid",
  "workflowRoute": "normal|service",
  "fromStageId": "uuid|null",
  "toStageId": "uuid",
  "toStageSlug": "opportunity",
  "enteredAt": "ISO-8601 timestamp",
  "requestedBy": "uuid",
  "source": "crm_stage_change"
}
```

Explicit retrigger design:

- Add a future admin/director route that clears `rfp_approval_requested_at` or emits a separate `deal.opportunity.rfp_retriggered` event with its own audit reason.
- Do not overload normal stage movement to retrigger.

## F. Bid Board Scraper Compatibility

The Playwright Bid Board scraper/RPA source of truth lives in SyncHub, not this CRM repo, per the impact map. This CRM repo owns the ingestion endpoint and normalization contract in `server/src/modules/procore/synchub-routes.ts:241-306`, `371-432`, and `444-570`.

CRM should accept these canonical stage slugs from scraper input after migration:

- `estimating`
- `service_estimating`
- `estimate_under_review`
- `estimate_sent_to_client`
- `contract`
- `won`
- `lost`

CRM should accept these canonical display labels after migration:

- `Estimating`
- `Service Estimating`
- `Estimate Under Review`
- `Estimate Sent to Client`
- `Contract`
- `Won`
- `Lost`

CRM should accept these cutover aliases from SyncHub/Bid Board input:

- `Estimate in Progress` -> `estimating`
- `Service - Estimating` -> `service_estimating`
- `Service — Estimating` -> `service_estimating`
- `Internal Review` -> `estimate_under_review`
- `Proposal Sent` -> `estimate_sent_to_client`
- `Sent to Production` -> `won`
- `Service Sent to Production` -> `won`
- `Service - Sent to Production` -> `won`
- `Closed Won` -> `won`
- `Service - Won` -> `won`
- `Production Lost` -> `lost`
- `Service Lost` -> `lost`
- `Service - Lost` -> `lost`
- `Closed Lost` -> `lost`
- `Deal Canceled` -> `lost`

CRM mirror logic must normalize dash and em-dash variants before matching.

## G. Cross-System Interface Contract Appendix

This appendix is the CRM-side spec for the separate SyncHub CLI.

### Events CRM Will Emit

| Event name | When it fires | Idempotency key | Payload |
|---|---|---|---|
| `deal.opportunity.entered` | First CRM-owned entry into `opportunity` per deal lifetime | `deal:{dealId}:rfp_approval:lifetime` | See section E JSON schema. |
| `deal.contract.signed` | `contract_signed_at` transitions from null to a value while the deal is in `contract` | `deal:{dealId}:contract_signed:{contractSignedAt}` | `eventId`, `dealId`, `dealNumber`, `dealName`, `officeId`, `workflowRoute`, `contractSignedAt`, `contractStageId`, `signedBy`, `source`. |
| `deal.stage.changed` | Any CRM stage transition | Existing event; no new SyncHub dependency | Already emitted in `server/src/modules/deals/stage-change.ts:361-370`. |
| `deal.won` | Entry into `won` | Existing/new terminal event | Revenue-recognition terminal event. No longer Procore project creation source. |
| `deal.lost` | Entry into `lost` | Existing/new terminal event | Loss tracking event. |

### Database Fields SyncHub May Read From CRM

- `deals.stage_id`
- `pipeline_stage_config.slug`
- `pipeline_stage_config.name`
- `deals.workflow_route`
- `deals.is_bid_board_owned`
- `deals.bid_board_stage_slug`
- `deals.bid_board_stage_family`
- `deals.bid_board_stage_status`
- `deals.bid_board_stage_entered_at`
- `deals.bid_board_stage_exited_at`
- `deals.contract_signed_at`
- `deals.rfp_approval_requested_at`
- `deals.rfp_approval_request_event_id`
- `deals.procore_project_id`
- `deals.procore_last_synced_at`

### Stage Label Strings CRM Will Write After Migration

- `Opportunity`
- `Estimating`
- `Service Estimating`
- `Estimate Under Review`
- `Estimate Sent to Client`
- `Contract`
- `Won`
- `Lost`

### Stage Slugs CRM Will Store After Migration For Active Mirrored Deals

- `opportunity` for CRM-only pre-Bid-Board RFP approval
- `estimating`
- `service_estimating`
- `estimate_under_review`
- `estimate_sent_to_client`
- `contract`
- `won`
- `lost`

### Stage Labels CRM Will Accept From Bid Board Scraper Input

Canonical:

- `Estimating`
- `Service Estimating`
- `Estimate Under Review`
- `Estimate Sent to Client`
- `Contract`
- `Won`
- `Lost`

Cutover aliases:

- `Estimate in Progress`
- `Service - Estimating`
- `Service — Estimating`
- `Internal Review`
- `Proposal Sent`
- `Sent to Production`
- `Service Sent to Production`
- `Service - Sent to Production`
- `Closed Won`
- `Service - Won`
- `Production Lost`
- `Service Lost`
- `Service - Lost`
- `Closed Lost`
- `Deal Canceled`

### Responsibilities CRM Is Taking Over

- CRM emits the first-lifetime RFP approval trigger on Opportunity entry. SyncHub should stop inferring RFP approval from HubSpot stage names once it consumes `deal.opportunity.entered`.
- CRM detects contract signing through `contract_signed_at` and triggers Procore handoff. SyncHub should not treat `Sent to Production`/`Won` as the project-creation source after cutover.
- CRM owns the canonical active stage slugs. SyncHub should send canonical slugs where possible and use labels only as display/input metadata.

## H. Cutover Runbook

### Pre-Cutover

1. Confirm all PRs 1-7 are merged and deployed to staging.
2. Run the stage row audit:

   ```sql
   SELECT slug, name, workflow_family, is_active_pipeline, is_terminal, display_order
   FROM public.pipeline_stage_config
   WHERE slug IN (
     'opportunity',
     'estimating',
     'estimate_in_progress',
     'service_estimating',
     'estimate_under_review',
     'estimate_sent_to_client',
     'contract',
     'won',
     'lost',
     'sent_to_production',
     'service_sent_to_production',
     'production_lost',
     'service_lost',
     'closed_won',
     'closed_lost'
   )
   ORDER BY display_order, slug;
   ```

3. Capture active deal counts by stage for every tenant using the section B query.
4. Capture the reporting parity baseline before PR 3 deploys to production. Store it at `docs/migrations/cutover-baselines/2026-bidboard-stages-reporting-baseline-<environment>-<YYYYMMDD-HHMM>.md` with the tenant/schema name, query timestamp, query outputs, and the exact git SHA deployed when captured.
5. Reporting parity tolerance:
   - Win rate: post-cutover value must be within +/- 0.1 percentage points.
   - Commissions earned: post-cutover amount must be within +/- 0.1%.
   - Contracts signed count: exact match required.
   - Lost deals count: exact match required.
   - Any larger variance blocks cutover continuation because it means alias resolution or date semantics are broken.
6. Baseline query for win rate, last 90 days:

   ```sql
   WITH terminal_deals AS (
     SELECT
       d.id,
       psc.slug,
       COALESCE(d.actual_close_date, d.lost_at::date, d.contract_signed_date, d.updated_at::date) AS terminal_date
     FROM <tenant>.deals d
     JOIN public.pipeline_stage_config psc ON psc.id = d.stage_id
     WHERE COALESCE(d.is_test_data, false) = false
       AND psc.slug IN (
         'won',
         'lost',
         'sent_to_production',
         'service_sent_to_production',
         'production_lost',
         'service_lost',
         'closed_won',
         'closed_lost'
       )
   )
   SELECT
     COUNT(*) FILTER (WHERE slug IN ('won', 'sent_to_production', 'service_sent_to_production', 'closed_won'))::int AS won_count,
     COUNT(*) FILTER (WHERE slug IN ('lost', 'production_lost', 'service_lost', 'closed_lost'))::int AS lost_count,
     COUNT(*)::int AS terminal_count,
     ROUND(
       100.0 * COUNT(*) FILTER (WHERE slug IN ('won', 'sent_to_production', 'service_sent_to_production', 'closed_won'))
       / NULLIF(COUNT(*), 0),
       3
     ) AS win_rate_pct
   FROM terminal_deals
   WHERE terminal_date >= CURRENT_DATE - INTERVAL '90 days';
   ```

7. Baseline query for commissions earned, last 90 days:

   ```sql
   SELECT
     COUNT(DISTINCT dsc.deal_id)::int AS commission_deal_count,
     COALESCE(SUM(dsc.amount), 0)::numeric(14,2) AS earned_commission
   FROM <tenant>.deal_signed_commissions dsc
   JOIN <tenant>.deals d ON d.id = dsc.deal_id
   JOIN public.pipeline_stage_config psc ON psc.id = d.stage_id
   WHERE COALESCE(d.is_test_data, false) = false
     AND dsc.contract_signed_date_at_signing >= CURRENT_DATE - INTERVAL '90 days'
     AND psc.slug IN (
       'won',
       'sent_to_production',
       'service_sent_to_production',
       'closed_won',
       'contract_signed',
       'service_contract_signed'
     );
   ```

8. Baseline query for contracts signed count, last 90 days:

   ```sql
   SELECT COUNT(*)::int AS contracts_signed_count
   FROM <tenant>.deals d
   WHERE COALESCE(d.is_test_data, false) = false
     AND COALESCE(d.contract_signed_at::date, d.contract_signed_date) >= CURRENT_DATE - INTERVAL '90 days';
   ```

9. Baseline query for lost deals count, last 90 days:

   ```sql
   SELECT COUNT(*)::int AS lost_deals_count
   FROM <tenant>.deals d
   JOIN public.pipeline_stage_config psc ON psc.id = d.stage_id
   WHERE COALESCE(d.is_test_data, false) = false
     AND psc.slug IN ('lost', 'production_lost', 'service_lost', 'closed_lost')
     AND COALESCE(d.lost_at::date, d.actual_close_date, d.updated_at::date) >= CURRENT_DATE - INTERVAL '90 days';
   ```

10. Back up production database or confirm a restorable Railway snapshot exists.
11. Confirm SyncHub CLI is ready to accept the section G contract but do not require SyncHub code changes from this CRM plan.
12. Confirm Bid Board UI label-change window and the exact minute labels will flip.
13. Confirm feature flags:
   - `ENABLE_OPPORTUNITY_RFP_EVENT`
   - `ENABLE_CONTRACT_SIGNED_HANDOFF`
   - `ENABLE_BIDBOARD_STAGE_V2_NORMALIZATION`
   - `ENABLE_CONTRACT_STAGE_SELECTION`

### Cutover

1. Deploy CRM PR 1 and PR 2 if not already live.
2. Deploy CRM PR 4 with `ENABLE_OPPORTUNITY_RFP_EVENT=false`; verify no events fire while disabled.
3. Deploy CRM PR 5 with `ENABLE_CONTRACT_SIGNED_HANDOFF=false`; verify existing signing UI still writes compatibility fields.
4. Deploy CRM PR 6 with `ENABLE_BIDBOARD_STAGE_V2_NORMALIZATION=true`; verify old Bid Board labels still ingest.
5. Confirm `ENABLE_CONTRACT_STAGE_SELECTION=false`.
6. Run migration PR 3 in production: seed new stage rows, deactivate old active aliases, migrate active deal rows.
7. Turn on Bid Board UI label changes.
8. Enable `ENABLE_OPPORTUNITY_RFP_EVENT=true` after SyncHub confirms it is ready to consume the new event.
9. Enable `ENABLE_CONTRACT_SIGNED_HANDOFF=true` after one staging smoke confirms a `contract_signed_at` event queues Procore handoff.
10. Enable `ENABLE_CONTRACT_STAGE_SELECTION=true` only after PR 5 is live and the contract-signed handoff smoke passes.
11. Deploy PR 7 if it was held for cutover-specific reporting semantics.
12. Re-run the four reporting parity queries from pre-cutover after PR 7 deploys, append the outputs to the same baseline file, and compare against the stored baseline. If any value exceeds tolerance, stop before PR 8 and fix alias resolution/report semantics.
13. Deploy PR 8 only after old-label ingestion, new-label ingestion, and reporting parity all pass.

### Post-Cutover Verification

1. Verify no active deals remain in old active-only stage slugs:

   ```sql
   SELECT psc.slug, COUNT(*)::int
   FROM <tenant>.deals d
   JOIN public.pipeline_stage_config psc ON psc.id = d.stage_id
   WHERE COALESCE(d.is_active, true) = true
     AND psc.slug IN (
       'estimate_in_progress',
       'sent_to_production',
       'service_sent_to_production',
       'production_lost',
       'service_lost'
     )
   GROUP BY psc.slug;
   ```

2. Verify old terminal rows still exist but are inactive:

   ```sql
   SELECT slug, is_active_pipeline, is_terminal
   FROM public.pipeline_stage_config
   WHERE slug IN (
     'sent_to_production',
     'service_sent_to_production',
     'production_lost',
     'service_lost',
     'closed_won',
     'closed_lost'
   );
   ```

3. Smoke: manually move a test CRM deal into `Opportunity`; confirm one `deal.opportunity.entered` job and no duplicate on repeat no-op.
4. Smoke: ingest one old-label Bid Board payload and one new-label Bid Board payload through the CRM SyncHub route; confirm both normalize to new canonical slugs.
5. Smoke: set `contract_signed_at` on a test deal in `contract`; confirm exactly one Procore create-project job.
6. Smoke: move the same test deal to `won`; confirm revenue-recognition reports count it as won and no second Procore create-project job is queued.
7. Smoke: move a test deal to `lost`; confirm lost reason enforcement and lost report counts.
8. Verify dashboard, report-builder, contract-signed dashboard, and commissions pages load with expected counts.
9. Verify the reporting parity baseline file contains both pre-cutover and post-PR-7 outputs, with pass/fail notes for win rate, commissions earned, contracts signed count, and lost deals count.

### Rollback Decision Points

Within 1 hour:

- If new labels fail to ingest, leave DB stages in place and roll SyncHub/Bid Board labels back to old labels; CRM PR 6 should still accept old labels.
- If Opportunity emits duplicate RFP events, disable `ENABLE_OPPORTUNITY_RFP_EVENT` and leave suppression fields intact for investigation.
- If contract signing queues duplicate Procore jobs, disable `ENABLE_CONTRACT_SIGNED_HANDOFF`; rely on `procore_project_id` idempotency guard while investigating.

Within 6 hours:

- If active deal migration misassigned rows, restore from snapshot if broad. If narrow, run a targeted reverse mapping using pre-cutover captured counts and `deal_stage_history`.
- If reporting is wrong but workflow is stable, roll back PR 7 only. Do not roll back stage rows unless operational workflow is broken.

Within 24 hours:

- If the migration is operationally unstable, restore DB snapshot and redeploy pre-cutover CRM build.
- If only historical reporting is wrong, keep operational cutover live and patch historical alias resolvers.
- If SyncHub cannot consume the new Opportunity event, keep CRM event emitted and temporarily configure SyncHub to ignore it; do not revert CRM stage model solely for the email consumer.

## I. Open Questions

1. Should earned commissions be recognized at `contract_signed_at` or at `won` entry? Recommendation: keep booked commission at `contract_signed_at`; recognize earned/revenue reports at `won`.
2. Should `actual_close_date` remain as a compatibility date set on `won`, or should reporting fully move to stage history for `won` entry? Recommendation: keep setting `actual_close_date` on `won` for compatibility, but document `contract_signed_at` as handoff timing.
3. Should old terminal historical rows stay on old stage IDs forever, or should they be migrated after a reporting archive is validated? Recommendation: leave them as inactive aliases indefinitely unless a later data-warehouse cleanup project replaces historical reporting.
