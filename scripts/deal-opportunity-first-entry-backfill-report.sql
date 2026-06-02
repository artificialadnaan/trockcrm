-- deal-opportunity-first-entry-backfill-report.sql
--
-- READ-ONLY accounting backfill: the all-time list of CRM-originated deals that entered the
-- Opportunity stage since 2026-05-13, with their deal_number (the operative business "project
-- number"). This RE-POINTS the earlier "project number backfill report" off the old
-- `project_number IS NOT NULL` predicate — which was a no-op-ish filter on an operator-assigned column
-- that is almost never set — and onto the real signal the live notification now uses:
--   CRM-origin (created_by_user_id IS NOT NULL) + entered Opportunity + created since May 13.
--
-- The live trigger's origin guard uses the SAME signal (created_by_user_id), so the one-time report and
-- the ongoing emails describe the same population. source_lead_id is intentionally NOT used as an
-- origin signal (migrations 0026/0027 synthesize it onto imported deals). `deal_number` is the
-- operative number (it is
-- NOT NULL + UNIQUE on every deal); `project_number` is surfaced only as an optional legacy display
-- column. Run per CRM tenant schema (office_dallas + office_atlanta are the live tenants;
-- office_pwauditoffice is non-prod and is intentionally excluded).
--
-- Adnaan runs this against production; nothing here writes.

-- Single-tenant form (swap office_dallas -> office_atlanta to run the other tenant):
WITH opportunity_stage AS (
  SELECT id FROM public.pipeline_stage_config WHERE slug = 'opportunity'
)
SELECT
  d.deal_number                          AS project_number,        -- operative "project number"
  d.name                                 AS deal_name,
  d.created_at                           AS created_at,
  CASE
    -- Lead conversions set BOTH created_by_user_id and source_lead_id, so check source_lead_id FIRST.
    WHEN d.source_lead_id     IS NOT NULL THEN 'lead_conversion'
    ELSE 'service_or_direct'
  END                                    AS crm_origin_route,
  d.project_number                       AS legacy_project_number  -- optional display only (usually NULL)
FROM office_dallas.deals d
WHERE
  -- May-13 cutoff on the CREATED date (per spec), anchored to America/Chicago (created_at is
  -- timestamptz; a bare DATE would be 5h early). NOTE: for the dominant cohort (born-in-Opportunity)
  -- created_at == the Opportunity-entry date. If accounting instead wants "ENTERED Opportunity since
  -- May 13" (incl. older deals first moved into Opportunity after the cutoff), key the cutoff on the
  -- deal_stage_history entry timestamp instead — see the ENTRY-DATE variant at the bottom.
  d.created_at >= (DATE '2026-05-13' AT TIME ZONE 'America/Chicago')
  -- CRM-genuine origin — matches the live trigger (migration 0147): require created_by_user_id, the
  -- positive "an app user created this" signal. source_lead_id is deliberately NOT accepted: migrations
  -- 0026/0027 synthesize it onto imported/legacy deals (and the 2026-05-14 HubSpot reimport gives some
  -- a created_at >= the cutoff), so it would admit non-CRM rows. Trade-off: pre-0128 genuine conversions
  -- (created < 2026-05-19, NULL created_by_user_id) are excluded — a small bounded gap to supplement
  -- manually if accounting needs it.
  AND d.created_by_user_id IS NOT NULL
  -- Was EVER in the Opportunity stage: currently in it, moved INTO it (to_stage_id), or moved OUT of it
  -- (from_stage_id). Checking from_stage_id matters for CRM deals born in Opportunity BEFORE the 0143
  -- stage-history backstop shipped (creation recorded no history row) that have SINCE advanced: their
  -- move out of Opportunity recorded from_stage_id=opportunity via changeDealStage's explicit insert,
  -- so they are still captured. (Residual gap: a born-in-Opportunity deal whose only stage move bypassed
  -- app recording — negligible for CRM-genuine / created_by deals, whose moves go through changeDealStage.)
  AND (
    d.stage_id = (SELECT id FROM opportunity_stage)
    OR EXISTS (
      SELECT 1
      FROM office_dallas.deal_stage_history h
      WHERE h.deal_id = d.id
        AND (SELECT id FROM opportunity_stage) IN (h.to_stage_id, h.from_stage_id)
    )
  )
ORDER BY d.created_at;

-- Cross-tenant form (one result set over both live CRM offices). The opportunity stage id is global
-- (public.pipeline_stage_config.slug is unique), so it resolves once and applies to every tenant.
--
-- WITH opportunity_stage AS (
--   SELECT id FROM public.pipeline_stage_config WHERE slug = 'opportunity'
-- )
-- SELECT 'office_dallas' AS tenant_schema, d.deal_number AS project_number, d.name AS deal_name,
--        d.created_at,
--        CASE WHEN d.source_lead_id IS NOT NULL THEN 'lead_conversion' ELSE 'service_or_direct' END AS crm_origin_route,
--        d.project_number AS legacy_project_number
--   FROM office_dallas.deals d
--  WHERE d.created_at >= (DATE '2026-05-13' AT TIME ZONE 'America/Chicago')
--    AND d.created_by_user_id IS NOT NULL
--    AND (d.stage_id = (SELECT id FROM opportunity_stage)
--         OR EXISTS (SELECT 1 FROM office_dallas.deal_stage_history h
--                     WHERE h.deal_id = d.id AND (SELECT id FROM opportunity_stage) IN (h.to_stage_id, h.from_stage_id)))
-- UNION ALL
-- SELECT 'office_atlanta' AS tenant_schema, d.deal_number, d.name, d.created_at,
--        CASE WHEN d.source_lead_id IS NOT NULL THEN 'lead_conversion' ELSE 'service_or_direct' END,
--        d.project_number
--   FROM office_atlanta.deals d
--  WHERE d.created_at >= (DATE '2026-05-13' AT TIME ZONE 'America/Chicago')
--    AND d.created_by_user_id IS NOT NULL
--    AND (d.stage_id = (SELECT id FROM opportunity_stage)
--         OR EXISTS (SELECT 1 FROM office_atlanta.deal_stage_history h
--                     WHERE h.deal_id = d.id AND (SELECT id FROM opportunity_stage) IN (h.to_stage_id, h.from_stage_id)))
-- ORDER BY created_at;
--
-- ENTRY-DATE variant (Codex F2): if accounting wants "ENTERED Opportunity since May 13" rather than
-- "CREATED since May 13" — i.e. also include deals created earlier but first moved into Opportunity
-- after the cutoff — replace the created_at predicate above with a first-Opportunity-entry timestamp:
--   AND COALESCE(
--         (SELECT MIN(h.created_at) FROM office_dallas.deal_stage_history h
--           WHERE h.deal_id = d.id AND h.to_stage_id = (SELECT id FROM opportunity_stage)),
--         d.created_at  -- born in Opportunity: no stage-history "entry" row, so use created_at
--       ) >= (DATE '2026-05-13' AT TIME ZONE 'America/Chicago')
-- (Left as a documented option; the default keys on created_at per the agreed spec.)
