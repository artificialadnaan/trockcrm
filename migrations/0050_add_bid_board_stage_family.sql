DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'deals'
  ) THEN
    ALTER TABLE public.deals
      ADD COLUMN IF NOT EXISTS bid_board_stage_family varchar(50);
  END IF;
END $$;
