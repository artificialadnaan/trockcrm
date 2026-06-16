-- Session-invalidation epoch: any JWT issued before this instant is rejected in middleware.
-- NULL => no epoch (all existing tokens remain valid). Set on deactivate and on role change.
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS tokens_valid_after timestamptz;
