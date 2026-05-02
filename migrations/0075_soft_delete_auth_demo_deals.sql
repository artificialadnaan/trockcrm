-- Migration 0075: Soft-delete auth demo deals seeded by dev-login bootstrap.
--
-- These four deterministic TR-DEMO-* rows were created by
-- ensureDevDemoWorkspace in the auth dev-login flow. They are no longer useful
-- in production and three remained active on legacy stage slugs after the Bid
-- Board stage-v2 migration. Keep the rows for audit/history but hide them from
-- active pipeline/reporting surfaces via the existing soft-delete convention.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.schemata
    WHERE schema_name = 'office_dallas'
  )
  AND EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'office_dallas'
      AND table_name = 'deals'
  ) THEN
    UPDATE office_dallas.deals
    SET is_active = false
    WHERE id IN (
      'aaf50815-4547-2bd3-e46e-c4973c48d3ef'::uuid, -- TR-DEMO-004 Birchstone East Annex Coating Bid
      '0322c2ad-71f6-aefd-6cbe-a9a9f06310a2'::uuid, -- TR-DEMO-003 Birchstone Interior Water Damage Repair
      '0ba739f4-76de-c3ae-1cf6-e13eb266113c'::uuid, -- TR-DEMO-001 Birchstone North Tower Reroof
      '3981af26-1fe8-1ed9-99a2-6af779974552'::uuid  -- TR-DEMO-002 Birchstone Parking Garage Waterproofing
    )
      AND COALESCE(is_active, true) = true;
  END IF;
END $$;
