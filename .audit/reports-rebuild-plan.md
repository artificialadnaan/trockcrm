# Reports Rebuild -- BUILD PLAN (draft)

Status: PLAN IN PROGRESS. Part 1 (input-side, projection hygiene) is SCOPED -- decisions locked,
independent of the reporting samples. Part 2 (Report A/B build) is PENDING the reporting samples +
final-plan review. BUILD NOTHING until explicit go. Companion: reports-rebuild-discovery.md (findings),
reports-rebuild-workflow-map.md (full per-endpoint map).

LOCKED DECISIONS (product owner, 2026-05-30):
  - DEPARTMENT = functional pipeline NOW (estimating->sent->won->collected); architect for a
    geographic office/region cut LATER.
  - COLLECTED = DEFERRED; render as a clearly-marked placeholder (never zero-filled), wire later.
  - PROJECTION = read deals.expected_close_date ALONE (no COALESCE fallback) + full input-side fix.
  - CANONICAL SOURCES (non-negotiable): WON -> getWonCloseSummary / getCanonicalRepWonSummary via
    aliasedWonHsClosedWonDateSql (NEVER re-derive; ties to 191/$9,778,045.90). SENT/ESTIMATED ->
    deal_stage_history.created_at transitions. PROJECTED -> expected_close_date alone.
    "This week" = Sunday-Saturday WTD (#539, toDatePresetRange("wtd")).

================================================================================
## PART 1 -- INPUT-SIDE FIX (expected_close_date hygiene)  [decided; scope ready]

WHY: prod shows 73.7% of open deals carry expected_close_date but 94% are past-dated; only 4.7% are
future-dated -> reading the field today yields a ~14-deal projection (hollow). Root cause: optional/
buried field, conversion + stage-change never set it, HubSpot import is the only writer and can
overwrite rep edits. Fixes #1-#3 make it rep-maintained; #4 keeps the report honest meanwhile.

### #1 Require expected_close_date on stage ADVANCE (stage-gate)  [lowest effort]
- Mechanism EXISTS: pipeline_stage_config.required_fields (JSONB) + stage-gate check
  (server/src/modules/deals/stage-gate.ts:299-306) + registered label (:74). expected_close_date is
  already a recognized gate field.
- Config is RUNTIME-editable (admin): server/src/modules/admin/pipeline-service.ts:116-120 +
  client/src/pages/admin/pipeline-config-page.tsx -> requiredFields per stage.
- ACTION: add "expected_close_date" to the requiredFields of the chosen advance stage(s) (recommend
  the estimating-entry stage so every deal that reaches forecasting carries a live date). Deliver via
  a SEED/migration (so it is enforced in every environment, not just whoever clicks the admin UI),
  and confirm the admin default includes it.
- LEVERAGE: the stage-advance flow already calls POST /deals/:id/stage/preflight (stage-gate) before
  the move; once expected_close_date is a required field, preflight returns it as missing and the
  existing required-field prompt should collect it -- so #1 delivers much of #2's UX. VERIFY at build
  time that the deal stage-advance UI (pipeline-page.tsx + deal-detail) surfaces the preflight
  required-field prompt and lets the rep enter the date inline (it already does for other required
  fields). If it does, #2 shrinks to "ensure the date input is in that prompt."

### #2 Prompt/update on STAGE-CHANGE (the maintenance moment)
- TODAY: changeDealStage ignores expected_close_date entirely (stage-change.ts; StageChangeInput
  :87-98 has no such field). The stage move API is POST /deals/:id/stage (client hook use-deals.ts:590).
- ACTION (only the part #1's preflight prompt does NOT cover): add expectedCloseDate to
  StageChangeInput (stage-change.ts:87) and persist it in the dealUpdates build (so a rep advancing a
  deal can set/refresh the date in the same action), and add the date input to the stage-advance
  dialog. Keep it REQUIRED only where #1 gates it; elsewhere optional-but-offered.
- TEST: stage-advance into the gated stage with a blank date is blocked (preflight) and the prompt
  sets the date; a non-gated move offers but does not require it.

### #3 HubSpot sync = NULL-ONLY fill (protect rep edits)
- TODAY: scripts/refresh-from-hubspot.ts:326-335 proposes an expected_close_date change whenever CRM
  != HubSpot closedate -> a real run (DRY_RUN=false) overwrites a rep's hand-entered date.
- ACTION: change the guard so it only fills expected_close_date when the CRM value IS NULL (or add a
  "manually edited" guard). One-line predicate change at :326. Leave other fields' behavior untouched.
- TEST: deal with a rep-entered date + a different HubSpot closedate -> no change proposed; deal with
  NULL date + HubSpot closedate -> fill proposed.

### #4 Projection presents a DATA-QUALITY CAVEAT (until populated)
- Report B's "going-to-close 30/60/90" must show coverage, e.g. "N of M open deals have a maintained
  expected close date" (and/or surface the count of stale/past-dated), never a bare number that looks
  broken. Same philosophy as the deferred Collected placeholder. This lives in Report B's spec (Part 2)
  but is locked here so the projection is honest from day one.

SEQUENCING: #1 (config/seed) + #3 (one-liner) are quick and unblock honest data; #2 is the UI change;
#4 is part of Report B. #1+#3 can land before the reports; #2 alongside. All gated on explicit go.

================================================================================
## PART 2 -- REPORT A (weekly per-department) + REPORT B (per-rep)  [PENDING samples + go]

Framing locked (fill in once the reporting samples arrive and are mapped metric->canonical source):

REPORT A -- weekly per-department (functional), Sun-Sat WTD:
  - "This week" est/sent/won = deal_stage_history transitions (to_stage_id slug in the estimating /
    estimate_sent_to_client / won stage sets) where created_at is within the #539 WTD window
    (toDatePresetRange("wtd")); valued by the platform value precedence; grouped by functional stage
    (department). WON column reconciled to getWonCloseSummary (do not re-derive). Collected =
    placeholder (deferred). Architect the GROUP BY so a geographic (office_code/region) cut can be
    added without reworking the query.

REPORT B -- per-rep (Monday meeting):
  - CLOSED = getCanonicalRepWonSummary(rep) (won_closed_date triad; ties to the dashboard).
  - SENT-per-rep = sent-stage source sliced by assigned_rep_id (the same source the rep already sees).
  - LEAD-STATUS = lead pipeline by stage for the rep's leads.
  - GOING-TO-CLOSE 30/60/90 = open deals by expected_close_date alone (no COALESCE), with the #4
    coverage caveat.

CANONICAL-SOURCE GUARDRAILS for both: every metric calls the existing platform seam; no report-local
date logic. Reconcile WON to the dashboard card during build (tie-out to 191/$9,778,045.90 scope).

NEXT (when samples land): map each sample metric -> canonical source (flag any divergence vs Section 2
of the discovery doc), finalize A/B queries + UI, then deliver this plan for review. Build only on go.

================================================================================
## GREY COORDINATION (relay)
buildDealOutcomeDateScope is not yet a symbol in code. We will build on the existing per-metric seams
(WON -> aliasedWonHsClosedWonDateSql via getWonCloseSummary/getCanonicalRepWonSummary; SENT/ESTIMATED
-> deal_stage_history.created_at; PROJECTED -> expected_close_date). When GREY's buildDealOutcomeDateScope
lands, WON MUST delegate to won_closed_date (not redefine it); the reports then swap to it via a 1-line
change at the date-scope call site. Ask GREY to confirm the WON column contract so the swap is clean.
