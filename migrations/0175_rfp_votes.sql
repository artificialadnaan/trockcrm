-- Migration 0175: rfp_votes (CRM-owned RFP approval voting for non-service deals)
--
-- One row per voter per RFP vote round. A "round" is scoped by round_event_id (=
-- deals.rfp_approval_request_event_id at trigger time) so a cancel/re-trigger starts a fresh tally
-- and old rows never leak into a new round. 2-of-3 majority decides (see shared/src/lib/rfpVoteState.ts).
-- decision is plain text ('approve' | 'reject') per the no-enum RFP-state convention (migration 0151).
-- Per-office tenant table, mirroring migration 0153 (deal_change_orders): an office_% DO-loop for
-- existing tenants + a -- TENANT_SCHEMA_START/END block the office provisioner clones (office_dallas
-- -> new schema).

-- Existing tenants: create the table + index in every office_* schema.
DO $tenant$
DECLARE
  schema_name text;
BEGIN
  FOR schema_name IN
    SELECT nspname
    FROM pg_namespace
    WHERE nspname LIKE 'office\_%' ESCAPE '\'
    ORDER BY nspname
  LOOP
    -- Skip a partially-provisioned office schema that has no deals table yet: the REFERENCES clause below would
    -- otherwise raise and abort the whole migration (and every other tenant) for one incomplete schema.
    IF to_regclass(format('%I.deals', schema_name)) IS NULL THEN
      CONTINUE;
    END IF;

    EXECUTE format(
      $sql$
        CREATE TABLE IF NOT EXISTS %1$I.rfp_votes (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          deal_id UUID NOT NULL REFERENCES %1$I.deals(id) ON DELETE CASCADE,
          round_event_id UUID NOT NULL,
          voter_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
          voter_email TEXT NOT NULL,
          decision TEXT NOT NULL,
          reason TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CONSTRAINT rfp_votes_deal_round_voter_uq UNIQUE (deal_id, round_event_id, voter_user_id)
        );

        CREATE INDEX IF NOT EXISTS rfp_votes_deal_round_idx
          ON %1$I.rfp_votes (deal_id, round_event_id);
      $sql$,
      schema_name
    );
  END LOOP;
END $tenant$;

-- New tenants: the office provisioner clones this marked block (office_dallas -> new schema).
-- TENANT_SCHEMA_START
CREATE TABLE IF NOT EXISTS office_dallas.rfp_votes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id UUID NOT NULL REFERENCES office_dallas.deals(id) ON DELETE CASCADE,
  round_event_id UUID NOT NULL,
  voter_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
  voter_email TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT rfp_votes_deal_round_voter_uq UNIQUE (deal_id, round_event_id, voter_user_id)
);

CREATE INDEX IF NOT EXISTS rfp_votes_deal_round_idx
  ON office_dallas.rfp_votes (deal_id, round_event_id);
-- TENANT_SCHEMA_END
