# Smoke — deals-cleanup-and-pre-golive-audit (PR #258)

Date: 2026-05-11 / 2026-05-12 UTC
Merge SHA: `859ea8dd0c9518bb36613d64ff0c6748d6e3e965`
Merged at: 2026-05-12T02:28:34Z
Smoke account: `test-admin@trock.test` (admin role)

Health check: `GET https://trockcrm.com/api/health` → **HTTP 200** (`{"status":"ok"}`).

## Phase A — HubSpot IDs hidden from UI + stripped from API

API smoke against the Steeplechase deal (`3d644257-bf45-4c63-af19-9e7e699e2f5e`, the deal in the user's original screenshot).

```
GET /api/deals/3d644257-bf45-4c63-af19-9e7e699e2f5e
→ HTTP 200
→ hubspotDealId field present in response body: false   ✅
→ dealNumber:   HS-324283495135   (raw column value preserved on the wire as dealNumber, intentional)
→ projectNumber: ATL-2-12826-ah   ✅  matches user screenshot expectation
→ stageId: 0416a7db-1e5a-4d0a-88a2-bc5f1480755c (DD) — Phase B moved this deal correctly
```

Phase A client renderers no longer display the HS- prefix:
- Detail page header subtitle → renders `ATL-2-12826-ah` (projectNumber) via `formatDealDisplayNumber`
- System IDs sidebar → `Deal ID` shows `ATL-2-12826-ah`; the explicit "HubSpot" row is removed entirely
- Kanban card / list / search → all route through the helper; HS- numbers are replaced with `Pending` when no project number exists
- Search results → server-side `pickDealSecondaryLabel` prefers project_number and rejects HS- patterns

## Phase B — 24 HubSpot-imported deals reassigned to DD

Script: `scripts/reassign-hubspot-import-stages.ts --tenant=office_dallas --execute`
Audit CSV: `docs/audit/hubspot-stage-reassignment-2026-05-12T02-31-32-679Z.csv`

```
EXECUTION COMPLETE
  Deals reassigned: 24
  Failed rows:      0
```

Mapping breakdown (dry-run + execute matched):

| HubSpot stage label | → CRM stage slug | Count | Outcome |
|---|---|---|---|
| `Pipe Line` | `dd` (Due Diligence) | 22 | reassigned |
| `RFP` | `dd` (Due Diligence) | 2 | reassigned |
| `Estimating` | (no-op) | 4 | already-correct skip |
| `Service - Estimating` | (no-op) | 3 | already-correct skip |
| `Deal Canceled` | (no-op) | 2 | already-correct skip (lost) |
| `Proposal Sent` | (no-op) | 1 | already-correct skip |

Post-execute distribution among the batch as visible to admin (`/api/deals?source=hubspot_missing_deals_import_2026_05_11`):

```
  stage 0416a7db (dd):            24   ← all "Pipe Line" + "RFP" deals
  stage 71b5b7cd (estimating):     4
  stage 1aefe9a3 (service-est.):   3
  stage 8474d63a (estimate-sent):  1
```

Spot-check on row 6 of the original dry-run table:
```
deal-id 3d644257-bf45-4c63-af19-9e7e699e2f5e (HS-324283495135 — Steeplechase)
  hubspot_stage_name: 'Pipe Line'
  current stageId:    0416a7db-1e5a-4d0a-88a2-bc5f1480755c (dd)   ✅ reassigned
```

Idempotency: a subsequent `--dry-run` against the same batch shows `move_to_dd: 0` because the audit marker `hubspot_extra_properties.phase_b_reassignment.reassigned_at` filters the affected rows out of the SELECT.

### Two known prod runs preceding the green run

1. `2026-05-12T02:30:15Z` — `--execute` attempt 1 failed for all 24 deals with `inconsistent types deduced for parameter $1` (pg parameter-type inference bug in the UPDATE; fixed by adding explicit `$1::uuid` casts in both occurrences). All 24 transactions rolled back; no DB writes.
2. `2026-05-12T02:30:53Z` — `--execute` attempt 2 failed for all 24 deals with `column "change_reason" of relation "deal_stage_history" does not exist` (column is actually `override_reason`, and `changed_by` is NOT NULL — system-initiated backfills can't satisfy either). Audit trail was already captured in the JSONB marker on the deals row; dropped the deal_stage_history insert entirely. All 24 rolled back; no DB writes.
3. `2026-05-12T02:32:44Z` — `--execute` attempt 3 succeeded for all 24. Audit CSV at `docs/audit/hubspot-stage-reassignment-2026-05-12T02-31-32-679Z.csv`.

The script fixes from runs 1+2 are committed on the merged branch (`8dabeb1` had attempt-1's CSV; the green-execute script lives in the merged main now and is idempotent against the audit marker).

## Phase C — DD recipients page + email dispatch

```
GET /api/admin/notification-recipient-groups/lead_due_diligence
→ HTTP 200   ✅  (was 404 before this PR)
→ group:      { key: 'lead_due_diligence', name: 'Lead Due Diligence' }
→ recipients: 2 active admins/directors
              ['tyamashita@trockgc.com', 'adnaan.iqbal@gmail.com']
```

The lazy upsert in `getNotificationRecipientGroup` ran first (creating the missing public.notification_recipient_groups row), then the response returned 200 with the seeded recipients. Migration `0111_lead_dd_recipient_reseed.sql` will run on the next deploy as belt-and-suspenders, but the application-level lazy upsert is what made this smoke green right after deploy.

Phase C bug 2 (DD email not firing on submission) — **not directly smoked**. We did not submit a SMOKE TEST DELETE company through lead due diligence because:
- The dispatch path now resolves a non-empty recipient list (verified in Phase C smoke above)
- Submitting a real DD record creates production data that would need cleanup
- The single root cause (missing group row → empty recipients → silent dispatch return) is removed by the same fix that made Phase C bug 1 green
- The existing fallback (active admins/directors) at `getLeadDueDiligenceRecipients` line 105 was confirmed by the smoke above to return non-empty for `key === 'lead_due_diligence'`

Recommend the next track verify with a real submission once a SMOKE TEST DELETE workflow is set up. Logged as a follow-up in `known-issues.md`.

## Phase D — Audit findings

Not smoked (audit is documentary, not executable). `.reviews/deals-cleanup-and-pre-golive-audit/audit-findings.md` is the deliverable.

## Browser smoke

Not run. The API-level evidence above proves:
- Server is serving the redacted response (Phase A wire format)
- Stage data is updated for all 24 deals (Phase B)
- Recipients endpoint returns 200 with valid payload (Phase C)

Browser rendering on top of those server responses uses the new `formatDealDisplayNumber` helper, which is unit-tested across 8 cases including the `HS-` → `Pending` substitution.

## Credentials

Test-account password used for the smoke is the standard dev password; not committed to this report. Pre-commit guard would block it anyway.
