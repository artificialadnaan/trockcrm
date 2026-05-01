# 2026 Bid Board Stages Migration Complete

Completion date: 2026-05-01

## Status

The Bid Board stage migration is complete through PR 8 cleanup. The CRM now treats the following stages as the active taxonomy:

| Order | Slug | Label | Source of truth |
| --- | --- | --- | --- |
| 1 | `opportunity` | Opportunity | CRM |
| 2 | `estimating` | Estimating | Bid Board |
| 3 | `service_estimating` | Service Estimating | Bid Board |
| 4 | `estimate_under_review` | Estimate Under Review | Bid Board |
| 5 | `estimate_sent_to_client` | Estimate Sent to Client | Bid Board |
| 6 | `contract` | Contract | Bid Board |
| 7 | `won` | Won | Bid Board |
| 8 | `lost` | Lost | Bid Board |

Inactive historical aliases remain supported for rendering, reporting, and ingestion compatibility. They are not selectable for new CRM stage transitions:

- `estimate_in_progress`
- `service_estimate_under_review`
- `service_estimate_sent_to_client`
- `sent_to_production`
- `service_sent_to_production`
- `production_lost`
- `service_lost`
- `closed_won`
- `closed_lost`

## Parity Verification

Reporting parity passed before PR 8 cleanup.

- Pre-cutover baseline: PR #97, `docs/migrations/cutover-baselines/2026-bidboard-stages-reporting-baseline-prod-pre-pr7-20260501T2107.md`
- Post-deploy verification: PR #99, `docs/migrations/cutover-baselines/2026-bidboard-stages-reporting-baseline-prod-post-pr7-20260501T2124.md`

The post-deploy report concluded: all clear to proceed to PR 8 cleanup.

## Final Behavior

- CRM stage selectors show only active canonical stages.
- Historical deals stored on old inactive slugs continue to render with their stored stage label.
- Bid Board ingestion continues to accept both new canonical labels and legacy cutover aliases.
- `Opportunity` remains CRM-only and emits the RFP approval event according to `ENABLE_OPPORTUNITY_RFP_EVENT`.
- `Contract` is selectable after PR 7 and `contract_signed_at` is the Procore handoff trigger according to `ENABLE_CONTRACT_SIGNED_HANDOFF`.
- `Won` is the post-handoff terminal state for revenue recognition.
- `Lost` is the shared terminal loss state.

## Outstanding Tech Debt

- Finish bash 3.2 compatibility hardening for `scripts/staging/ephemeral-staging.sh` before using ephemeral staging as a required gate again.
- Keep Bid Board legacy label ingestion aliases in place until rollback risk is no longer meaningful.
- Remove `contract_signed_date` compatibility reads only in a future cleanup after historical reporting has fully moved to `contract_signed_at`.

## 30-Day Rollback Procedure

If a critical issue is found before 2026-05-31:

1. Disable feature flags first:
   - `ENABLE_OPPORTUNITY_RFP_EVENT=false`
   - `ENABLE_CONTRACT_SIGNED_HANDOFF=false`
   - `ENABLE_CONTRACT_STAGE_SELECTION=false`
2. Revert the most recent behavior PR that caused the issue, keeping additive DB migrations in place unless a restore is explicitly approved.
3. Keep Bid Board ingestion compatibility aliases enabled so scraper payloads from either label set continue to resolve.
4. If data repair is required, run read-only diagnostics first and compare against the PR #97 and PR #99 parity files.
5. Restore from the most recent Railway production backup only if data corruption cannot be repaired safely in place.
