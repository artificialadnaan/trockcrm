ALTER TABLE public.deals
  ADD COLUMN IF NOT EXISTS bid_board_stage_family varchar(50);
