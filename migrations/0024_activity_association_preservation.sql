-- Migration 0024: Preserve full HubSpot activity associations for migration review

CREATE SCHEMA IF NOT EXISTS migration;

CREATE TABLE IF NOT EXISTS migration.staged_activities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  office_id uuid,
  import_run_id uuid,
  hubspot_activity_id varchar(100) UNIQUE NOT NULL,
  hubspot_deal_id varchar(100),
  hubspot_contact_id varchar(100),
  raw_data jsonb NOT NULL,
  mapped_type varchar(50),
  mapped_subject text,
  mapped_body text,
  mapped_occurred_at timestamptz,
  validation_status varchar(50) NOT NULL DEFAULT 'pending',
  validation_errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  promoted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS staged_activities_office_id_idx
  ON migration.staged_activities (office_id);

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
