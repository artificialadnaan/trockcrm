# 2026 Bid Board Stages Impact Map

Date: 2026-05-01

Scope: `/Users/adnaaniqbal/projects/trockcrm` plus read-only tracing in `/Users/adnaaniqbal/projects/trocksynchubv3` for the existing SyncHub RFP approval email and Bid Board RPA paths.

## Summary

- CRM stage-vocabulary scan matched 551 files.
- High-signal implementation touchpoints: approximately 80 files across shared workflow contracts, migrations/seeds, server stage logic, Procore/Bid Board mirror logic, UI filters/badges, reports, tests, docs, and SyncHub RFP/reconciliation code.
- Risk level: high.
- Core risk: the current CRM contract still models downstream Bid Board stages as separate normal/service terminal slugs (`sent_to_production`, `service_sent_to_production`, `production_lost`, `service_lost`). The target Bid Board model consolidates these into shared `Won` and `Lost`, adds `Contract`, and keeps CRM-only `Opportunity`.
- RFP approval email is not currently keyed from CRM `Opportunity`. It is fired in SyncHub from a HubSpot webhook branch that checks whether the incoming HubSpot deal stage contains `rfp`.
- Data Reconciliation stage values are conflict and writeback fields in SyncHub. Historical stage values can re-open drift or write old labels/IDs unless handled explicitly.

## Stage String Occurrences By Subsystem

### Shared Workflow Contracts

- `shared/src/types/sales-workflow.ts`
  - Defines `BID_BOARD_MIRRORED_STAGE_SLUGS` as `estimate_in_progress`, `service_estimating`, `estimate_under_review`, `estimate_sent_to_client`, `sent_to_production`, `service_sent_to_production`, `production_lost`, `service_lost`.
  - Defines normal/service stage arrays with `opportunity` plus the current downstream Bid Board slugs.
  - These arrays are the central compile-time contract for what CRM treats as Bid Board mirrored.
- `shared/src/types/workflow.ts`
  - Defines `DealStageSlug`, `NORMAL_DEAL_STAGE_SLUGS`, `SERVICE_DEAL_STAGE_SLUGS`, stage labels, stage ownership, legacy mapping, canonical stage resolution, and estimating-boundary helpers.
  - Current labels include `Estimate in Progress`, `Service - Estimating`, `Sent to Production`, `Service - Sent to Production`, `Production Lost`, and `Service - Lost`.
  - Existing legacy aliases map `closed_won` to the current sent-to-production terminal stages and `closed_lost` to the current production-lost terminal stages.
- `shared/src/types/enums.ts`
  - `DEAL_STAGES` includes current and legacy downstream slugs, including `service_estimate_under_review` and `service_estimate_sent_to_client`.
  - No first-class `contract`, `won`, or `lost` slug exists in this enum.

### Database, Schema, Migrations, Seeds

- `migrations/0001_initial.sql`
  - Seeds base pipeline stages: `Opportunity`, `Estimate in Progress`, `Estimate Under Review`, `Estimate Sent to Client`, `Sent to Production`, `Production Lost`.
- `migrations/0045_service_pipeline_stage_seed.sql`
  - Seeds service stages: `Service - Estimating`, `Estimate Under Review`, `Estimate Sent to Client`, `Service - Sent to Production`, `Service - Lost`.
- `migrations/0053_realign_bid_board_deal_stages.sql`
  - Explicitly realigns CRM to the current Bid Board mirror model.
  - Seeds current mirrored stage labels/slugs.
  - Deactivates older stage slugs.
  - Remaps legacy closed-won/closed-lost style stages into current sent-to-production/production-lost style slugs.
- `shared/src/schema/public/pipeline-stage-config.ts`
  - Contains `procoreStageMapping`, which may need to carry or translate the new Bid Board labels.
- `shared/src/schema/tenant/deals.ts`
  - Persists Bid Board mirror metadata such as `isBidBoardOwned`, `bidBoardStageSlug`, `bidBoardStageFamily`, and `bidBoardStageStatus`.
  - Historical rows can contain old slugs and must be handled deliberately.
- `scripts/seedTestUsersAndData.ts`
  - Contains `contract_signed` and `service_contract_signed` style pseudo-stage references that currently fall back into sent-to-production behavior in reporting/test data.

### CRM HubSpot And Bid Board Stage Mapping

- `scripts/refresh-from-hubspot.ts`
  - Maps historical HubSpot labels into CRM slugs.
  - Existing inputs include `Pipe Line`, `RFP`, `Estimating`, `Internal Review`, `Proposal Sent`, `Follow-Up`, `Approval 30 Days`, `Approval 60-90 days`, `Closed Won`, `Closed Lost`, `Deal Canceled`, `Service - Estimating`, `Service - Production`, `Service - Won`, `Service - Lost`, and `On Hold`.
  - Current outputs are the old CRM canonical downstream slugs, including `sent_to_production`, `service_sent_to_production`, `production_lost`, and `service_lost`.
- `server/src/modules/procore/bidboard-mirror-service.ts`
  - Contains legacy-to-canonical stage conversion.
  - Accepts the current mirrored slugs as canonical.
  - Derives internal Bid Board stage family/status from current stage slugs.
  - Treats `sent_to_production` and `service_sent_to_production` as won/actual-close stages.
  - Treats `production_lost` and `service_lost` as lost stages with lost-reason behavior.
  - Contains an internal `contract_review` family derived from proposal status; this is not currently a pipeline stage.
- `server/src/modules/deals/stage-change.ts`
  - Detects estimating-boundary entry from current estimating slugs.
  - Blocks CRM-authored movement into Bid Board-owned downstream stages.
  - Converts terminal outcomes to current normal/service terminal slugs.
  - Emits `deal.won` and `deal.lost` events from current terminal slugs.
  - Inserts `deal.stage.changed` jobs after stage transitions.
- `server/src/modules/deals/stage-gate.ts`
  - Contains stage-gate requirements and labels, including `Contract` as a document/requirement label rather than a pipeline stage.

### SyncHub RPA And Bid Board Integration

External repo: `/Users/adnaaniqbal/projects/trocksynchubv3`.

- `server/sync/stage-mapping.ts`
  - Normalizes Unicode dash variants.
  - Maps CRM/Bid Board labels to HubSpot labels.
  - Current examples include `Service - Estimating` to `Service - Estimating`, `Estimate in Progress` to `Estimating`, `Estimate Under Review` to `Internal Review`, `Estimate Sent to Client` to `Proposal Sent`, `Service - Sent to Production` to `Service - Won`, `Sent to Production` to `Closed Won`, `Service - Lost` to `Service - Lost`, and `Production Lost` to `Closed Lost`.
- `server/bidboard-automation.ts`
  - Contains fallback stage label mapping for Bid Board automation.
  - Current fallbacks include old estimating/review/sent/won/lost labels.
- `server/playwright/bidboard.ts`
  - Playwright RPA source for Bid Board project creation/update.
  - Stage selector/write behavior must be checked against the exact post-migration Bid Board DOM labels.
- `server/routes/bidboard.ts`
  - Exposes default HubSpot-to-BidBoard trigger config, currently keyed around RFP/service-RFP style stage IDs and Bid Board starting stages.
- `server/hubspot-bidboard-trigger.ts`
  - Default trigger stages are currently `rfp` and `service_rfp`, mapped to BidBoard starting stages.
  - This is separate from the RFP approval email branch but adjacent in the same webhook flow.

### CRM UI Labels, Filters, Badges, Colors

- `client/src/lib/pipeline-ownership.ts` and `client/src/lib/pipeline-ownership.test.ts`
  - Owns canonical board ordering, Bid Board ownership, and old-to-current stage normalization.
- `client/src/lib/canonical-deal-board.ts` and `client/src/lib/canonical-deal-board.test.ts`
  - Uses current stage fixture labels/slugs and board ordering.
- `client/src/lib/sales-workflow.ts` and `client/src/lib/sales-workflow.test.ts`
  - Mirrors shared stage contracts into client behavior.
- `client/src/components/deals/deal-stage-badge.tsx`
  - Stage label/badge display surface.
- `client/src/components/deals/deal-card.tsx`
  - Deal card stage display and ownership indicators.
- `client/src/components/deals/deal-filters.tsx`
  - Stage filter labels/options.
- `client/src/components/deals/stage-change-dialog.tsx`
  - Manual stage-change UI and restriction messaging.
- `client/src/components/deals/stage-gate-checklist.tsx`
  - Stage gate checklist copy and completion state.
- `client/src/pages/deals/deal-detail-page.tsx`
  - Uses canonical estimating boundary and Bid Board ownership logic.
- `client/src/pages/deals/deal-contract-signed-card.tsx`
  - Existing contract-signed UI may be confused with the new `Contract` stage unless labels are separated clearly.

### Reports, Dashboards, Exports, PDF-Like Output

- `server/src/modules/dashboard/service.ts`
  - Defines estimating-progress, won, lost, and legacy stage groups for dashboard metrics.
  - Current won/lost groupings use sent-to-production/production-lost split terminal slugs.
- `server/src/modules/reports/service.ts`
  - Defines mirrored downstream stage labels and summary groupings.
  - Resolves current and legacy labels for reporting.
- `server/src/modules/reports/report-builder-service.ts`
  - Uses current terminal won/lost slugs in win-rate style report logic.
- `server/src/modules/reports/forecast-milestones-service.ts`
  - Uses `closed_won` as a milestone key and current terminal won slugs as milestone inputs.
- `server/src/modules/commissions/reporting-service.ts`
  - Treats `contract_signed`, `sent_to_production`, `service_contract_signed`, and `service_sent_to_production` as commission/reporting completion stages.
- Binary PDFs and generated artifacts are not reliably text-searchable with `rg`; source report/export code and docs are the actionable stage surfaces found in the repo.

### Email Templates And Trigger Conditions

CRM repo:

- No direct CRM-side RFP approval email sender was found as the source of truth.
- CRM `Opportunity` exists as a CRM-owned stage, not currently as the RFP email trigger source.

SyncHub repo:

- `server/routes/webhooks.ts`
  - Receives HubSpot dealstage property-change webhooks.
  - Branches into RFP approval email flow when the resolved stage name or ID contains `rfp`.
- `server/rfp-approval.ts`
  - Creates RFP approval requests, renders/sends the `rfp_review` email, processes approval/rejection, and creates BidBoard projects after approval.
- `server/routes/rfp-approval.ts`
  - Approval UI/API route; approval flow eventually moves the HubSpot deal into estimating/service-estimating and starts Bid Board creation.

### Tests, Fixtures, Mocks

CRM repo:

- `client/src/lib/pipeline-ownership.test.ts`
  - Fixtures and assertions for current stage order, labels, Bid Board ownership, and old-stage normalization.
- `client/src/lib/canonical-deal-board.test.ts`
  - Current board ordering and stage labels.
- `client/src/lib/sales-workflow.test.ts`
  - Current normal/service stage arrays and mirrored-stage expectations.
- `server/tests/modules/deals/stage-change.test.ts`
  - Bid Board ownership, Opportunity behavior, service-estimating behavior, sent-to-production, lost-stage, and event-emission expectations.
- `server/tests/modules/procore/bidboard-mirror-service.test.ts`
  - Bid Board scrape/mirror fixture coverage for current labels including `Production Lost`, `Service - Sent to Production`, `Sent to Production`, `Estimating`, and `Service Estimating`.

SyncHub repo:

- `tests/rfp-approval-processing.test.ts`
- `tests/rfp-to-bidboard.test.ts`
- `tests/rfp-approval-route.test.ts`
- `tests/rfp-concurrent-bidboard.test.ts`
- `tests/bidboard-to-portfolio.test.ts`
- `tests/bidboard-export-sync.test.ts`
- `tests/bidboard-crm-ingestion.test.ts`
- `tests/stage-change-email.test.ts`

These include old HubSpot/BidBoard labels such as `Internal Review`, `Closed Won`, `Service - Won`, `Closed Lost`, and RFP-to-estimating assumptions.

### Documentation And Comments

- `docs/`
  - Broad stage vocabulary matches occur in migration/audit/workflow documentation.
  - Several docs describe the current Bid Board mirror model and legacy stage cleanup.
- `AUDIT_LOG.md`, `CHANGELOG.md`, `TODO.md`
  - Contain historical mentions of stage fixes and Bid Board workflow behavior.
- Inline comments in migrations and workflow services explicitly describe the current stage model; these will become misleading if code changes without doc updates.

## RFP Email Trigger Path

Current trigger path in SyncHub:

1. `server/routes/webhooks.ts`
   - Receives HubSpot webhook events.
   - Filters to deal `dealstage` property changes.
   - Resolves HubSpot stage ID to stage label.
   - Current condition:

   ```ts
   const isRfpStage = stageName.includes('rfp') || stageId.includes('rfp');
   ```

   - If true, dynamically imports `createRfpApprovalRequest` and creates an approval request.
   - If false, passes the event to `processDealStageChange` for other BidBoard automation.

2. `server/rfp-approval.ts`
   - `createRfpApprovalRequest(hubspotDealId)` checks for an existing pending request, fetches the full HubSpot deal, creates an approval token/request, loads the `rfp_review` template, builds recipient lists, and sends the approval email.
   - `processRfpApproval(...)` handles approve/reject decisions.
   - On approval, it moves the deal toward `Service - Estimating` or `Estimating` and creates the BidBoard project.

3. `server/routes/rfp-approval.ts`
   - API/UI approval route.
   - Returns `202 Accepted` for approval and continues the heavier processing in the background.

Current key-off value:

- HubSpot stage ID or resolved stage label containing `rfp`.

Proposed condition:

- CRM-side desired trigger is stage `Opportunity`.
- The direct equivalent condition in the current SyncHub webhook branch would be a strict stage-ID/label match for `Opportunity` rather than substring `rfp`.

One-line or buried?

- Not a clean one-line CRM change.
- The immediate predicate in `server/routes/webhooks.ts` is one line, but the trigger is embedded in SyncHub's HubSpot webhook/state-machine flow and sits next to BidBoard auto-create behavior.
- Re-pointing to `Opportunity` needs duplicate suppression, source-of-change handling, and coordination with the separate `hubspot-bidboard-trigger.ts` config that currently treats RFP/service-RFP as BidBoard starting triggers.

## Data Reconciliation Engine Touchpoints

### CRM Repo

- `server/src/modules/procore/reconciliation-service.ts`
  - CRM reconciliation candidate/diff logic does not currently use stage as a match key, conflict field, or writeback field.
  - Its diff field set is limited to project/deal identity and location/update metadata.
  - No CRM-side reconciliation stage writeback was found in this service.

### SyncHub Repo

- `server/services/reconciliation/matcher.ts`
  - Contains `STAGE_EQUIVALENCE` for old/current stage aliases.
  - Adds a `stage` conflict when normalized Procore and HubSpot stages differ.
  - Stage is not a primary match key; matching is based on project number/name identity, but stage is a detected conflict.
- `server/services/reconciliation/fetcher.ts`
  - Pulls Procore, HubSpot, and BidBoard stage values into reconciliation records.
- `server/services/reconciliation/guardrails.ts`
  - Normalizes stage values to detect drift before applying/confirming changes.
- `server/services/reconciliation/writeback.ts`
  - Maps `stage` to Procore `stage`, HubSpot `dealstage`, and Procore API `stage`.
  - Can write resolved stage values back to source systems.
- `server/routes/reconciliation.ts`
  - Allows `stage` as a single and bulk conflict-resolution field.
  - Includes `stage` rollback mapping.

Reconciliation warning:

- Stage values are writeback-capable in SyncHub.
- Existing unresolved reconciliation conflicts or stored snapshots can preserve old stage labels.
- After the Bid Board migration, stale values such as `Sent to Production`, `Service - Won`, `Closed Won`, `Production Lost`, and `Closed Lost` may be normalized incorrectly, re-open drift, or be written back unless equivalence and writeback rules are updated or temporarily guarded.

## Historical And Seed Data Referencing Old Stages

- `migrations/0001_initial.sql`
  - Seeds the original normal pipeline stages.
- `migrations/0045_service_pipeline_stage_seed.sql`
  - Seeds service-specific stages.
- `migrations/0053_realign_bid_board_deal_stages.sql`
  - Deactivates and remaps old stages into the current mirror model.
- `scripts/refresh-from-hubspot.ts`
  - Converts historical HubSpot labels into CRM slugs and explicitly handles many removed Bid Board/HubSpot labels.
- `shared/src/types/workflow.ts`
  - Contains legacy aliasing for removed/historical labels.
- `server/src/modules/procore/bidboard-mirror-service.ts`
  - Handles legacy label normalization and stores historical Bid Board mirror metadata.
- `scripts/seedTestUsersAndData.ts`
  - Uses `contract_signed` style pseudo-stages in seeded data/reporting scenarios.
- Tests and fixtures in both repos contain old labels and expected old canonical mappings.
- Existing tenant deal rows may contain old `stageId`, `bidBoardStageSlug`, `bidBoardStageFamily`, and `bidBoardStageStatus` values.
- Existing SyncHub reconciliation snapshots/conflicts may contain old `stage` values in JSON payloads and conflict rows.

## Open Questions Before Planning The Migration

1. What are the canonical CRM slugs for the new Bid Board stages: `estimating`, `service_estimating`, `estimate_under_review`, `estimate_sent_to_client`, `contract`, `won`, `lost`, or another naming scheme?
2. Should CRM preserve old terminal slugs as inactive historical aliases, or migrate stored rows directly to new `won` and `lost` slugs?
3. Should `Won` and `Lost` be truly shared CRM slugs across normal and service workflows, or should CRM keep family-specific internal slugs with shared display labels?
4. Should `Estimating` replace the current CRM slug `estimate_in_progress`, or should the slug stay stable with only the label changing?
5. What exact labels will the Bid Board DOM/export expose after migration: `Service Estimating`, `Service - Estimating`, or another dash variant?
6. Does new `Contract` mean contract preparation/review before signature, or should it align with existing `contract_signed` reporting/date concepts?
7. Should SyncHub reconciliation continue to allow stage writeback during the migration window, or should stage writeback be temporarily disabled/guarded?
8. When CRM reaches `Opportunity`, what system emits the event that SyncHub should trust for RFP approval: HubSpot webhook, CRM job/event, or a new API call?
9. How should duplicate RFP approval emails be prevented when `Opportunity` can be entered by imports, refreshes, manual edits, or CRM/HubSpot sync?
10. What should replace the current `Sent to Production` trigger semantics for Portfolio/project transition: `Contract`, `Won`, or a separate approval/signature condition?
11. Are HubSpot stage IDs changing in production, or only labels and CRM mappings?
12. How far back should historical HubSpot/BidBoard inputs be supported for imports and reconciliation after the migration?
