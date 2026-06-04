-- Second-look RFP override-review state.
--
-- After an RFP is declined (first go/no-go round), the designated reviewers (Takashi + Adam Shaw) get final
-- say on a dedicated review page: they either APPROVE the override (which re-submits the RFP to SyncHub for a
-- fresh approval cycle) or RE-CONFIRM the denial. These columns record that second-look outcome on the deal so
-- a reviewed decline is not perpetually re-flagged. The RFP lifecycle column (rfp_approval_status) is untouched
-- by this migration: a re-confirmed denial stays 'declined', and an approved override is handled by application
-- code resetting the RFP fields back to 'pending_outbox'.
--
-- Additive and idempotent across existing tenant schemas and reusable for future tenant schema provisioning.

DO $$
DECLARE
  tenant_schema text;
BEGIN
  FOR tenant_schema IN
    SELECT nspname
      FROM pg_namespace
     WHERE nspname LIKE 'office\_%' ESCAPE '\'
     ORDER BY nspname
  LOOP
    IF to_regclass(format('%I.deals', tenant_schema)) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE %I.deals ADD COLUMN IF NOT EXISTS rfp_override_reviewed_at timestamptz', tenant_schema);
      EXECUTE format('ALTER TABLE %I.deals ADD COLUMN IF NOT EXISTS rfp_override_reviewed_by uuid', tenant_schema);
      -- rfp_override_decision: NULL (not yet second-look-reviewed) | 'denial_reconfirmed'. Plain text to match
      -- the existing rfp_approval_status column convention (no enum/check constraint on RFP state columns).
      EXECUTE format('ALTER TABLE %I.deals ADD COLUMN IF NOT EXISTS rfp_override_decision text', tenant_schema);
      EXECUTE format('ALTER TABLE %I.deals ADD COLUMN IF NOT EXISTS rfp_override_note text', tenant_schema);
    END IF;
  END LOOP;
END $$;

-- TENANT_SCHEMA_START
DO $tenant$
BEGIN
  IF to_regclass('deals') IS NULL THEN
    RETURN;
  END IF;

  ALTER TABLE deals ADD COLUMN IF NOT EXISTS rfp_override_reviewed_at timestamptz;
  ALTER TABLE deals ADD COLUMN IF NOT EXISTS rfp_override_reviewed_by uuid;
  ALTER TABLE deals ADD COLUMN IF NOT EXISTS rfp_override_decision text;
  ALTER TABLE deals ADD COLUMN IF NOT EXISTS rfp_override_note text;
END
$tenant$;
-- TENANT_SCHEMA_END
