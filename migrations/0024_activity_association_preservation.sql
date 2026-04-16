-- Migration 0024: Preserve full HubSpot activity associations for migration review

ALTER TABLE migration.staged_activities
  ADD COLUMN IF NOT EXISTS hubspot_deal_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS hubspot_contact_ids jsonb NOT NULL DEFAULT '[]'::jsonb;

UPDATE migration.staged_activities
SET
  hubspot_deal_ids = COALESCE(
    (
      SELECT jsonb_agg(deal_assoc->>'id')
      FROM jsonb_array_elements(COALESCE(raw_data->'associations'->'deals'->'results', '[]'::jsonb)) AS deal_assoc
    ),
    '[]'::jsonb
  ),
  hubspot_contact_ids = COALESCE(
    (
      SELECT jsonb_agg(contact_assoc->>'id')
      FROM jsonb_array_elements(COALESCE(raw_data->'associations'->'contacts'->'results', '[]'::jsonb)) AS contact_assoc
    ),
    '[]'::jsonb
  )
WHERE raw_data ? 'associations';
