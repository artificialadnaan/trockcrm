DO $$
DECLARE
  office_schema text;
BEGIN
  FOR office_schema IN
    SELECT schemata.schema_name
    FROM information_schema.schemata AS schemata
    WHERE schemata.schema_name LIKE 'office_%'
  LOOP
    IF EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = office_schema
        AND table_name = 'deals'
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I.deals ADD COLUMN IF NOT EXISTS bid_board_stage_family varchar(50)',
        office_schema
      );
    END IF;
  END LOOP;
END $$;
