-- Require expected_close_date when a deal advances into the Estimating boundary -- the last
-- APP-AUTHORED stage gate before Bid Board owns the deal downstream. Gating HERE (not at
-- Proposal-Sent) maximizes coverage: CRM-originated deals reliably pass through Estimating via
-- changeDealStage (where validateStageGate fires), and the captured date then persists forward as the
-- deal mirrors through the downstream Bid Board-owned stages, so the going-to-close (30/60/90)
-- projection covers the funnel from Estimating onward.
--
-- SLUGS: the ACTIVE standard-route Estimating stage is "estimating" (migration 0064 introduced the
-- Bid Board v2 stages and made the legacy "estimate_in_progress" inactive / unreachable). The service
-- route's active Estimating stage is "service_estimating". The stage gate treats both "estimating" and
-- "estimate_in_progress" as the normal estimating boundary, but only "estimating" is reachable -- so we
-- gate the two ACTIVE boundary slugs: estimating + service_estimating.
--
-- NOTE on the Bid Board mirror: Proposal-Sent and the downstream stages are predominantly entered by
-- the SyncHub / Bid Board MIRROR, which writes deals.stage_id directly and EXPLICITLY bypasses the
-- stage gate; the mirror never carries an expected_close_date. Mirror-originated deals are handled by
-- the projection's "N of M maintained" coverage caveat, not by this app gate.
--
-- pipeline_stage_config is the shared (public) stage config; the stage gate
-- (server/src/modules/deals/stage-gate.ts) treats every entry in required_fields as a camelCase deal
-- field key, so we append "expectedCloseDate". Additive + idempotent: the @> guard prevents a
-- duplicate on re-run, and || APPENDS to (never replaces) any existing required_fields. Admin-tunable
-- via the pipeline-config UI. Reps without it are blocked from advancing into Estimating (the
-- stage-change dialog links to the deal overview to set it until the inline prompt ships); directors
-- can override.
--
-- NOTE: this requires the field to be PRESENT. A follow-up PR (the inline stage-change prompt) adds
-- the "must be a usable / non-past date" enforcement so a stale past date cannot satisfy the gate.
UPDATE public.pipeline_stage_config
SET required_fields = required_fields || '["expectedCloseDate"]'::jsonb
WHERE slug IN ('estimating', 'service_estimating')
  AND NOT (required_fields @> '["expectedCloseDate"]'::jsonb);
